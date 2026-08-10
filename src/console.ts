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
  sessionSecret: string;
  /** OIDC (SSO) login — optional. */
  login?: { issuer: string; clientId: string; clientSecret: string; redirectUri: string; scopes?: string };
  /** LDAP username/password authenticator — optional. */
  ldap?: (username: string, password: string) => Promise<{ sub: string; name: string; groups: string[] } | undefined>;
  adminGroups?: string[];
  groupsClaim?: string;
  nameClaim?: string;
  basePath?: string;
}): Router {
  if (!opts.login && !opts.ldap) {
    throw new Error("console requires a login method: an OIDC config or an LDAP authenticator");
  }
  const basePath = normalizeBasePath(opts.basePath ?? "/console");
  const adminGroups = opts.adminGroups ?? [];
  const groupsClaim = opts.groupsClaim ?? "groups";
  const nameClaim = opts.nameClaim ?? "email";
  const scope = opts.login?.scopes ?? "openid email profile";
  const secretKey = new TextEncoder().encode(opts.sessionSecret);

  // Cookie names + lifetimes. Cookies are scoped to basePath so they never leak
  // to the rest of the app; both are httpOnly + Secure + SameSite=Lax (Lax is
  // required so the top-level redirect back from the IdP carries the flow cookie).
  const FLOW_COOKIE = "udm_console_flow";
  const SESSION_COOKIE = "udm_console_session";
  const LOGIN_CSRF_COOKIE = "udm_console_login_csrf"; // double-submit guard on the LDAP form
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
        const res = await fetch(`${opts.login!.issuer}/.well-known/openid-configuration`, {
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

  // Match an admin group by exact value or by its CN (so LDAP group DNs like
  // "cn=platform-admins,ou=groups,dc=corp,dc=io" match a configured "platform-admins").
  const cnOf = (group: string): string => {
    const m = /^cn=([^,]+)/i.exec(group);
    return m ? m[1] : group;
  };
  const isAdmin = (groups: string[]): boolean =>
    adminGroups.length > 0 && groups.some((g) => adminGroups.includes(g) || adminGroups.includes(cnOf(g)));

  // --- Routes --------------------------------------------------------------

  // Establish the signed session cookie shared by both login methods.
  async function establishSession(
    res: Response,
    user: { sub: string; name: string; groups: string[] },
  ): Promise<void> {
    const csrf = randomBytes(16).toString("base64url");
    const session = await signToken({ sub: user.sub, name: user.name, groups: user.groups, csrf }, SESSION_TTL_SEC);
    setCookie(res, SESSION_COOKIE, session, SESSION_TTL_SEC);
  }

  // Start the OIDC Authorization Code + PKCE flow (only when OIDC is configured).
  async function startOidcLogin(res: Response): Promise<void> {
    const { authorizationEndpoint } = await discover();
    const state = randomBytes(16).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    // Stash state + verifier in a short-lived signed cookie (no server store).
    const flow = await signToken({ state, cv: codeVerifier }, FLOW_TTL_SEC);
    setCookie(res, FLOW_COOKIE, flow, FLOW_TTL_SEC);
    const url = new URL(authorizationEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", opts.login!.clientId);
    url.searchParams.set("redirect_uri", opts.login!.redirectUri);
    url.searchParams.set("scope", scope);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    res.redirect(url.toString());
  }
  function ssoUnavailable(res: Response, err: unknown): void {
    logger.warn({ err: errMsg(err) }, "console: login start failed");
    res
      .status(502)
      .type("html")
      .send(page("Login unavailable", `<p>${escapeHtml("The identity provider could not be reached. Please try again.")}</p>`));
  }

  // GET /login — LDAP username/password form if configured; else start SSO.
  router.get("/login", async (req: Request, res: Response) => {
    if (await readSession(req)) return res.redirect(basePath);
    if (opts.ldap) {
      const nonce = randomBytes(16).toString("base64url");
      setCookie(res, LOGIN_CSRF_COOKIE, nonce, FLOW_TTL_SEC);
      return res.type("html").send(loginPage(nonce, Boolean(opts.login)));
    }
    try {
      await startOidcLogin(res);
    } catch (err) {
      ssoUnavailable(res, err);
    }
  });

  // GET /login/sso — force the SSO flow (linked from the LDAP form).
  if (opts.login) {
    router.get("/login/sso", async (_req: Request, res: Response) => {
      try {
        await startOidcLogin(res);
      } catch (err) {
        ssoUnavailable(res, err);
      }
    });
  }

  // POST /login — username/password validated against LDAP.
  if (opts.ldap) {
    const ldapAuth = opts.ldap;
    router.post("/login", async (req: Request, res: Response) => {
      const cookieNonce = parseCookies(req.headers.cookie)[LOGIN_CSRF_COOKIE] ?? "";
      const formNonce = String(req.body?.csrf ?? "");
      clearCookie(res, LOGIN_CSRF_COOKIE); // one-time use
      const reshow = (message: string, status = 401) => {
        const nonce = randomBytes(16).toString("base64url");
        setCookie(res, LOGIN_CSRF_COOKIE, nonce, FLOW_TTL_SEC);
        res.status(status).type("html").send(loginPage(nonce, Boolean(opts.login), message));
      };
      if (!cookieNonce || !safeEqual(formNonce, cookieNonce)) {
        return reshow("Your sign-in session expired. Please try again.");
      }
      const username = String(req.body?.username ?? "").trim();
      const password = String(req.body?.password ?? "");
      if (!username || !password) return reshow("Enter your username and password.");
      let user;
      try {
        user = await ldapAuth(username, password);
      } catch (err) {
        logger.warn({ err: errMsg(err) }, "console: ldap auth error");
        return reshow("The directory could not be reached. Please try again.", 502);
      }
      if (!user) return reshow("Invalid username or password.");
      await establishSession(res, user);
      return res.redirect(basePath);
    });
  }

  // GET /callback — validate state, exchange code, establish the session.
  router.get("/callback", async (req: Request, res: Response) => {
    if (!opts.login) return res.status(404).end(); // OIDC not configured
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
      await establishSession(res, { sub, name, groups });
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
      return res.type("html").send(secretPage(session, record, secret));
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

  function loginPage(nonce: string, ssoAvailable: boolean, error?: string): string {
    const err = error ? `<div class="loginerr">${escapeHtml(error)}</div>` : "";
    const sso = ssoAvailable
      ? `<div class="ssorow"><a href="${escapeHtml(`${basePath}/login/sso`)}">Sign in with SSO instead →</a></div>`
      : "";
    const body = `
      <div class="login">
        <span class="eyebrow">Sign in</span>
        <h1>Ultimate DevOps console</h1>
        <p class="sub">Sign in with your directory (LDAP) username and password to manage your API keys.</p>
        <section class="card">
          ${err}
          <form method="post" action="${escapeHtml(`${basePath}/login`)}" class="loginform" autocomplete="on">
            <input type="hidden" name="csrf" value="${escapeHtml(nonce)}">
            <div class="field">
              <label for="u">Username</label>
              <input id="u" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus>
            </div>
            <div class="field">
              <label for="p">Password</label>
              <input id="p" name="password" type="password" autocomplete="current-password" required>
            </div>
            <button type="submit" class="btn primary loginbtn">Sign in</button>
          </form>
          ${sso}
        </section>
      </div>`;
    return page("Sign in", body, { basePath });
  }

  function dashboardPage(session: Session, keys: ApiKeyRecord[], admin: boolean): string {
    const rows =
      keys.length === 0
        ? `<tr><td colspan="6"><div class="empty"><div class="big">No keys yet</div>Create your first key above to start calling the gateway.</div></td></tr>`
        : keys
            .map((k) => {
              const expired = !!k.expiresAt && Date.parse(k.expiresAt) <= Date.now();
              const status = k.revoked
                ? `<span class="pill bad">revoked</span>`
                : expired
                  ? `<span class="pill bad">expired</span>`
                  : `<span class="pill ok">active</span>`;
              const revokeBtn = k.revoked
                ? ""
                : `<form method="post" action="${escapeHtml(`${basePath}/keys/${encodeURIComponent(k.id)}/revoke`)}" onsubmit="return confirm('Revoke this key? Any client using it will stop working immediately.')">
                     <input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}">
                     <button type="submit" class="btn danger">Revoke</button>
                   </form>`;
              return `<tr>
                <td><span class="kname">${escapeHtml(k.name)}</span>${k.allowWrites ? '<span class="badge">writes</span>' : ""}</td>
                <td class="date">${escapeHtml(fmtDate(k.createdAt))}</td>
                <td class="date">${escapeHtml(k.lastUsedAt ? fmtDate(k.lastUsedAt) : "—")}</td>
                <td class="date">${escapeHtml(k.expiresAt ? fmtDate(k.expiresAt) : "never")}</td>
                <td>${status}</td>
                <td class="right">${revokeBtn}</td>
              </tr>`;
            })
            .join("");

    const writesField = admin
      ? `<label class="check"><input type="checkbox" name="allowWrites"> Allow <strong>writes</strong> — this key may call mutating tools</label>`
      : `<p class="check hint">Read-only key. Write access requires admin-group membership.</p>`;

    const body = `
      <span class="eyebrow">Account · API keys</span>
      <h1>Your API keys</h1>
      <p class="sub">Keys authenticate you to the gateway's <span class="mono">/mcp</span> endpoint. Each secret is shown once at creation and stored only as a SHA-256 hash — it can never be retrieved again.</p>

      <section class="card">
        <h2>Create a key</h2>
        <form method="post" action="${escapeHtml(`${basePath}/keys`)}" class="create">
          <input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}">
          <div class="field">
            <label for="k-name">Name</label>
            <input id="k-name" type="text" name="name" maxlength="200" required placeholder="e.g. ci-pipeline" autocomplete="off">
          </div>
          <div class="field">
            <label for="k-exp">Expiry (days)</label>
            <input id="k-exp" type="number" name="expiryDays" min="1" max="3650" placeholder="never">
          </div>
          <button type="submit" class="btn primary">Create key</button>
          ${writesField}
        </form>
      </section>

      <section class="card">
        <h2>Active &amp; past keys <span class="count">${keys.length}</span></h2>
        <div class="tablewrap">
          <table>
            <thead><tr><th>Name</th><th>Created</th><th>Last used</th><th>Expires</th><th>Status</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </section>`;
    return page("API keys", body, { name: session.name, basePath });
  }

  function secretPage(session: Session, record: ApiKeyRecord, secret: string): string {
    const body = `
      <span class="eyebrow">Key created</span>
      <h1>Copy your new key</h1>
      <p class="sub">This is the only time <strong>${escapeHtml(record.name)}</strong>${record.allowWrites ? '<span class="badge">writes</span>' : ""} will be shown.</p>

      <section class="card">
        <div class="note">
          <span class="note-i">!</span>
          <div><strong>Store this secret now.</strong> It cannot be retrieved again — only its SHA-256 hash is kept. If you lose it, revoke the key and create a new one.</div>
        </div>
        <div class="secret">
          <code id="secret">${escapeHtml(secret)}</code>
          <button type="button" class="btn primary" id="copyBtn">Copy</button>
        </div>
        <p class="usage">Use it as a bearer token: <span class="mono">Authorization: Bearer ${escapeHtml(secret.slice(0, 14))}…</span></p>
        <p><a href="${escapeHtml(basePath)}">← Back to your keys</a></p>
      </section>
      <script>
      (function(){var b=document.getElementById('copyBtn'),s=document.getElementById('secret');if(!b||!s)return;b.addEventListener('click',function(){navigator.clipboard.writeText(s.textContent).then(function(){b.textContent='Copied ✓';setTimeout(function(){b.textContent='Copy'},1600)}).catch(function(){var r=document.createRange();r.selectNodeContents(s);var sel=window.getSelection();sel.removeAllRanges();sel.addRange(r)})})})();
      </script>`;
    return page("Key created", body, { name: session.name, basePath });
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

/** Wrap page body in a self-contained, theme-aware HTML document with a branded
 * top bar. `opts.basePath` makes the brand link home; `opts.name` shows the
 * signed-in user + a Sign out control (omitted on pre-auth / error pages). */
function page(title: string, body: string, opts: { name?: string; basePath?: string } = {}): string {
  const brand = opts.basePath
    ? `<a class="brand" href="${escapeHtml(opts.basePath)}"><span class="dot"></span><span>ultimate-devops <span class="slash">/</span> console</span></a>`
    : `<span class="brand"><span class="dot"></span><span>ultimate-devops <span class="slash">/</span> console</span></span>`;
  const right = opts.name
    ? `<span class="userchip"><span class="nm">${escapeHtml(opts.name)}</span></span><a class="btn" href="${escapeHtml(`${opts.basePath ?? ""}/logout`)}">Sign out</a>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · ultimate-devops console</title>
<style>
  :root {
    color-scheme: light dark;
    --ink:#F4F7FB; --panel:#FFFFFF; --panel-2:#EEF3F9; --line:#D3DEEA; --line-soft:#E4ECF4;
    --text:#16202B; --muted:#566677; --faint:#8494A5;
    --accent:#2563EB; --accent-weak:#DBE7FF;
    --ok:#158A5E; --ok-weak:#DCF3E8; --crit:#C64351; --crit-weak:#FBE3E5; --warn:#B4791C; --warn-weak:#F7ECD6;
    --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --mono: ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Code", Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ink:#0E141C; --panel:#141D28; --panel-2:#1A2532; --line:#26333F; --line-soft:#1F2B37;
      --text:#E8EFF6; --muted:#8FA0B2; --faint:#6A7B8D;
      --accent:#5A9CFF; --accent-weak:#1B2E47;
      --ok:#43C08B; --ok-weak:#12291F; --crit:#E76A74; --crit-weak:#331A1D; --warn:#E2A94A; --warn-weak:#2E2513;
    }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--ink); color:var(--text); font-family:var(--sans); line-height:1.55; -webkit-font-smoothing:antialiased; }
  a { color:var(--accent); text-decoration:none; }
  a:hover { text-decoration:underline; }
  .mono { font-family:var(--mono); }
  code { font-family:var(--mono); }

  .topbar { position:sticky; top:0; z-index:10; background:color-mix(in srgb, var(--ink) 85%, transparent); backdrop-filter:blur(10px); border-bottom:1px solid var(--line-soft); }
  .topbar .row { max-width:960px; margin:0 auto; display:flex; align-items:center; gap:12px; height:56px; padding:0 20px; }
  .brand { display:flex; align-items:center; gap:9px; font-family:var(--mono); font-weight:600; font-size:14px; color:var(--text); }
  .brand:hover { text-decoration:none; }
  .brand .dot { width:8px; height:8px; border-radius:50%; background:var(--ok); box-shadow:0 0 0 4px color-mix(in srgb, var(--ok) 22%, transparent); }
  .brand .slash { color:var(--faint); }
  .spacer { flex:1; }
  .userchip { font-size:13px; color:var(--muted); }
  .userchip .nm { color:var(--text); font-weight:550; }

  .btn { font:inherit; font-size:13px; cursor:pointer; border-radius:9px; border:1px solid var(--line); background:var(--panel); color:var(--text); padding:8px 14px; transition:border-color .15s, background .15s, filter .15s; }
  .btn:hover { border-color:var(--accent); }
  .btn.primary { background:var(--accent); border-color:var(--accent); color:#fff; font-weight:600; }
  .btn.primary:hover { filter:brightness(1.08); }
  .btn.danger { border-color:color-mix(in srgb, var(--crit) 45%, transparent); color:var(--crit); background:transparent; padding:6px 12px; font-size:12.5px; }
  .btn.danger:hover { background:var(--crit-weak); }
  :focus-visible { outline:2px solid var(--accent); outline-offset:2px; }

  .wrap { max-width:960px; margin:0 auto; padding:32px 20px 72px; }
  .eyebrow { font-family:var(--mono); font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:var(--accent); }
  h1 { font-size:25px; letter-spacing:-.02em; margin:8px 0 6px; font-weight:640; text-wrap:balance; }
  .sub { color:var(--muted); font-size:14px; margin:0 0 24px; max-width:66ch; }
  .sub .mono { color:var(--text); background:var(--panel-2); padding:1px 6px; border-radius:5px; font-size:12.5px; }

  .card { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:20px 22px; margin:16px 0; }
  .card h2 { font-size:15px; font-weight:620; margin:0 0 16px; display:flex; align-items:center; gap:9px; }
  .card h2 .count { font-family:var(--mono); font-size:12px; color:var(--muted); font-weight:500; background:var(--panel-2); border:1px solid var(--line-soft); padding:1px 9px; border-radius:999px; }

  .create { display:grid; grid-template-columns:1fr 170px auto; gap:14px; align-items:end; }
  @media (max-width:640px) { .create { grid-template-columns:1fr; } }
  .field { display:flex; flex-direction:column; gap:6px; }
  .field label { font-size:12px; color:var(--muted); font-weight:550; }
  input[type=text], input[type=number], input[type=password] { font:inherit; padding:9px 12px; border:1px solid var(--line); border-radius:9px; background:var(--ink); color:var(--text); width:100%; }
  input::placeholder { color:var(--faint); }
  .check { grid-column:1 / -1; display:flex; align-items:center; gap:9px; font-size:13px; color:var(--muted); margin:0; }
  .check strong { color:var(--text); font-weight:600; }
  .check input { width:16px; height:16px; accent-color:var(--accent); }
  .check.hint { color:var(--faint); }

  .tablewrap { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; font-size:13.5px; }
  th { text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--faint); font-weight:600; padding:0 12px 10px; border-bottom:1px solid var(--line); white-space:nowrap; }
  td { padding:13px 12px; border-bottom:1px solid var(--line-soft); vertical-align:middle; }
  tbody tr:last-child td { border-bottom:0; }
  tbody tr:hover td { background:color-mix(in srgb, var(--accent) 5%, transparent); }
  td.right { text-align:right; }
  .kname { font-weight:600; }
  td.date { font-family:var(--mono); font-variant-numeric:tabular-nums; color:var(--muted); font-size:12.5px; white-space:nowrap; }

  .pill { display:inline-flex; align-items:center; gap:6px; font-size:11.5px; font-weight:600; padding:3px 10px; border-radius:999px; }
  .pill::before { content:""; width:6px; height:6px; border-radius:50%; background:currentColor; }
  .pill.ok { color:var(--ok); background:var(--ok-weak); }
  .pill.bad { color:var(--crit); background:var(--crit-weak); }
  .badge { font-family:var(--mono); font-size:10px; letter-spacing:.04em; text-transform:uppercase; color:var(--warn); background:var(--warn-weak); border-radius:5px; padding:2px 6px; margin-left:8px; vertical-align:middle; }

  .empty { text-align:center; color:var(--muted); padding:36px 12px; font-size:13.5px; }
  .empty .big { font-size:15px; color:var(--text); font-weight:600; margin-bottom:4px; }

  .note { display:flex; gap:12px; align-items:flex-start; background:var(--warn-weak); border:1px solid color-mix(in srgb, var(--warn) 34%, transparent); color:var(--text); border-radius:11px; padding:13px 15px; font-size:13.5px; }
  .note-i { flex:none; width:20px; height:20px; border-radius:50%; background:var(--warn); color:#1a1206; font-weight:800; font-size:13px; display:grid; place-items:center; }
  .secret { display:flex; gap:10px; align-items:stretch; margin:16px 0 8px; }
  .secret code { flex:1; font-size:13.5px; background:var(--ink); border:1px solid var(--line); border-radius:10px; padding:13px 15px; word-break:break-all; user-select:all; display:flex; align-items:center; }
  .secret .btn { white-space:nowrap; }
  .usage { color:var(--muted); font-size:12.5px; margin:6px 0 18px; }
  .usage .mono { color:var(--text); }

  .msg { max-width:440px; margin:44px auto; text-align:center; }

  .login { max-width:400px; margin:7vh auto 0; }
  .login h1 { font-size:22px; }
  .loginform { display:flex; flex-direction:column; gap:15px; margin-top:2px; }
  .loginbtn { width:100%; padding:10px; margin-top:4px; }
  .loginerr { background:var(--crit-weak); border:1px solid color-mix(in srgb, var(--crit) 40%, transparent); color:var(--crit); border-radius:9px; padding:10px 12px; font-size:13px; margin-bottom:16px; }
  .ssorow { margin-top:16px; padding-top:16px; border-top:1px solid var(--line-soft); text-align:center; font-size:13px; }
</style>
</head>
<body>
<div class="topbar"><div class="row">${brand}<span class="spacer"></span>${right}</div></div>
<main class="wrap">${body}</main>
</body>
</html>`;
}
