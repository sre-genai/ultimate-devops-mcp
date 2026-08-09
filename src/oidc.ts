import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type { KeyIdentity } from "./audit.js";
import type { OidcConfig } from "./config.js";
import { logger } from "./logger.js";

/**
 * Map validated JWT claims to a KeyIdentity (the same scope object static keys
 * produce, so governance + audit treat OIDC callers identically).
 * - name: the configured name claim (e.g. email), falling back to `sub`.
 * - allowWrites: true only if the user is in one of the configured admin groups.
 * - tools: when a group→tools map is configured, the union of the tool lists for
 *   the user's groups (an unmapped, non-admin user gets an empty allowlist —
 *   deny-all — rather than silent full access).
 */
export function mapClaimsToIdentity(claims: JWTPayload, cfg: OidcConfig): KeyIdentity {
  const nameVal = claims[cfg.nameClaim];
  const name =
    typeof nameVal === "string" && nameVal
      ? nameVal
      : typeof claims.sub === "string" && claims.sub
        ? claims.sub
        : "oidc-user";

  const rawGroups = claims[cfg.groupsClaim];
  const groups = Array.isArray(rawGroups)
    ? rawGroups.map(String)
    : typeof rawGroups === "string"
      ? rawGroups.split(/[\s,]+/).filter(Boolean)
      : [];

  const allowWrites = cfg.adminGroups.length > 0 && groups.some((g) => cfg.adminGroups.includes(g));

  let tools: string[] | undefined;
  if (cfg.groupTools) {
    const set = new Set<string>();
    for (const g of groups) for (const t of cfg.groupTools[g] ?? []) set.add(t);
    tools = [...set];
  }

  return { name, tools, allowWrites };
}

/**
 * Build a verifier that validates an IdP-issued bearer JWT against the issuer's
 * JWKS (signature, issuer, audience, expiry, algorithm allowlist) and returns a
 * KeyIdentity, or undefined if the token is invalid. Signature verification and
 * JWKS caching/rotation are delegated to `jose` — never hand-rolled.
 *
 * The JWKS URI is taken from config, else discovered from the issuer's
 * /.well-known/openid-configuration on first use (cached; re-attempted on error).
 */
export function createOidcVerifier(cfg: OidcConfig): (token: string) => Promise<KeyIdentity | undefined> {
  let jwks: JWTVerifyGetKey | undefined;
  let discovering: Promise<JWTVerifyGetKey> | undefined;

  async function getJwks(): Promise<JWTVerifyGetKey> {
    if (jwks) return jwks;
    if (!discovering) {
      discovering = (async () => {
        let uri = cfg.jwksUri;
        if (!uri) {
          const res = await fetch(`${cfg.issuer}/.well-known/openid-configuration`, {
            signal: AbortSignal.timeout(10_000),
          });
          if (!res.ok) throw new Error(`OIDC discovery failed: HTTP ${res.status} from ${cfg.issuer}`);
          const meta = (await res.json()) as { jwks_uri?: string };
          if (!meta.jwks_uri) throw new Error("OIDC discovery document has no jwks_uri");
          uri = meta.jwks_uri;
        }
        const set = createRemoteJWKSet(new URL(uri));
        jwks = set;
        return set;
      })().catch((err) => {
        discovering = undefined; // allow a later retry
        throw err;
      });
    }
    return discovering;
  }

  return async (token: string): Promise<KeyIdentity | undefined> => {
    try {
      const keySet = await getJwks();
      const { payload } = await jwtVerify(token, keySet, {
        issuer: cfg.issuer,
        audience: cfg.audience,
        algorithms: cfg.allowedAlgs,
      });
      return mapClaimsToIdentity(payload, cfg);
    } catch (err) {
      // Any failure (bad signature, wrong issuer/aud, expired, discovery down)
      // means "not authenticated" — logged at debug, never surfaced to the caller.
      logger.debug({ err: err instanceof Error ? err.message : String(err) }, "OIDC token rejected");
      return undefined;
    }
  };
}
