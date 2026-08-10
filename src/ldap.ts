import { Client } from "ldapts";
import { logger } from "./logger.js";
import type { LdapConfig } from "./config.js";

export interface LdapUser {
  sub: string;
  name: string;
  groups: string[];
}

// Escape the RFC 4515 filter metacharacters ( \ * ( ) NUL ) in the untrusted
// username so it can't alter the search filter (LDAP injection).
const FILTER_SPECIAL = new Set(["\\", "*", "(", ")", "\0"]);
function escapeFilter(value: string): string {
  let out = "";
  for (const ch of value) {
    out += FILTER_SPECIAL.has(ch) ? `\\${ch.charCodeAt(0).toString(16).padStart(2, "0")}` : ch;
  }
  return out;
}

function toStrings(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.map((x) => (Buffer.isBuffer(x) ? x.toString("utf8") : String(x)));
}

// LDAP attribute names are case-insensitive; different servers return different
// casing (e.g. AD "memberOf" vs a server that lowercases to "memberof"), so look
// the attribute up without regard to case.
function getAttr(entry: Record<string, unknown>, name: string): unknown {
  const lower = name.toLowerCase();
  for (const key of Object.keys(entry)) {
    if (key.toLowerCase() === lower) return entry[key];
  }
  return undefined;
}

/**
 * Build an authenticator that validates a username/password against an LDAP
 * directory using the standard search-then-bind pattern:
 *   1. bind as the service account (if configured) and search for the user's DN,
 *      reading their display name + group memberships;
 *   2. bind as that DN with the supplied password to verify the credentials.
 * Returns the mapped user, or undefined for any failure (bad password, no/many
 * matches, directory unreachable). Never throws for auth failures.
 */
export function createLdapAuthenticator(
  cfg: LdapConfig,
): (username: string, password: string) => Promise<LdapUser | undefined> {
  // Only hand ldapts TLS options for ldaps:// — passing tlsOptions on a plain
  // ldap:// connection makes it attempt a TLS handshake against a cleartext port.
  const isTls = cfg.url.toLowerCase().startsWith("ldaps://");
  const clientOpts = {
    url: cfg.url,
    timeout: 8000,
    connectTimeout: 8000,
    ...(isTls ? { tlsOptions: { rejectUnauthorized: cfg.tlsRejectUnauthorized } } : {}),
  };

  return async (username, password) => {
    if (!username || !password) return undefined;

    // 1) Resolve the user's DN + attributes.
    const search = new Client(clientOpts);
    let userDn: string;
    let name = username;
    let groups: string[] = [];
    try {
      if (cfg.bindDN) await search.bind(cfg.bindDN, cfg.bindPassword ?? "");
      const filter = cfg.searchFilter.replace(/\{\{\s*username\s*\}\}/g, escapeFilter(username));
      // Fetch the full (single) user entry rather than a fixed attribute list —
      // more robust across directories (attribute casing, operational attrs like
      // memberOf that some servers omit unless all attributes are requested).
      const { searchEntries } = await search.search(cfg.searchBase, {
        scope: "sub",
        filter,
        sizeLimit: 2,
      });
      if (searchEntries.length !== 1) {
        logger.debug({ matches: searchEntries.length }, "ldap: user search did not match exactly one entry");
        return undefined;
      }
      const entry = searchEntries[0] as unknown as Record<string, unknown>;
      userDn = String(entry.dn);
      const nm = toStrings(getAttr(entry, cfg.nameAttribute));
      if (nm[0]) name = nm[0];
      groups = toStrings(getAttr(entry, cfg.groupsAttribute));
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "ldap: search failed");
      return undefined;
    } finally {
      await search.unbind().catch(() => {});
    }

    // 2) Verify the password by binding as the resolved DN.
    const verify = new Client(clientOpts);
    try {
      await verify.bind(userDn, password);
    } catch {
      return undefined; // invalid credentials
    } finally {
      await verify.unbind().catch(() => {});
    }

    return { sub: userDn, name, groups };
  };
}
