import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import express, { type Request, type Response, type Router } from "express";
import { SignJWT, jwtVerify, createRemoteJWKSet, type JWTPayload } from "jose";
import { logger } from "./logger.js";
import type { KeyStore, ApiKeyRecord } from "./keystore.js";

// ---------------------------------------------------------------------------
// Self-service key console
//
// A human logs in via OIDC (Authorization Code + PKCE) and mints/revokes their
// own scoped API keys. State lives entirely in signed cookies — there is no
// server-side session store:
//   * a short-lived "flow" cookie carries the OAuth state + PKCE verifier
//     between /login and /callback;
//   * an ~8h "session" cookie carries { sub, name, groups, csrf } after login.
// Both are jose HS256 JWTs signed with the caller-supplied sessionSecret.
//
// Write-capable keys may only be minted by members of adminGroups; the checkbox
// on the form is a hint only — the server re-derives admin membership from the
// session's groups claim on every POST and never trusts the form field alone.
// The one-time plaintext secret is rendered exactly once and never logged.
// ---------------------------------------------------------------------------

export function createConsoleRouter(opts: {
  store: KeyStore;
  login: { issuer: string; clientId: string; clientSecret: string; redirectUri: string; scopes?: string };
  sessionSecret: string;
  adminGroups?: string[];
  groupsClaim?: string;
  nameClaim?: string;
  basePath?: string;
}): Router {
  const basePath = normalizeBasePath(opts.basePath ?? "/console");
  const adminGroups = opts.adminGroups ?? [];
  const groupsClaim = opts.groupsClaim ?? "groups";
  const nameClaim = opts.nameClaim ?? "email";
  const scope = opts.login.scopes ?? "openid email profile";
  const secretKey = new TextEncoder().encode(opts.sessionSecret);

  // Cookie names + lifetimes. Cookies are scoped to basePath so they never leak
  // to the rest of the app; both are httpOnly + Secure + SameSite=Lax (Lax is
  // required so the top-level redirect back from the IdP carries the flow cookie).
  const FLOW_COOKIE = "udm_console_flow";
  const SESSION_COOKIE = "udm_console_session";
  const FLOW_TTL_SEC = 600; // 10 min — long enough to complete the IdP round-trip
  const SESSION_TTL_SEC = 8 * 60 * 60; // 8h

  const router = express.Router();
  // Parse HTML form posts. Built into express — no extra dependency.
  router.use(express.urlencoded({ extended: false }));

  // --- OIDC discovery (cached; retried on failure) -------------------------
  interface Endpoints {
    authorizationEndpoint: string;
    tokenEndpoint: string;
    jwksUri: string;
  }
  let endpoints: Endpoints | undefined;
  let discovering: Promise<Endpoints> | undefined;
  async function discover(): Promise<Endpoints> {
    if (endpoints) return endpoints;
    if (!discovering) {
      discovering = (async () => {
        const res = await fetch(`${opts.login.issuer}/.well-known/openid-configuration`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`OIDC discovery failed: HTTP ${res.status}`);
        const meta = (await res.json()) as {
          authorization_endpoint?: string;
          token_endpoint?: string;
          jwks_uri?: string;
        };
        if (!meta.authorization_endpoint || !meta.token_endpoint || !meta.jwks_uri) {
          throw new Error("OIDC discovery document missing authorization/token/jwks endpoint");
        }
        endpoints = {
          authorizationEndpoint: meta.authorization_endpoint,
          tokenEndpoint: meta.token_endpoint,
          jwksUri: meta.jwks_uri,
        };
        return endpoints;
      })().catch((err) => {
        discovering = undefined; // allow a later retry
        throw err;
      });
    }
    return discovering;
  }

  // JWKS for verifying the IdP's id_token signature (cached; jose handles key rotation).
  let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
  async function getJwks(): Promise<ReturnType<typeof createRemoteJWKSet>> {
    if (!jwks) jwks = createRemoteJWKSet(new URL((await discover()).jwksUri));
    return jwks;
  }

  // --- Cookie helpers ------------------------------------------------------
  function setCookie(res: Response, name: string, value: string, maxAgeSec: number): void {
    const parts = [
      `${name}=${value}`,
      `Path=${basePath}`,
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
      `Max-Age=${maxAgeSec}`,
    ];
    res.append("Set-Cookie", parts.join("; "));
  }
  function clearCookie(res: Response, name: string): void {
    res.append(
      "Set-Cookie",
      `${name}=; Path=${basePath}; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    );
  }

  // --- Signed-token helpers ------------------------------------------------
  async function signToken(payload: Record<string, unknown>, ttlSec: number): Promise<string> {
    return new SignJWT(payload)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(`${ttlSec}s`)
      .sign(secretKey);
  }
  async function verifyToken(token: string): Promise<Record<string, unknown> | undefined> {
    try {
      const { payload } = await jwtVerify(token, secretKey, { algorithms: ["HS256"] });
      return payload as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  interface Session {
    sub: string;
    name: string;
    groups: string[];
    csrf: string;
  }
  async function readSession(req: Request): Promise<Session | undefined> {
    const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!raw) return undefined;
    const payload = await verifyToken(raw);
    if (!payload) return undefined;
    const sub = typeof payload.sub === "string" ? payload.sub : "";
    const name = typeof payload.name === "string" ? payload.name : sub;
    const groups = Array.isArray(payload.groups) ? payload.groups.map(String) : [];
    const csrf = typeof payload.csrf === "string" ? payload.csrf : "";
    if (!sub || !csrf) return undefined;
    return { sub, name, groups, csrf };
  }

  const isAdmin = (groups: string[]): boolean =>
    adminGroups.length > 0 && groups.some((g) => adminGroups.includes(g));

  // --- Routes --------------------------------------------------------------

  // GET /login — start the Authorization Code + PKCE flow.
  router.get("/login", async (_req: Request, res: Response) => {
    try {
      const { authorizationEndpoint } = await discover();
      const state = randomBytes(16).toString("base64url");
      const codeVerifier = randomBytes(32).toString("base64url");
      const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");

      // Stash state + verifier in a short-lived signed cookie (no server store).
      const flow = await signToken({ state, cv: codeVerifier }, FLOW_TTL_SEC);
      setCookie(res, FLOW_COOKIE, flow, FLOW_TTL_SEC);

      const url = new URL(authorizationEndpoint);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", opts.login.clientId);
      url.searchParams.set("redirect_uri", opts.login.redirectUri);
      url.searchParams.set("scope", scope);
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      res.redirect(url.toString());
    } catch (err) {
      logger.warn({ err: errMsg(err) }, "console: login start failed");
      res.status(502).type("html").send(page("Login unavailable", `<p>${escapeHtml("The identity provider could not be reached. Please try again.")}</p>`));
    }
  });

  // GET /callback — validate state, exchange code, establish the session.
  router.get("/callback", async (req: Request, res: Response) => {
    // Surface IdP-reported errors without echoing anything unescaped.
    if (typeof req.query.error === "string") {
      clearCookie(res, FLOW_COOKIE);
      return res
        .status(401)
        .type("html")
        .send(page("Sign-in failed", `<p>${escapeHtml("The identity provider rejected the sign-in.")}</p>`));
    }

    const flowRaw = parseCookies(req.headers.cookie)[FLOW_COOKIE];
    const flow = flowRaw ? await verifyToken(flowRaw) : undefined;
    clearCookie(res, FLOW_COOKIE); // one-time use, regardless of outcome

    const code = typeof req.query.code === "string" ? req.query.code : "";
    const stateParam = typeof req.query.state === "string" ? req.query.state : "";
    const expectedState = flow && typeof flow.state === "string" ? flow.state : "";
    const codeVerifier = flow && typeof flow.cv === "string" ? flow.cv : "";

    // Constant-time state comparison; reject any mismatch (CSRF on the flow).
    if (!code || !expectedState || !safeEqual(stateParam, expectedState) || !codeVerifier) {
      return res
        .status(401)
        .type("html")
        .send(page("Sign-in failed", `<p>${escapeHtml("Invalid or expired sign-in request. Please start again.")}</p>`));
    }

    try {
      const { tokenEndpoint } = await discover();
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: opts.login.redirectUri,
        client_id: opts.login.clientId,
        client_secret: opts.login.clientSecret,
        code_verifier: codeVerifier,
      });
      const tokenRes = await fetch(tokenEndpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: body.toString(),
        signal: AbortSignal.timeout(10_000),
      });
      if (!tokenRes.ok) {
        logger.warn({ status: tokenRes.status }, "console: token exchange failed");
        return res
          .status(401)
          .type("html")
          .send(page("Sign-in failed", `<p>${escapeHtml("Could not complete sign-in.")}</p>`));
      }
      const tokens = (await tokenRes.json()) as { id_token?: string };
      if (!tokens.id_token) {
        return res
          .status(401)
          .type("html")
          .send(page("Sign-in failed", `<p>${escapeHtml("The identity provider returned no id_token.")}</p>`));
      }

      // Verify the id_token's signature against the issuer's JWKS before trusting
      // any claim — its groups drive admin/write-key minting. Reject (401) on any
      // failure (bad signature, wrong issuer/audience, expired) rather than 500.
      let claims: JWTPayload;
      try {
        const keySet = await getJwks();
        ({ payload: claims } = await jwtVerify(tokens.id_token, keySet, {
          issuer: opts.login.issuer,
          audience: opts.login.clientId,
        }));
      } catch (err) {
        logger.warn({ err: errMsg(err) }, "console: id_token verification failed");
        return res
          .status(401)
          .type("html")
          .send(page("Sign-in failed", `<p>${escapeHtml("The identity token could not be verified.")}</p>`));
      }

      const sub = typeof claims.sub === "string" ? claims.sub : "";
      if (!sub) {
        return res
          .status(401)
          .type("html")
          .send(page("Sign-in failed", `<p>${escapeHtml("The identity token had no subject.")}</p>`));
      }
      const nameVal = claims[nameClaim];
      const name = typeof nameVal === "string" && nameVal ? nameVal : sub;
      const groups = extractGroups(claims[groupsClaim]);
      const csrf = randomBytes(16).toString("base64url");

      const session = await signToken({ sub, name, groups, csrf }, SESSION_TTL_SEC);
      setCookie(res, SESSION_COOKIE, session, SESSION_TTL_SEC);
      return res.redirect(basePath);
    } catch (err) {
      logger.warn({ err: errMsg(err) }, "console: callback failed");
      return res
        .status(502)
        .type("html")
        .send(page("Sign-in failed", `<p>${escapeHtml("The identity provider could not be reached.")}</p>`));
    }
  });

  // GET {basePath} — the key dashboard.
  router.get("/", async (req: Request, res: Response) => {
    const session = await readSession(req);
    if (!session) return res.redirect(`${basePath}/login`);
    let keys: ApiKeyRecord[];
    try {
      keys = await opts.store.listByOwner(session.sub);
    } catch (err) {
      logger.error({ err: errMsg(err) }, "console: listByOwner failed");
      return res
        .status(500)
        .type("html")
        .send(page("Error", `<p>${escapeHtml("Could not load your keys.")}</p>`));
    }
    res.type("html").send(dashboardPage(session, keys, isAdmin(session.groups)));
  });

  // POST {basePath}/keys — mint a new key.
  router.post("/keys", async (req: Request, res: Response) => {
    const session = await readSession(req);
    if (!session) return res.status(401).type("html").send(page("Unauthorized", "<p>Please sign in.</p>"));
    if (!checkCsrf(req, session.csrf)) {
      return res.status(403).type("html").send(page("Forbidden", "<p>Invalid request token.</p>"));
    }

    const name = String(req.body?.name ?? "").trim();
    if (!name || name.length > 200) {
      return res
        .status(400)
        .type("html")
        .send(page("Invalid", `<p>${escapeHtml("A key name (1–200 chars) is required.")}</p>`));
    }

    // Expiry: optional positive integer number of days.
    let expiresAt: string | undefined;
    const days = Number.parseInt(String(req.body?.expiryDays ?? ""), 10);
    if (Number.isFinite(days) && days > 0) {
      expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
    }

    // Writes are honored only for admins — never trust the form checkbox alone.
    const allowWrites = isAdmin(session.groups) && req.body?.allowWrites === "on";

    try {
      const { record, secret } = await opts.store.create({
        name,
        owner: session.sub,
        allowWrites,
        expiresAt,
      });
      // Render the plaintext secret exactly once. It is never logged or stored.
      return res.type("html").send(secretPage(record, secret));
    } catch (err) {
      logger.error({ err: errMsg(err) }, "console: create key failed");
      return res
        .status(500)
        .type("html")
        .send(page("Error", `<p>${escapeHtml("Could not create the key.")}</p>`));
    }
  });

  // POST {basePath}/keys/:id/revoke — revoke one of the caller's keys.
  router.post("/keys/:id/revoke", async (req: Request, res: Response) => {
    const session = await readSession(req);
    if (!session) return res.status(401).type("html").send(page("Unauthorized", "<p>Please sign in.</p>"));
    if (!checkCsrf(req, session.csrf)) {
      return res.status(403).type("html").send(page("Forbidden", "<p>Invalid request token.</p>"));
    }
    try {
      // The store enforces owner-scoping; a non-owner id simply returns false.
      await opts.store.revoke(String(req.params.id), session.sub);
    } catch (err) {
      logger.error({ err: errMsg(err) }, "console: revoke failed");
    }
    return res.redirect(basePath);
  });

  // GET {basePath}/logout — drop the session cookie.
  router.get("/logout", (_req: Request, res: Response) => {
    clearCookie(res, SESSION_COOKIE);
    res.redirect(`${basePath}/login`);
  });

  // --- HTML rendering (all interpolated values escaped) --------------------

  function dashboardPage(session: Session, keys: ApiKeyRecord[], admin: boolean): string {
    const rows =
      keys.length === 0
        ? `<tr><td colspan="6" class="muted">No keys yet.</td></tr>`
        : keys
            .map((k) => {
              const status = k.revoked
                ? `<span class="bad">revoked</span>`
                : k.expiresAt && Date.parse(k.expiresAt) <= Date.now()
                  ? `<span class="bad">expired</span>`
                  : `<span class="ok">active</span>`;
              const revokeBtn = k.revoked
                ? ""
                : `<form method="post" action="${escapeHtml(`${basePath}/keys/${encodeURIComponent(k.id)}/revoke`)}">
                     <input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}">
                     <button type="submit" class="danger">Revoke</button>
                   </form>`;
              return `<tr>
                <td>${escapeHtml(k.name)}${k.allowWrites ? ' <span class="tag">writes</span>' : ""}</td>
                <td>${escapeHtml(fmtDate(k.createdAt))}</td>
                <td>${escapeHtml(k.lastUsedAt ? fmtDate(k.lastUsedAt) : "—")}</td>
                <td>${escapeHtml(k.expiresAt ? fmtDate(k.expiresAt) : "never")}</td>
                <td>${status}</td>
                <td>${revokeBtn}</td>
              </tr>`;
            })
            .join("");

    const writesField = admin
      ? `<label class="check"><input type="checkbox" name="allowWrites"> Allow writes (mutating tools)</label>`
      : "";

    const body = `
      <header>
        <h1>API keys</h1>
        <div class="who">${escapeHtml(session.name)} · <a href="${escapeHtml(`${basePath}/logout`)}">Sign out</a></div>
      </header>

      <section class="card">
        <h2>Create a key</h2>
        <form method="post" action="${escapeHtml(`${basePath}/keys`)}" class="create">
          <input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}">
          <label>Name<br><input type="text" name="name" maxlength="200" required placeholder="e.g. ci-pipeline"></label>
          <label>Expiry (days)<br><input type="number" name="expiryDays" min="1" max="3650" placeholder="never"></label>
          ${writesField}
          <button type="submit">Create key</button>
        </form>
      </section>

      <section class="card">
        <h2>Your keys</h2>
        <table>
          <thead><tr><th>Name</th><th>Created</th><th>Last used</th><th>Expires</th><th>Status</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`;
    return page("API keys", body);
  }

  function secretPage(record: ApiKeyRecord, secret: string): string {
    const body = `
      <header><h1>Key created</h1></header>
      <section class="card">
        <p>Key <strong>${escapeHtml(record.name)}</strong> was created.</p>
        <p class="warn">Copy this secret now — it is shown only once and cannot be retrieved again.</p>
        <pre class="secret">${escapeHtml(secret)}</pre>
        <p><a href="${escapeHtml(basePath)}">Back to your keys</a></p>
      </section>`;
    return page("Key created", body);
  }

  function checkCsrf(req: Request, expected: string): boolean {
    const token = String(req.body?.csrf ?? "");
    return safeEqual(token, expected);
  }

  return router;
}

// ---------------------------------------------------------------------------
// Stateless helpers (no closure over router options)
// ---------------------------------------------------------------------------

/** Ensure a leading slash and no trailing slash (root stays "/"). */
function normalizeBasePath(p: string): string {
  let out = p.startsWith("/") ? p : `/${p}`;
  if (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

/** Parse a raw Cookie header into a name→value map (no cookie-parser dep). */
function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    if (name) out[name] = pair.slice(eq + 1).trim();
  }
  return out;
}

/** Normalize a groups claim (array, or space/comma-separated string) to string[]. */
function extractGroups(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string") return raw.split(/[\s,]+/).filter(Boolean);
  return [];
}

/** Constant-time string comparison that never throws on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().replace("T", " ").slice(0, 16) + "Z";
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Escape the five HTML-significant characters for safe interpolation. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Wrap page body in a minimal, self-contained HTML document. */
function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; }
  header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 1rem; }
  h1 { font-size: 1.4rem; margin: 0; }
  h2 { font-size: 1.1rem; }
  .who { font-size: .9rem; opacity: .8; }
  .card { border: 1px solid rgba(128,128,128,.35); border-radius: 8px; padding: 1rem 1.25rem; margin: 1rem 0; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .5rem .4rem; border-bottom: 1px solid rgba(128,128,128,.2); vertical-align: middle; }
  th { font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; opacity: .7; }
  .muted { opacity: .6; }
  .ok { color: #1a7f37; } .bad { color: #b42318; }
  .tag { font-size: .7rem; background: rgba(128,128,128,.25); border-radius: 4px; padding: .05rem .35rem; }
  .create { display: flex; flex-wrap: wrap; gap: 1rem; align-items: flex-end; }
  input[type=text], input[type=number] { padding: .4rem; border: 1px solid rgba(128,128,128,.5); border-radius: 6px; }
  .check { align-self: center; }
  button { padding: .45rem .9rem; border: 0; border-radius: 6px; background: #2563eb; color: #fff; cursor: pointer; }
  button.danger { background: #b42318; padding: .3rem .7rem; }
  .warn { color: #b42318; font-weight: 600; }
  .secret { background: rgba(128,128,128,.15); padding: .8rem; border-radius: 6px; word-break: break-all; user-select: all; }
  a { color: #2563eb; }
</style>
</head>
<body>${body}</body>
</html>`;
}
