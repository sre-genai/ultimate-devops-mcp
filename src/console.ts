import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import express, { type Request, type Response, type Router } from "express";
import { SignJWT, jwtVerify, createRemoteJWKSet, type JWTPayload } from "jose";
import { logger } from "./logger.js";
import type { KeyStore, ApiKeyRecord } from "./keystore.js";
import { BRAND_ICONS } from "./icons.js";
import type { MetricsSnapshot } from "./metrics.js";
import type { AuditRecord } from "./audit.js";
import { toolWildcard } from "./toolscope.js";

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
  /** Static-token login — verifies a pasted MCP_AUTH_TOKEN / MCP_API_KEYS value. Optional. */
  verifyToken?: (token: string) => { name: string; allowWrites: boolean } | undefined;
  adminGroups?: string[];
  /** Groups mapped to the editor role (create/revoke read-only keys). */
  editorGroups?: string[];
  /** Groups mapped to the view role (browse only). */
  viewerGroups?: string[];
  /** Role for authenticated users not in any mapped group (default "view"). */
  defaultRole?: "view" | "editor" | "admin";
  groupsClaim?: string;
  nameClaim?: string;
  basePath?: string;
  /** Read-only gateway status shown on the dashboard. */
  status?: { version: string; writesAllowed: boolean; supported: string[]; active: string[] };
  /** Live metrics snapshot (Usage & Metrics page). */
  metrics?: () => MetricsSnapshot;
  /** Recent audit records (Audit Logs page). */
  auditFeed?: () => AuditRecord[];
  /** Read-only settings, label → value (Settings page). */
  settings?: Array<[string, string]>;
  /** Reachability of each active integration (systems health). */
  health?: (active: string[]) => Promise<Record<string, "up" | "down" | "unknown">>;
  /** Per-interval call/error samples for the usage sparkline. */
  series?: () => Array<{ t: number; calls: number; errors: number }>;
}): Router {
  if (!opts.login && !opts.ldap && !opts.verifyToken) {
    throw new Error("console requires a login method: OIDC, LDAP, or a static-token verifier");
  }
  const basePath = normalizeBasePath(opts.basePath ?? "/console");
  // The MCP endpoint a client points at — derived from the incoming request so
  // the console shows the URL the user actually reached us on (honors proxies).
  const mcpEndpoint = (req: Request): string => {
    const proto = String(req.headers["x-forwarded-proto"] ?? req.protocol ?? "http").split(",")[0].trim();
    const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost").split(",")[0].trim();
    return `${proto}://${host}/mcp`;
  };
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

  type Role = "view" | "editor" | "admin";
  interface Session {
    sub: string;
    name: string;
    groups: string[];
    role: Role;
    csrf: string;
  }

  // Match a group by exact value or by its CN (so LDAP DNs like
  // "cn=platform-admins,ou=groups,dc=corp,dc=io" match a configured "platform-admins").
  const cnOf = (group: string): string => {
    const m = /^cn=([^,]+)/i.exec(group);
    return m ? m[1] : group;
  };
  const editorGroups = opts.editorGroups ?? [];
  const viewerGroups = opts.viewerGroups ?? [];
  const defaultRole: Role = opts.defaultRole ?? "view";
  const inGroups = (groups: string[], set: string[]): boolean =>
    set.length > 0 && groups.some((g) => set.includes(g) || set.includes(cnOf(g)));
  // Resolve a role from group membership: admin > editor > viewer > default.
  const roleOf = (groups: string[]): Role =>
    inGroups(groups, adminGroups)
      ? "admin"
      : inGroups(groups, editorGroups)
        ? "editor"
        : inGroups(groups, viewerGroups)
          ? "view"
          : defaultRole;
  const isRole = (v: unknown): v is Role => v === "view" || v === "editor" || v === "admin";
  // Every authenticated role can self-service read-only keys; editor + admin can
  // also mint write-capable keys.
  const canWrite = (r: Role): boolean => r === "editor" || r === "admin";
  const roleLabel = (r: Role): string => (r === "admin" ? "Administrator" : r === "editor" ? "Editor" : "Read-only");

  async function readSession(req: Request): Promise<Session | undefined> {
    const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!raw) return undefined;
    const payload = await verifyToken(raw);
    if (!payload) return undefined;
    const sub = typeof payload.sub === "string" ? payload.sub : "";
    const name = typeof payload.name === "string" ? payload.name : sub;
    const groups = Array.isArray(payload.groups) ? payload.groups.map(String) : [];
    const role: Role = isRole(payload.role) ? payload.role : roleOf(groups);
    const csrf = typeof payload.csrf === "string" ? payload.csrf : "";
    if (!sub || !csrf) return undefined;
    return { sub, name, groups, role, csrf };
  }

  // --- Routes --------------------------------------------------------------

  // Establish the signed session cookie shared by all login methods.
  async function establishSession(
    res: Response,
    user: { sub: string; name: string; groups: string[]; role?: Role },
  ): Promise<void> {
    const csrf = randomBytes(16).toString("base64url");
    const role = user.role ?? roleOf(user.groups);
    const session = await signToken(
      { sub: user.sub, name: user.name, groups: user.groups, role, csrf },
      SESSION_TTL_SEC,
    );
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

  // Render the login form for whichever method is configured (LDAP or token).
  const loginForm = (nonce: string, error?: string): string =>
    opts.ldap ? loginPage(nonce, Boolean(opts.login), error) : tokenLoginPage(nonce, error);

  // GET /login — form login (LDAP or token) if configured; else start SSO.
  router.get("/login", async (req: Request, res: Response) => {
    if (await readSession(req)) return res.redirect(basePath);
    if (opts.ldap || opts.verifyToken) {
      const nonce = randomBytes(16).toString("base64url");
      setCookie(res, LOGIN_CSRF_COOKIE, nonce, FLOW_TTL_SEC);
      return res.type("html").send(loginForm(nonce));
    }
    try {
      await startOidcLogin(res);
    } catch (err) {
      ssoUnavailable(res, err);
    }
  });

  // GET /login/sso — force the SSO flow (linked from the form when both exist).
  if (opts.login) {
    router.get("/login/sso", async (_req: Request, res: Response) => {
      try {
        await startOidcLogin(res);
      } catch (err) {
        ssoUnavailable(res, err);
      }
    });
  }

  // POST /login — LDAP username/password, or a pasted static API token.
  if (opts.ldap || opts.verifyToken) {
    router.post("/login", async (req: Request, res: Response) => {
      const cookieNonce = parseCookies(req.headers.cookie)[LOGIN_CSRF_COOKIE] ?? "";
      const formNonce = String(req.body?.csrf ?? "");
      clearCookie(res, LOGIN_CSRF_COOKIE); // one-time use
      const reshow = (message: string, status = 401) => {
        const nonce = randomBytes(16).toString("base64url");
        setCookie(res, LOGIN_CSRF_COOKIE, nonce, FLOW_TTL_SEC);
        res.status(status).type("html").send(loginForm(nonce, message));
      };
      if (!cookieNonce || !safeEqual(formNonce, cookieNonce)) {
        return reshow("Your sign-in session expired. Please try again.");
      }
      if (opts.ldap) {
        const ldapAuth = opts.ldap;
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
      } else {
        const token = String(req.body?.token ?? "").trim();
        if (!token) return reshow("Paste your API token.");
        const id = opts.verifyToken!(token);
        if (!id) return reshow("Invalid API token.");
        // The key's own write permission decides admin (can mint write keys).
        await establishSession(res, { sub: id.name, name: id.name, groups: [], role: id.allowWrites ? "admin" : "view" });
      }
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
    const health = opts.health && opts.status ? await opts.health(opts.status.active) : {};
    res.type("html").send(dashboardPage(session, keys, health, mcpEndpoint(req)));
  });

  // GET {basePath}/overview — fleet summary.
  router.get("/overview", async (req: Request, res: Response) => {
    const session = await readSession(req);
    if (!session) return res.redirect(`${basePath}/login`);
    const health = opts.health && opts.status ? await opts.health(opts.status.active) : {};
    res.type("html").send(overviewPage(session, health));
  });

  // GET {basePath}/audit — recent audit feed.
  router.get("/audit", async (req: Request, res: Response) => {
    const session = await readSession(req);
    if (!session) return res.redirect(`${basePath}/login`);
    res.type("html").send(auditPage(session));
  });

  // GET {basePath}/usage — tool usage & metrics.
  router.get("/usage", async (req: Request, res: Response) => {
    const session = await readSession(req);
    if (!session) return res.redirect(`${basePath}/login`);
    res.type("html").send(usagePage(session));
  });

  // GET {basePath}/settings — read-only configuration.
  router.get("/settings", async (req: Request, res: Response) => {
    const session = await readSession(req);
    if (!session) return res.redirect(`${basePath}/login`);
    res.type("html").send(settingsPage(session));
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
    const allowWrites = canWrite(session.role) && req.body?.allowWrites === "on";

    // Scope to systems: checked integrations → tool-name wildcards. None checked
    // = no allowlist = all enabled tools (unchanged default). Only accept names
    // that are actually enabled on this gateway.
    const rawScope = req.body?.scope;
    const chosen = (Array.isArray(rawScope) ? rawScope : rawScope != null ? [rawScope] : [])
      .map((s: unknown) => String(s))
      .filter((n) => (opts.status?.active ?? []).includes(n));
    const tools = chosen.length ? chosen.map(toolWildcard) : undefined;

    try {
      const { record, secret } = await opts.store.create({
        name,
        owner: session.sub,
        allowWrites,
        expiresAt,
        tools,
      });
      // Render the plaintext secret exactly once. It is never logged or stored.
      return res.type("html").send(secretPage(session, record, secret, mcpEndpoint(req)));
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

  function tokenLoginPage(nonce: string, error?: string): string {
    const err = error ? `<div class="loginerr">${escapeHtml(error)}</div>` : "";
    const right = `
      <div class="shieldi">${SVG.shield}</div>
      <span class="eyebrow">Sign in to console</span>
      <h1>Welcome back!</h1>
      <p class="rsub">Sign in to access your Ultimate DevOps MCP console.</p>
      ${err}
      <form method="post" action="${escapeHtml(`${basePath}/login`)}" class="authform">
        <input type="hidden" name="csrf" value="${escapeHtml(nonce)}">
        <label for="tok">API Token</label>
        <p class="fhint">Paste your <code>MCP_AUTH_TOKEN</code> or <code>MCP_API_KEYS</code> to continue.</p>
        <div class="inputwrap">
          <span class="lead-ic">${SVG.key}</span>
          <input id="tok" name="token" type="password" required autofocus autocomplete="off" spellcheck="false" placeholder="Paste your token here">
          <button type="button" id="eye" class="eye" aria-label="Show token">${SVG.eye}</button>
        </div>
        <button type="submit" class="btn big grad">Sign in to console →</button>
      </form>
      <div class="ordiv">or</div>
      <a class="btn big" href="#how">How to get your API token ↗</a>
      <p class="secnote">🔒 Your data is encrypted and secure</p>`;
    return authPage("Sign in", right);
  }

  function loginPage(nonce: string, ssoAvailable: boolean, error?: string): string {
    const err = error ? `<div class="loginerr">${escapeHtml(error)}</div>` : "";
    const sso = ssoAvailable
      ? `<div class="ordiv">or</div><a class="btn big" href="${escapeHtml(`${basePath}/login/sso`)}">Sign in with SSO ↗</a>`
      : "";
    const right = `
      <div class="shieldi">${SVG.shield}</div>
      <span class="eyebrow">Sign in to console</span>
      <h1>Welcome back!</h1>
      <p class="rsub">Sign in with your directory account to access your console.</p>
      ${err}
      <form method="post" action="${escapeHtml(`${basePath}/login`)}" class="authform" autocomplete="on">
        <input type="hidden" name="csrf" value="${escapeHtml(nonce)}">
        <div class="field2">
          <label for="u">Username</label>
          <div class="inputwrap"><span class="lead-ic">${SVG.user}</span>
            <input id="u" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus placeholder="you@corp">
          </div>
        </div>
        <div class="field2">
          <label for="p">Password</label>
          <div class="inputwrap"><span class="lead-ic">${SVG.lock}</span>
            <input id="p" name="password" type="password" autocomplete="current-password" required placeholder="••••••••">
          </div>
        </div>
        <button type="submit" class="btn big grad">Sign in to console →</button>
      </form>
      ${sso}
      <p class="secnote">🔒 Your data is encrypted and secure</p>`;
    return authPage("Sign in", right);
  }

  // A system card with a health-aware status dot (up=green, down=red, unknown=amber).
  const systemCard = (
    n: string,
    activeSet: Set<string>,
    health: Record<string, string>,
    connect = false,
  ): string => {
    const w = WRITE_CAPABLE.has(n);
    const active = activeSet.has(n);
    const dot = !active ? "" : health[n] === "up" ? "on" : health[n] === "down" ? "down" : "unk";
    const clk = connect && active ? ` clickable" data-sys="${escapeHtml(n)}" role="button" tabindex="0` : "";
    const cta = connect && active ? `<span class="scard-cta">Connect ↗</span>` : "";
    return `<div class="scard${clk}"><div class="hd">${sysMono(n)}<span class="nm">${escapeHtml(prettyName(n))}</span><span class="sd ${dot}"></span></div><div class="rw"><span class="rwp on">✓ Read</span><span class="rwp ${w ? "on" : "off"}">${w ? "✓" : "○"} Write</span></div>${cta}</div>`;
  };

  // "How to connect a client" — the missing step after a key is minted. Filled
  // with the real secret on the one-time secret page, a placeholder elsewhere.
  const connectPanel = (endpoint: string, token: string, systems: string[] = []): string => {
    const reaches = systems.length
      ? `<div class="conn-row"><span class="conn-k">Reaches</span><span class="conn-sys">${systems
          .map((s) => `<span class="sysbadge">${escapeHtml(s)}</span>`)
          .join("")}</span></div>
        <p class="conn-note">One server, all of the above. Tools are prefixed by system — <span class="mono">postgres_*</span>, <span class="mono">prom_*</span>, <span class="mono">github_*</span> — so which system a tool belongs to is always clear. Call <span class="mono">devops_status</span> to list what's enabled.</p>`
      : "";
    const cfg = JSON.stringify(
      { mcpServers: { "ultimate-devops": { type: "http", url: endpoint, headers: { Authorization: `Bearer ${token}` } } } },
      null,
      2,
    );
    const smoke =
      `curl -s ${endpoint} \\\n` +
      `  -H "Authorization: Bearer ${token}" \\\n` +
      `  -H "Content-Type: application/json" \\\n` +
      `  -H "Accept: application/json, text/event-stream" \\\n` +
      `  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'`;
    const cli = `claude mcp add ultimate-devops --transport http ${endpoint} \\\n  --header "Authorization: Bearer ${token}"`;
    return `
      <div class="panel" id="connect">
        <div class="panel-h"><span class="pi"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m9 8-4 4 4 4M15 8l4 4-4 4"/></svg></span><h2>Connect a client</h2></div>
        <div class="conn">
          <div class="conn-row"><span class="conn-k">Endpoint</span><code class="mono">${escapeHtml(endpoint)}</code></div>
          <div class="conn-row"><span class="conn-k">Auth</span><code class="mono">Authorization: Bearer ${escapeHtml(token)}</code></div>
          ${reaches}
        </div>
        <p class="conn-lbl">Claude Code CLI</p>
        <pre class="code">${escapeHtml(cli)}</pre>
        <p class="conn-lbl">MCP client config (Claude Desktop, Cursor, …)</p>
        <pre class="code">${escapeHtml(cfg)}</pre>
        <p class="conn-lbl">Smoke test</p>
        <pre class="code">${escapeHtml(smoke)}</pre>
      </div>`;
  };

  // Per-system connect config (right-side drawer). Keyed by integration name;
  // each entry is a single-system client setup pointing at the shared endpoint.
  const sysConnectData = (active: string[], endpoint: string): string => {
    const map: Record<string, { label: string; prefix: string; cli: string; cfg: string }> = {};
    for (const n of active) {
      const server = `devops-${n}`;
      // Path-scoped URL: /mcp/<system> narrows this client to one system, so any
      // valid key works — no per-system scoped key required.
      const url = `${endpoint}/${n}`;
      const ph = "<YOUR_API_KEY>";
      map[n] = {
        label: prettyName(n),
        prefix: toolWildcard(n),
        cli: `claude mcp add ${server} --transport http ${url} \\\n  --header "Authorization: Bearer ${ph}"`,
        cfg: JSON.stringify(
          { mcpServers: { [server]: { type: "http", url, headers: { Authorization: `Bearer ${ph}` } } } },
          null,
          2,
        ),
      };
    }
    // Guard against "</script>" breaking out of the inline script block.
    return JSON.stringify(map).replace(/</g, "\\u003c");
  };

  const sysDrawer = (active: string[], endpoint: string): string => `
      <div class="drawer-back" id="dback"></div>
      <aside class="drawer" id="sysdrawer" aria-hidden="true" aria-label="Connect a system">
        <div class="drawer-h"><h3 id="d-title">Connect</h3><button type="button" class="drawer-x" id="dclose" aria-label="Close">✕</button></div>
        <div class="drawer-body">
          <p class="conn-note" id="d-note"></p>
          <p class="conn-lbl">Claude Code CLI</p>
          <pre class="code" id="d-cli"></pre>
          <p class="conn-lbl">MCP client config</p>
          <pre class="code" id="d-cfg"></pre>
          <p class="conn-note">The <span class="mono">/mcp/<span id="d-scope"></span></span> path already scopes this client to <b id="d-scope2"></b> — any valid key works. Want a key that stays <b id="d-scope3"></b>-only on every URL? Scope it in the “Create a key” panel above.</p>
        </div>
      </aside>
      <script>
      (function(){
        var SYS=JSON.parse(${JSON.stringify(sysConnectData(active, endpoint))});
        var d=document.getElementById('sysdrawer'),b=document.getElementById('dback');
        function open(n){var s=SYS[n];if(!s)return;
          document.getElementById('d-title').textContent='Connect · '+s.label;
          document.getElementById('d-note').textContent='This client will see only '+s.label+'’s tools ('+s.prefix+').';
          document.getElementById('d-cli').textContent=s.cli;
          document.getElementById('d-cfg').textContent=s.cfg;
          document.getElementById('d-scope').textContent=n;
          document.getElementById('d-scope2').textContent=s.label;
          document.getElementById('d-scope3').textContent=s.label;
          d.classList.add('open');b.classList.add('open');d.setAttribute('aria-hidden','false');}
        function close(){d.classList.remove('open');b.classList.remove('open');d.setAttribute('aria-hidden','true');}
        document.querySelectorAll('.scard[data-sys]').forEach(function(c){
          c.addEventListener('click',function(){open(c.getAttribute('data-sys'));});
          c.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();open(c.getAttribute('data-sys'));}});});
        document.getElementById('dclose').addEventListener('click',close);
        b.addEventListener('click',close);
        document.addEventListener('keydown',function(e){if(e.key==='Escape')close();});
      })();
      </script>`;

  function dashboardPage(session: Session, keys: ApiKeyRecord[], health: Record<string, string> = {}, endpoint = "http://localhost:PORT/mcp"): string {
    const admin = canWrite(session.role);
    const rows =
      keys.length === 0
        ? `<tr><td colspan="7"><div class="empty"><div class="big">No keys yet</div>Create your first key above to start calling the gateway.</div></td></tr>`
        : keys
            .map((k) => {
              const expired = !!k.expiresAt && Date.parse(k.expiresAt) <= Date.now();
              const status = k.revoked
                ? `<span class="pill bad">revoked</span>`
                : expired
                  ? `<span class="pill bad">expired</span>`
                  : `<span class="pill ok">active</span>`;
              const rw = k.allowWrites
                ? `<span class="badge">read · write</span>`
                : `<span class="badge read">read</span>`;
              const scope = k.tools && k.tools.length
                ? `<span class="badge scope">${k.tools.length} system${k.tools.length > 1 ? "s" : ""}</span>`
                : `<span class="badge allsys">all systems</span>`;
              const perms = `${rw} ${scope}`;
              const revokeBtn = k.revoked
                ? ""
                : `<form method="post" action="${escapeHtml(`${basePath}/keys/${encodeURIComponent(k.id)}/revoke`)}" onsubmit="return confirm('Revoke this key? Any client using it will stop working immediately.')">
                     <input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}">
                     <button type="submit" class="btn danger">Revoke</button>
                   </form>`;
              return `<tr>
                <td><span class="kname">${escapeHtml(k.name)}</span></td>
                <td class="date">${escapeHtml(fmtDate(k.createdAt))}</td>
                <td class="date">${escapeHtml(k.lastUsedAt ? fmtDate(k.lastUsedAt) : "—")}</td>
                <td class="date">${escapeHtml(k.expiresAt ? fmtDate(k.expiresAt) : "never")}</td>
                <td>${perms}</td>
                <td>${status}</td>
                <td class="right">${revokeBtn}</td>
              </tr>`;
            })
            .join("");

    const writesField = admin
      ? `<label class="check"><input type="checkbox" name="allowWrites"> Allow <strong>writes</strong> — this key may call mutating tools and perform write operations.</label>`
      : `<p class="check hint">This key will be <strong>read-only</strong>. Minting write-capable keys requires the editor or admin role.</p>`;

    const st = opts.status ?? { version: "?", writesAllowed: false, supported: [] as string[], active: [] as string[] };
    const scopeField = st.active.length
      ? `<div class="scopebox">
          <div class="scopelabel">Scope to systems <span class="scopehint">— leave all unchecked for full access to every enabled tool</span></div>
          <div class="scopegrid">
            ${st.active
              .map((n) => `<label class="scopechk"><input type="checkbox" name="scope" value="${escapeHtml(n)}">${sysMono(n)}<span>${escapeHtml(prettyName(n))}</span></label>`)
              .join("")}
          </div>
        </div>`
      : "";
    const ic = {
      layers: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5M3 8v8l9 5 9-5V8"/></svg>`,
      pen: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 20h9"/><path d="M16.5 3.5a2 2 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z"/></svg>`,
      code: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m9 8-4 4 4 4M15 8l4 4-4 4"/></svg>`,
      cal: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v4M16 3v4"/></svg>`,
      grid: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>`,
      key: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="8" cy="8" r="4"/><path d="M11 11l9 9M17 17l2-2M15 19l2-2"/></svg>`,
    };

    const statcards = `
      <div class="statcards">
        <div class="statcard"><div class="top"><span class="si" style="background:var(--accent-weak);color:var(--accent)">${ic.layers}</span><div><div class="kl">Systems connected</div><div class="vl">${st.active.length}</div><div class="s2">${st.active.length === 1 ? "integration wired to this gateway" : "integrations wired to this gateway"}</div></div></div></div>
        <div class="statcard"><div class="top"><span class="si" style="background:var(--ok-weak);color:var(--ok)">${ic.pen}</span><div><div class="kl">Writes</div><div class="vl ${st.writesAllowed ? "ok" : ""}">${st.writesAllowed ? "Enabled" : "Read-only"}</div><div class="s2">${st.writesAllowed ? "Write keys allowed" : "Read tools only"}</div></div></div></div>
        <div class="statcard"><div class="top"><span class="si" style="background:var(--accent-weak);color:var(--accent)">${ic.code}</span><div><div class="kl">Version</div><div class="vl mono">v${escapeHtml(st.version)}</div><div class="s2">Gateway version</div></div></div></div>
        <div class="statcard"><div class="top"><span class="si" style="background:var(--warn-weak);color:var(--warn)">${ic.cal}</span><div><div class="kl">Keys created</div><div class="vl">${keys.length}</div><div class="s2">${keys.length === 0 ? "No active keys yet" : "in this account"}</div></div></div></div>
      </div>`;

    const systemsPanel = `
      <div class="panel" id="systems">
        <div class="panel-h"><span class="pi">${ic.grid}</span><h2>Connected systems</h2><span class="count">${st.active.length} active</span></div>
        <div class="sgrid">
          ${st.supported.filter((n) => st.active.includes(n)).map((n) => systemCard(n, new Set(st.active), health, true)).join("") || '<div class="empty">No systems are connected on this gateway yet.</div>'}
        </div>
      </div>`;

    const main = `
      <div class="pagehead"><div>
        <span class="eyebrow">Account · API Keys</span>
        <h1>Your API keys</h1>
        <p class="sub">Keys authenticate you to the gateway's <span class="mono">/mcp</span> endpoint. Each secret is shown once at creation and stored only as a SHA-256 hash.</p>
      </div></div>

      ${statcards}
      ${systemsPanel}

      <div class="panel">
        <div class="panel-h"><span class="pi">${ic.key}</span><h2>Create a key</h2></div>
        <form method="post" action="${escapeHtml(`${basePath}/keys`)}" class="create">
          <input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}">
          <div class="field">
            <label for="k-name">Name</label>
            <input id="k-name" type="text" name="name" maxlength="200" required placeholder="e.g. ci-pipeline" autocomplete="off">
          </div>
          <div class="field">
            <label for="k-exp">Expiry</label>
            <select id="k-exp" name="expiryDays">
              <option value="">Never</option><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option><option value="365">1 year</option>
            </select>
          </div>
          <button type="submit" class="btn primary">Create key</button>
          ${writesField}
          ${scopeField}
        </form>
      </div>

      <div class="panel">
        <div class="panel-h"><span class="pi">${ic.key}</span><h2>Active &amp; past keys</h2><span class="count">${keys.length}</span></div>
        <div class="tablewrap">
          <table>
            <thead><tr><th>Name</th><th>Created</th><th>Last used</th><th>Expires</th><th>Permissions</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>

      ${connectPanel(endpoint, "<YOUR_API_KEY>", st.active.map(prettyName))}
      ${st.active.length ? sysDrawer(st.active, endpoint) : ""}`;
    return appShell("API keys", main, { name: session.name, basePath, active: st.active, supported: st.supported, role: roleLabel(session.role), nav: "api-keys", crumb: "api-keys" });
  }

  const IC2 = {
    bolt: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/></svg>`,
    grid: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>`,
    cal: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v4M16 3v4"/></svg>`,
    list: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>`,
    chart: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>`,
    gear: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/></svg>`,
  };
  function overviewPage(session: Session, health: Record<string, string>): string {
    const st = opts.status ?? { version: "?", writesAllowed: false, supported: [] as string[], active: [] as string[] };
    const m = opts.metrics ? opts.metrics() : { totalCalls: 0, totalErrors: 0, uptimeSeconds: 0, tools: [] };
    const recent = (opts.auditFeed ? opts.auditFeed() : []).slice(0, 8);
    const errRate = m.totalCalls ? ((m.totalErrors / m.totalCalls) * 100).toFixed(1) : "0";
    const activeSet = new Set(st.active);
    const upCount = st.active.filter((n) => health[n] === "up").length;
    const tiles = `<div class="statcards">
      <div class="statcard"><div class="top"><span class="si" style="background:var(--accent-weak);color:var(--accent)">${IC2.chart}</span><div><div class="kl">Tool calls</div><div class="vl">${m.totalCalls}</div><div class="s2">since start</div></div></div></div>
      <div class="statcard"><div class="top"><span class="si" style="background:${Number(errRate) > 0 ? "var(--crit-weak)" : "var(--ok-weak)"};color:${Number(errRate) > 0 ? "var(--crit)" : "var(--ok)"}">${IC2.bolt}</span><div><div class="kl">Error rate</div><div class="vl">${errRate}%</div><div class="s2">${m.totalErrors} errors</div></div></div></div>
      <div class="statcard"><div class="top"><span class="si" style="background:var(--ok-weak);color:var(--ok)">${IC2.grid}</span><div><div class="kl">Systems up</div><div class="vl">${upCount} / ${st.active.length}</div><div class="s2">reachable now</div></div></div></div>
      <div class="statcard"><div class="top"><span class="si" style="background:var(--accent-weak);color:var(--accent)">${IC2.cal}</span><div><div class="kl">Uptime</div><div class="vl">${fmtUptime(m.uptimeSeconds)}</div><div class="s2">this process</div></div></div></div>
    </div>`;
    const activity = recent.length
      ? recent.map((r) => `<div class="feed-row"><span class="ft mono">${escapeHtml(r.tool)}</span><span class="fk">${escapeHtml(r.key)}</span><span class="fout ${escapeHtml(r.outcome)}">${escapeHtml(r.outcome)}</span><span class="fd">${escapeHtml(fmtTime(r.ts))}</span></div>`).join("")
      : `<div class="empty" style="padding:26px">No activity yet — call a tool through /mcp.</div>`;
    const main = `
      <div class="pagehead"><div><span class="eyebrow">Dashboard · Overview</span><h1>Overview</h1><p class="sub">Live health and activity across your gateway.</p></div></div>
      ${tiles}
      <div class="cols2">
        <div class="panel"><div class="panel-h"><span class="pi">${IC2.list}</span><h2>Recent activity</h2><a class="link" href="${escapeHtml(`${basePath}/audit`)}">View all →</a></div><div class="feed">${activity}</div></div>
        <div class="panel"><div class="panel-h"><span class="pi">${IC2.grid}</span><h2>Systems health</h2><span class="count">${upCount} up</span></div><div class="sgrid sgrid-sm">${st.supported.filter((n) => activeSet.has(n)).map((n) => systemCard(n, activeSet, health)).join("") || '<div class="empty">No systems active.</div>'}</div></div>
      </div>`;
    return appShell("Overview", main, { name: session.name, basePath, active: st.active, supported: st.supported, role: roleLabel(session.role), nav: "overview", crumb: "overview" });
  }

  function auditPage(session: Session): string {
    const st = opts.status ?? { version: "?", writesAllowed: false, supported: [] as string[], active: [] as string[] };
    const recs = opts.auditFeed ? opts.auditFeed() : [];
    const c: Record<string, number> = { allowed: 0, denied: 0, error: 0, "dry-run": 0 };
    for (const r of recs) c[r.outcome] = (c[r.outcome] ?? 0) + 1;
    const chips = `<div class="chips"><span class="chip">${recs.length} events</span><span class="chip ok">${c.allowed} allowed</span><span class="chip bad">${c.denied} denied</span><span class="chip warn">${c["dry-run"]} dry-run</span><span class="chip bad">${c.error} error</span></div>`;
    const body = recs.length
      ? recs.map((r) => `<tr class="arow" data-s="${escapeHtml(`${r.tool} ${r.key} ${r.outcome}`.toLowerCase())}"><td class="date">${escapeHtml(fmtTime(r.ts))}</td><td><span class="kname mono">${escapeHtml(r.tool)}</span></td><td>${escapeHtml(r.key)}</td><td>${r.write ? '<span class="badge">write</span>' : '<span class="badge read">read</span>'}</td><td><span class="pill ${r.outcome === "allowed" ? "ok" : r.outcome === "dry-run" ? "warnp" : "bad"}">${escapeHtml(r.outcome)}</span></td><td class="date">${Math.round(r.durationMs)}ms</td><td class="fd">${r.reason ? escapeHtml(r.reason) : ""}</td></tr>`).join("")
      : `<tr><td colspan="7"><div class="empty"><div class="big">No audit events yet</div>Call a tool through /mcp and it appears here.</div></td></tr>`;
    const main = `
      <div class="pagehead"><div><span class="eyebrow">Governance · Audit</span><h1>Audit logs</h1><p class="sub">Every tool call — who, what, and outcome. Recent buffer only (last 500, resets on restart); ship stdout to your SIEM for durable audit.</p></div></div>
      ${chips}
      <div class="panel">
        <input class="searchbox" type="text" placeholder="Search tool, key, outcome…" oninput="var q=this.value.toLowerCase();document.querySelectorAll('.arow').forEach(function(r){r.style.display=r.getAttribute('data-s').indexOf(q)>-1?'':'none';});">
        <div class="tablewrap"><table><thead><tr><th>Time</th><th>Tool</th><th>Key</th><th>Type</th><th>Outcome</th><th>Duration</th><th>Reason</th></tr></thead><tbody>${body}</tbody></table></div>
      </div>`;
    return appShell("Audit logs", main, { name: session.name, basePath, active: st.active, supported: st.supported, role: roleLabel(session.role), nav: "audit", crumb: "audit-logs" });
  }

  function sparkline(points: Array<{ calls: number }>): string {
    if (!points.length) return `<div class="empty" style="padding:24px">No samples yet — the trend appears after ~15s of tool activity.</div>`;
    const w = 800;
    const h = 90;
    const max = Math.max(1, ...points.map((p) => p.calls));
    const step = points.length > 1 ? w / (points.length - 1) : w;
    const pts = points.map((p, i) => `${(i * step).toFixed(1)},${(h - (p.calls / max) * (h - 8) - 4).toFixed(1)}`).join(" ");
    return `<svg viewBox="0 0 ${w} ${h}" class="spark" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
  }

  function usagePage(session: Session): string {
    const st = opts.status ?? { version: "?", writesAllowed: false, supported: [] as string[], active: [] as string[] };
    const m = opts.metrics ? opts.metrics() : { totalCalls: 0, totalErrors: 0, uptimeSeconds: 0, tools: [] };
    const series = opts.series ? opts.series() : [];
    const errRate = m.totalCalls ? ((m.totalErrors / m.totalCalls) * 100).toFixed(1) : "0";
    const maxCalls = Math.max(1, ...m.tools.map((t) => t.calls));
    const tiles = `<div class="statcards">
      <div class="statcard"><div class="top"><span class="si" style="background:var(--accent-weak);color:var(--accent)">${IC2.chart}</span><div><div class="kl">Total calls</div><div class="vl">${m.totalCalls}</div></div></div></div>
      <div class="statcard"><div class="top"><span class="si" style="background:var(--crit-weak);color:var(--crit)">${IC2.bolt}</span><div><div class="kl">Errors</div><div class="vl">${m.totalErrors}</div></div></div></div>
      <div class="statcard"><div class="top"><span class="si" style="background:var(--warn-weak);color:var(--warn)">${IC2.bolt}</span><div><div class="kl">Error rate</div><div class="vl">${errRate}%</div></div></div></div>
      <div class="statcard"><div class="top"><span class="si" style="background:var(--accent-weak);color:var(--accent)">${IC2.cal}</span><div><div class="kl">Uptime</div><div class="vl">${fmtUptime(m.uptimeSeconds)}</div></div></div></div>
    </div>`;
    const rows = m.tools.length
      ? m.tools.map((t) => { const er = t.calls ? ((t.errors / t.calls) * 100).toFixed(1) : "0"; return `<tr><td><span class="kname mono">${escapeHtml(t.tool)}</span></td><td><div class="ubar"><i style="width:${((t.calls / maxCalls) * 100).toFixed(0)}%"></i></div></td><td class="date">${t.calls}</td><td class="date">${t.errors}</td><td class="date">${er}%</td><td class="date">${t.avgMs.toFixed(0)}ms</td></tr>`; }).join("")
      : `<tr><td colspan="6"><div class="empty"><div class="big">No tool calls yet</div>Usage appears once agents start calling tools.</div></td></tr>`;
    const main = `
      <div class="pagehead"><div><span class="eyebrow">Observability · Usage</span><h1>Usage &amp; metrics</h1><p class="sub">Per-tool call volume, errors and latency — the same data <span class="mono">/metrics</span> exposes for Prometheus.</p></div></div>
      ${tiles}
      <div class="panel"><div class="panel-h"><span class="pi">${IC2.chart}</span><h2>Calls over time</h2><span class="count">${series.length} samples</span></div>${sparkline(series)}</div>
      <div class="panel"><div class="panel-h"><span class="pi">${IC2.list}</span><h2>By tool</h2><span class="count">${m.tools.length}</span></div>
        <div class="tablewrap"><table><thead><tr><th>Tool</th><th>Volume</th><th>Calls</th><th>Errors</th><th>Error rate</th><th>Avg latency</th></tr></thead><tbody>${rows}</tbody></table></div>
      </div>`;
    return appShell("Usage & metrics", main, { name: session.name, basePath, active: st.active, supported: st.supported, role: roleLabel(session.role), nav: "usage", crumb: "usage" });
  }

  function settingsPage(session: Session): string {
    const st = opts.status ?? { version: "?", writesAllowed: false, supported: [] as string[], active: [] as string[] };
    const rows = (opts.settings ?? []).map(([k, v]) => `<div class="setrow"><div class="setk">${escapeHtml(k)}</div><div class="setv mono">${escapeHtml(v)}</div></div>`).join("");
    const main = `
      <div class="pagehead"><div><span class="eyebrow">Configuration · Settings</span><h1>Settings</h1><p class="sub">Read-only. The gateway is env-driven — change these via environment variables and restart.</p></div></div>
      <div class="panel"><div class="panel-h"><span class="pi">${IC2.gear}</span><h2>Gateway configuration</h2></div><div class="setlist">${rows || '<div class="empty">No settings.</div>'}</div></div>`;
    return appShell("Settings", main, { name: session.name, basePath, active: st.active, supported: st.supported, role: roleLabel(session.role), nav: "settings", crumb: "settings" });
  }

  function secretPage(session: Session, record: ApiKeyRecord, secret: string, endpoint = "http://localhost:PORT/mcp"): string {
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
        <p><a href="${escapeHtml(basePath)}">← Back to your keys</a></p>
      </section>

      ${connectPanel(
        endpoint,
        secret,
        (record.tools
          ? (opts.status?.active ?? []).filter((n) => record.tools!.includes(toolWildcard(n)))
          : (opts.status?.active ?? [])
        ).map(prettyName),
      )}
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

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(11, 19) + "Z";
}

function fmtUptime(sec: number): string {
  const s = Math.floor(sec);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
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

// Integrations that expose write/mutating tools (the rest are read-only) — drives
// the Write pill on each system card.
const WRITE_CAPABLE = new Set([
  "postgres", "mongodb", "neo4j", "redis", "kafka", "kubernetes", "grafana", "datadog",
  "argocd", "gitlab", "github", "bitbucket", "jira", "temporal", "pagerduty", "sentry",
  "jenkins", "slack", "vault", "pinecone", "docker",
]);
const PRETTY: Record<string, string> = {
  postgres: "Postgres", mongodb: "MongoDB", neo4j: "Neo4j", elasticsearch: "Elasticsearch",
  kafka: "Kafka", redis: "Redis", kubernetes: "Kubernetes", grafana: "Grafana", datadog: "Datadog",
  prometheus: "Prometheus", argocd: "ArgoCD", gitlab: "GitLab", github: "GitHub", bitbucket: "Bitbucket",
  jira: "Jira", playwright: "Playwright", temporal: "Temporal", pagerduty: "PagerDuty", sentry: "Sentry",
  jenkins: "Jenkins", slack: "Slack", vault: "Vault", pinecone: "Pinecone", kubecost: "Kubecost",
  docker: "Docker", helm: "Helm", trivy: "Trivy", sonarqube: "SonarQube",
};
const prettyName = (n: string): string => PRETTY[n] ?? n.charAt(0).toUpperCase() + n.slice(1);

function hueOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}
const sysMono = (n: string): string => {
  const b = BRAND_ICONS[n];
  if (b) return `<span class="mono2" style="background:#${b[0]}"><svg viewBox="0 0 24 24" fill="#fff"><path d="${b[1]}"/></svg></span>`;
  return `<span class="mono2" style="background:hsl(${hueOf(n)} 58% 47%)">${escapeHtml(prettyName(n).charAt(0))}</span>`;
};

const SVG = {
  term: `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 4 4-4 4M12 16h7"/></svg>`,
  shield: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3Z"/><path d="m9.3 12 1.9 1.9L15 10"/></svg>`,
  layers: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5M3 8v8l9 5 9-5V8"/></svg>`,
  bolt: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/></svg>`,
  key: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="4"/><path d="M11 11l9 9M17 17l2-2M15 19l2-2"/></svg>`,
  eye: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>`,
  user: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>`,
  lock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>`,
};

/** Split-screen auth layout: marketing panel + a form card on the right. */
function authPage(title: string, right: string): string {
  const trusted = ["kubernetes", "docker", "github", "gitlab", "redis"].map(sysMono).join("");
  const feat = (icon: string, t: string, d: string): string =>
    `<div class="feat"><div class="fi">${icon}</div><div><div class="ft">${t}</div><div class="fd">${d}</div></div></div>`;
  return `${head(title)}
<body>
<div class="auth">
  <div class="left">
    <div class="brandbig"><span class="mk">${SVG.term}</span>Ultimate <span class="ac">DevOps</span> MCP</div>
    <div class="lead">One Console. All MCPs. Total Control.</div>
    <p class="leadsub">Securely manage your MCP servers, API keys, and integrations from a single powerful console.</p>
    ${feat(SVG.shield, "Secure &amp; Encrypted", "Enterprise-grade security to keep your data and keys safe.")}
    ${feat(SVG.layers, "Unified Management", "Manage all your MCP systems, keys and permissions in one place.")}
    ${feat(SVG.bolt, "Write Capable", "Create and manage write-enabled keys with fine-grained control.")}
    <div class="trust"><div class="tl">Trusted by DevOps teams to power their automation layer</div><div class="tr">${trusted}<span class="more">+ More</span></div></div>
  </div>
  <div class="right"><div class="rcard">${right}</div></div>
</div>
<script>
(function(){var e=document.getElementById('eye'),i=document.getElementById('tok');if(e&&i)e.addEventListener('click',function(){i.type=i.type==='password'?'text':'password';});})();
</script>
</body>
</html>`;
}

/** Shared <head> (favicon + theme-aware CSS) for every console page. */
function head(title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · MCP Gateway</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%236366F1'/%3E%3Ccircle cx='16' cy='16' r='10' fill='none' stroke='white' stroke-opacity='0.55' stroke-width='2'/%3E%3Ccircle cx='16' cy='16' r='5.5' fill='white'/%3E%3C/svg%3E">
<script>try{var t=localStorage.getItem('udm_theme');if(t)document.documentElement.setAttribute('data-theme',t);}catch(e){}</script>
<style>
  :root {
    color-scheme: light dark;
    --ink:#F4F6FB; --panel:#FFFFFF; --panel-2:#EFF2F8; --line:#E1E7F0; --line-soft:#EDF1F7;
    --text:#141B2B; --muted:#5A6678; --faint:#8A96A8;
    --accent:#6366F1; --accent-weak:#ECEDFF;
    --ok:#159A67; --ok-weak:#E1F6EC; --crit:#D14360; --crit-weak:#FBE4E9; --warn:#B4791C; --warn-weak:#F7ECD6;
    --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --mono: ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Code", Menlo, Consolas, monospace;
  }
  :root[data-theme="dark"] {
    --ink:#0C1017; --panel:#141A24; --panel-2:#1B2330; --line:#28313F; --line-soft:#1E2632;
    --text:#E9EEF6; --muted:#93A0B4; --faint:#66738A;
    --accent:#7C82FF; --accent-weak:#23264C;
    --ok:#43C08B; --ok-weak:#12291F; --crit:#E76A80; --crit-weak:#331A22; --warn:#E2A94A; --warn-weak:#2E2513;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme]) {
      --ink:#0C1017; --panel:#141A24; --panel-2:#1B2330; --line:#28313F; --line-soft:#1E2632;
      --text:#E9EEF6; --muted:#93A0B4; --faint:#66738A;
      --accent:#7C82FF; --accent-weak:#23264C;
      --ok:#43C08B; --ok-weak:#12291F; --crit:#E76A80; --crit-weak:#331A22; --warn:#E2A94A; --warn-weak:#2E2513;
    }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--ink); color:var(--text); font-family:var(--sans); line-height:1.55; -webkit-font-smoothing:antialiased; }
  a { color:var(--accent); text-decoration:none; }
  a:hover { text-decoration:underline; }
  .mono { font-family:var(--mono); }
  code { font-family:var(--mono); }
  :focus-visible { outline:2px solid var(--accent); outline-offset:2px; }

  .btn { font:inherit; font-size:13px; cursor:pointer; border-radius:9px; border:1px solid var(--line); background:var(--panel); color:var(--text); padding:8px 14px; transition:border-color .15s, background .15s, filter .15s; }
  .btn:hover { border-color:var(--accent); }
  .btn.primary { background:var(--accent); border-color:var(--accent); color:#fff; font-weight:600; }
  .btn.primary:hover { filter:brightness(1.08); }
  .btn.danger { border-color:color-mix(in srgb, var(--crit) 45%, transparent); color:var(--crit); background:transparent; padding:6px 12px; font-size:12.5px; }
  .btn.danger:hover { background:var(--crit-weak); }

  /* ---- auth / message pages (simple top bar) ---- */
  .topbar { position:sticky; top:0; z-index:10; background:color-mix(in srgb, var(--ink) 85%, transparent); backdrop-filter:blur(10px); border-bottom:1px solid var(--line-soft); }
  .topbar .row { max-width:960px; margin:0 auto; display:flex; align-items:center; gap:12px; height:56px; padding:0 20px; }
  .brand { display:flex; align-items:center; gap:9px; font-weight:700; font-size:15px; color:var(--text); }
  .brand:hover { text-decoration:none; }
  .brand .mark { width:30px; height:30px; border-radius:8px; background:var(--accent); display:grid; place-items:center; }
  .spacer { flex:1; }
  .userchip { font-size:13px; color:var(--muted); } .userchip .nm { color:var(--text); font-weight:550; }
  .wrap { max-width:960px; margin:0 auto; padding:32px 20px 72px; }

  .eyebrow { font-family:var(--mono); font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:var(--accent); }
  h1 { font-size:26px; letter-spacing:-.02em; margin:6px 0 6px; font-weight:680; text-wrap:balance; }
  .sub { color:var(--muted); font-size:14px; margin:0 0 8px; max-width:70ch; }
  .sub .mono { color:var(--text); background:var(--panel-2); padding:1px 6px; border-radius:5px; font-size:12.5px; }

  .card { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:20px 22px; margin:16px 0; }
  .card h2 { font-size:15px; font-weight:620; margin:0 0 16px; display:flex; align-items:center; gap:9px; }
  .card h2 .count { font-family:var(--mono); font-size:12px; color:var(--muted); font-weight:500; background:var(--panel-2); border:1px solid var(--line-soft); padding:1px 9px; border-radius:999px; }

  .create { display:grid; grid-template-columns:1fr 200px auto; gap:16px; align-items:end; }
  @media (max-width:640px) { .create { grid-template-columns:1fr; } }
  .field { display:flex; flex-direction:column; gap:6px; }
  .field label { font-size:12px; color:var(--muted); font-weight:550; }
  input[type=text], input[type=number], input[type=password], select { font:inherit; padding:10px 12px; border:1px solid var(--line); border-radius:9px; background:var(--ink); color:var(--text); width:100%; }
  input::placeholder { color:var(--faint); }
  .check { grid-column:1 / -1; display:flex; align-items:center; gap:9px; font-size:13px; color:var(--muted); margin:0; }
  .check strong { color:var(--text); font-weight:600; }
  .check input { width:16px; height:16px; accent-color:var(--accent); }
  .check.hint { color:var(--faint); }

  .tablewrap { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; font-size:13.5px; }
  th { text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--faint); font-weight:600; padding:0 12px 12px; border-bottom:1px solid var(--line); white-space:nowrap; }
  td { padding:14px 12px; border-bottom:1px solid var(--line-soft); vertical-align:middle; }
  tbody tr:last-child td { border-bottom:0; }
  tbody tr:hover td { background:color-mix(in srgb, var(--accent) 5%, transparent); }
  td.right { text-align:right; }
  .kname { font-weight:600; }
  td.date { font-family:var(--mono); font-variant-numeric:tabular-nums; color:var(--muted); font-size:12.5px; white-space:nowrap; }

  .pill { display:inline-flex; align-items:center; gap:6px; font-size:11.5px; font-weight:600; padding:3px 10px; border-radius:999px; }
  .pill::before { content:""; width:6px; height:6px; border-radius:50%; background:currentColor; }
  .pill.ok { color:var(--ok); background:var(--ok-weak); } .pill.bad { color:var(--crit); background:var(--crit-weak); }
  .badge { font-family:var(--mono); font-size:10px; letter-spacing:.04em; text-transform:uppercase; color:var(--warn); background:var(--warn-weak); border-radius:5px; padding:2px 6px; vertical-align:middle; }
  .badge.read { color:var(--muted); background:var(--panel-2); }
  .badge.scope { color:var(--accent); background:var(--accent-weak); }
  .badge.allsys { color:var(--faint); background:var(--panel-2); }

  .scopebox { grid-column:1 / -1; margin-top:6px; border-top:1px solid var(--line-soft); padding-top:16px; }
  .scopelabel { font-size:12px; color:var(--muted); font-weight:600; margin-bottom:10px; }
  .scopelabel .scopehint { color:var(--faint); font-weight:400; }
  .scopegrid { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; }
  @media (max-width:820px){ .scopegrid{ grid-template-columns:repeat(2,1fr); } }
  .scopechk { display:flex; align-items:center; gap:8px; padding:8px 10px; border:1px solid var(--line-soft); border-radius:9px; font-size:12.5px; cursor:pointer; background:var(--ink); }
  .scopechk:hover { border-color:var(--accent); }
  .scopechk input { width:15px; height:15px; accent-color:var(--accent); }
  .scopechk .mono2 { width:22px; height:22px; border-radius:6px; }
  .scopechk .mono2 svg { width:13px; height:13px; }

  .empty { text-align:center; color:var(--muted); padding:44px 12px; font-size:13.5px; }
  .empty .big { font-size:15px; color:var(--text); font-weight:600; margin-bottom:4px; }
  .note { display:flex; gap:12px; align-items:flex-start; background:var(--warn-weak); border:1px solid color-mix(in srgb, var(--warn) 34%, transparent); color:var(--text); border-radius:11px; padding:13px 15px; font-size:13.5px; }
  .note-i { flex:none; width:20px; height:20px; border-radius:50%; background:var(--warn); color:#1a1206; font-weight:800; font-size:13px; display:grid; place-items:center; }
  .secret { display:flex; gap:10px; align-items:stretch; margin:16px 0 8px; }
  .secret code { flex:1; font-size:13.5px; background:var(--ink); border:1px solid var(--line); border-radius:10px; padding:13px 15px; word-break:break-all; user-select:all; display:flex; align-items:center; }
  .secret .btn { white-space:nowrap; }
  .usage { color:var(--muted); font-size:12.5px; margin:6px 0 18px; } .usage .mono { color:var(--text); }

  .conn { display:flex; flex-direction:column; gap:8px; margin-bottom:14px; }
  .conn-row { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
  .conn-k { flex:0 0 64px; font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; }
  .conn-row code { font-family:var(--mono); font-size:12.5px; background:var(--panel-2); border:1px solid var(--line-soft); border-radius:6px; padding:4px 9px; color:var(--text); word-break:break-all; }
  .conn-sys { display:flex; flex-wrap:wrap; gap:6px; }
  .sysbadge { font-size:11.5px; font-weight:600; background:var(--accent-weak); color:var(--accent); border-radius:999px; padding:2px 10px; }
  .conn-note { font-size:12px; color:var(--muted); margin:10px 0 2px; line-height:1.55; } .conn-note .mono { color:var(--text); background:var(--panel-2); padding:1px 5px; border-radius:5px; font-size:11.5px; }
  .conn-lbl { font-size:12px; font-weight:600; color:var(--muted); margin:14px 0 6px; }

  .scard.clickable { cursor:pointer; position:relative; transition:border-color .12s, box-shadow .12s, transform .12s; }
  .scard.clickable:hover { border-color:var(--accent); box-shadow:0 2px 14px rgba(99,102,241,.14); }
  .scard.clickable:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  .scard-cta { position:absolute; top:10px; right:12px; font-size:11px; font-weight:600; color:var(--accent); opacity:0; transition:opacity .12s; }
  .scard.clickable:hover .scard-cta, .scard.clickable:focus-visible .scard-cta { opacity:1; }
  .drawer-back { position:fixed; inset:0; background:rgba(15,17,26,.42); opacity:0; pointer-events:none; transition:opacity .18s; z-index:40; }
  .drawer-back.open { opacity:1; pointer-events:auto; }
  .drawer { position:fixed; top:0; right:0; height:100vh; width:min(440px,92vw); background:var(--panel); border-left:1px solid var(--line); box-shadow:-8px 0 40px rgba(15,17,26,.18); transform:translateX(100%); transition:transform .2s ease; z-index:41; display:flex; flex-direction:column; }
  .drawer.open { transform:translateX(0); }
  .drawer-h { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:18px 20px; border-bottom:1px solid var(--line-soft); }
  .drawer-h h3 { margin:0; font-size:15px; }
  .drawer-x { background:none; border:none; color:var(--muted); font-size:16px; cursor:pointer; padding:4px 8px; border-radius:6px; }
  .drawer-x:hover { background:var(--panel-2); color:var(--text); }
  .drawer-body { padding:18px 20px; overflow-y:auto; }
  .drawer-body pre.code { white-space:pre-wrap; word-break:break-all; }
  pre.code { margin:0; background:var(--panel-2); border:1px solid var(--line-soft); border-radius:8px; padding:12px 14px; font-family:var(--mono); font-size:12.5px; line-height:1.55; color:var(--text); overflow-x:auto; white-space:pre; }
  .msg { max-width:440px; margin:44px auto; text-align:center; }

  .login { max-width:400px; margin:7vh auto 0; }
  .login h1 { font-size:22px; }
  .loginform { display:flex; flex-direction:column; gap:15px; margin-top:2px; }
  .loginbtn { width:100%; padding:10px; margin-top:4px; }
  .loginerr { background:var(--crit-weak); border:1px solid color-mix(in srgb, var(--crit) 40%, transparent); color:var(--crit); border-radius:9px; padding:10px 12px; font-size:13px; margin-bottom:16px; }
  .ssorow { margin-top:16px; padding-top:16px; border-top:1px solid var(--line-soft); text-align:center; font-size:13px; }

  /* ---- split-screen auth ---- */
  .auth { min-height:100vh; display:grid; grid-template-columns:1.05fr .95fr; background:var(--ink); }
  @media (max-width:920px){ .auth{ grid-template-columns:1fr; } .auth .left{ display:none; } }
  .auth .left { color:#EAEEFF; padding:54px 52px; display:flex; flex-direction:column; background:radial-gradient(900px 520px at 18% -5%, #2b2f6b 0%, transparent 58%), linear-gradient(160deg,#161d47,#0a0e1c); }
  .brandbig { display:flex; align-items:center; gap:14px; font-size:26px; font-weight:750; letter-spacing:-.01em; }
  .brandbig .mk { width:52px; height:52px; border-radius:13px; background:linear-gradient(135deg,#6366F1,#4f46e5); display:grid; place-items:center; box-shadow:0 8px 24px rgba(80,70,230,.45); }
  .brandbig .mk svg { width:26px; height:26px; }
  .brandbig .ac { color:#9095ff; }
  .lead { font-size:20px; font-weight:700; margin:30px 0 10px; }
  .leadsub { color:#aeb6e0; font-size:14.5px; max-width:44ch; margin:0 0 28px; line-height:1.6; }
  .feat { display:flex; gap:14px; margin:16px 0; align-items:flex-start; }
  .feat .fi { width:46px; height:46px; border-radius:12px; background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.09); display:grid; place-items:center; color:#a6adf5; flex:none; }
  .feat .fi svg { width:22px; height:22px; }
  .feat .ft { font-weight:650; font-size:14.5px; }
  .feat .fd { color:#9aa2cf; font-size:13px; margin-top:2px; line-height:1.5; max-width:38ch; }
  .trust { margin-top:auto; background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.08); border-radius:14px; padding:16px 18px; }
  .trust .tl { text-align:center; font-size:12px; color:#9aa2cf; margin-bottom:12px; }
  .trust .tr { display:flex; align-items:center; justify-content:center; gap:12px; flex-wrap:wrap; }
  .trust .tr .mono2 { width:36px; height:36px; border-radius:10px; font-size:15px; }
  .trust .more { color:#9aa2cf; font-size:13px; font-weight:600; }

  .auth .right { display:flex; align-items:center; justify-content:center; padding:40px 32px; background:var(--panel); }
  .rcard { width:100%; max-width:400px; }
  .shieldi { width:52px; height:52px; border-radius:13px; background:var(--accent-weak); color:var(--accent); display:grid; place-items:center; margin-bottom:24px; }
  .shieldi svg { width:24px; height:24px; }
  .rcard h1 { font-size:30px; margin:6px 0 6px; }
  .rcard .rsub { color:var(--muted); font-size:14px; margin:0 0 26px; }
  .authform label { display:block; font-size:13.5px; font-weight:650; margin-bottom:4px; }
  .authform .fhint { color:var(--muted); font-size:13px; margin:0 0 12px; }
  .authform .fhint code { background:var(--panel-2); padding:1px 6px; border-radius:5px; font-size:12px; color:var(--text); }
  .authform .field2 { margin-bottom:16px; }
  .inputwrap { position:relative; }
  .inputwrap .lead-ic { position:absolute; left:14px; top:50%; transform:translateY(-50%); color:var(--faint); display:grid; place-items:center; pointer-events:none; }
  .inputwrap .lead-ic svg { width:18px; height:18px; }
  .inputwrap input { padding-left:42px; padding-right:44px; height:52px; border-radius:12px; }
  .inputwrap .eye { position:absolute; right:8px; top:50%; transform:translateY(-50%); background:none; border:0; cursor:pointer; color:var(--faint); padding:8px; display:grid; place-items:center; }
  .inputwrap .eye svg { width:19px; height:19px; }
  .btn.big { width:100%; height:52px; border-radius:12px; font-size:15px; margin-top:8px; display:flex; align-items:center; justify-content:center; gap:8px; }
  .btn.grad { background:linear-gradient(135deg,#6366F1,#4f46e5); border:0; color:#fff; font-weight:650; }
  .btn.grad:hover { filter:brightness(1.07); text-decoration:none; }
  .ordiv { display:flex; align-items:center; gap:14px; color:var(--faint); font-size:13px; margin:18px 0; }
  .ordiv::before, .ordiv::after { content:""; flex:1; height:1px; background:var(--line); }
  .secnote { text-align:center; color:var(--faint); font-size:12.5px; margin-top:22px; }

  /* ---- dashboard app shell ---- */
  .app { display:grid; grid-template-columns:250px 1fr; min-height:100vh; }
  @media (max-width:900px){ .app{ grid-template-columns:1fr; } .sidebar{ display:none; } }
  .sidebar { background:var(--panel); border-right:1px solid var(--line-soft); padding:16px 14px; display:flex; flex-direction:column; gap:16px; position:sticky; top:0; height:100vh; overflow-y:auto; }
  .logo { display:flex; align-items:center; gap:11px; font-weight:750; font-size:16px; padding:6px 8px; color:var(--text); }
  .logo .mark { width:34px; height:34px; border-radius:9px; background:linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 55%, #000)); display:grid; place-items:center; box-shadow:0 4px 12px color-mix(in srgb, var(--accent) 35%, transparent); }
  .navlabel { font-size:10px; letter-spacing:.09em; text-transform:uppercase; color:var(--faint); font-weight:700; padding:2px 10px; }
  .nav { display:flex; flex-direction:column; gap:2px; }
  .nav a { display:flex; align-items:center; gap:11px; padding:9px 11px; border-radius:9px; color:var(--muted); font-size:14px; font-weight:500; }
  .nav a:hover { background:var(--panel-2); text-decoration:none; color:var(--text); }
  .nav a.active { background:var(--accent-weak); color:var(--accent); font-weight:600; }
  .nav a svg { width:18px; height:18px; flex:none; }
  .side-sys { display:flex; flex-direction:column; gap:9px; padding:2px 10px; }
  .side-sys .r { display:flex; align-items:center; gap:9px; font-size:13px; color:var(--text); }
  .side-sys .r .g { margin-left:auto; width:8px; height:8px; border-radius:50%; background:var(--ok); }
  .side-link { padding:2px 10px; font-size:13px; font-weight:600; }
  .help { margin-top:auto; background:var(--panel-2); border:1px solid var(--line-soft); border-radius:12px; padding:14px; font-size:12.5px; color:var(--muted); }
  .help b { color:var(--text); }

  .main { display:flex; flex-direction:column; min-width:0; }
  .appbar { height:62px; border-bottom:1px solid var(--line-soft); display:flex; align-items:center; gap:14px; padding:0 26px; position:sticky; top:0; background:color-mix(in srgb, var(--ink) 88%, transparent); backdrop-filter:blur(10px); z-index:5; }
  .crumbs { display:flex; align-items:center; gap:9px; font-size:13px; color:var(--muted); font-family:var(--mono); }
  .crumbs .live { width:8px; height:8px; border-radius:50%; background:var(--ok); box-shadow:0 0 0 3px color-mix(in srgb, var(--ok) 22%, transparent); }
  .crumbs b { color:var(--text); font-weight:600; }
  .iconbtn { width:38px; height:38px; border-radius:9px; border:1px solid var(--line); background:var(--panel); display:grid; place-items:center; cursor:pointer; color:var(--muted); }
  .iconbtn:hover { color:var(--text); border-color:var(--accent); }
  .iconbtn svg { width:18px; height:18px; }
  .user { display:flex; align-items:center; gap:10px; }
  .avatar { width:36px; height:36px; border-radius:9px; background:var(--accent); color:#fff; display:grid; place-items:center; font-weight:700; font-size:13px; }
  .user .who .nm { font-size:13.5px; font-weight:600; } .user .who .role { font-size:11.5px; color:var(--faint); }

  .content { padding:26px 34px 72px; max-width:1560px; margin:0 auto; width:100%; }
  .pagehead { display:flex; justify-content:space-between; align-items:flex-start; gap:20px; }

  .statcards { display:grid; grid-template-columns:repeat(4,1fr); gap:16px; margin:22px 0; }
  @media (max-width:980px){ .statcards{ grid-template-columns:repeat(2,1fr); } }
  .statcard { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:18px; }
  .statcard .top { display:flex; align-items:flex-start; gap:13px; }
  .statcard .si { width:46px; height:46px; border-radius:12px; display:grid; place-items:center; flex:none; }
  .statcard .kl { font-size:10.5px; letter-spacing:.05em; text-transform:uppercase; color:var(--faint); font-weight:700; }
  .statcard .vl { font-size:25px; font-weight:750; margin-top:3px; font-variant-numeric:tabular-nums; letter-spacing:-.01em; }
  .statcard .vl.ok { color:var(--ok); }
  .statcard .s2 { font-size:12px; color:var(--muted); margin-top:6px; }
  .bar { height:6px; border-radius:4px; background:var(--panel-2); margin-top:11px; overflow:hidden; }
  .bar > i { display:block; height:100%; background:var(--accent); border-radius:4px; }

  .panel { background:var(--panel); border:1px solid var(--line); border-radius:16px; padding:22px 24px; margin:16px 0; }
  .panel-h { display:flex; align-items:center; gap:11px; margin-bottom:18px; }
  .panel-h .pi { width:34px; height:34px; border-radius:9px; background:var(--accent-weak); color:var(--accent); display:grid; place-items:center; }
  .panel-h .pi svg { width:18px; height:18px; }
  .panel-h h2 { font-size:16px; font-weight:660; margin:0; }
  .panel-h .count { font-size:12px; color:var(--ok); background:var(--ok-weak); border-radius:999px; padding:2px 10px; font-weight:600; }
  .panel-h .link { margin-left:auto; font-size:13px; font-weight:600; }

  .sgrid { display:grid; grid-template-columns:repeat(6,1fr); gap:12px; }
  @media (max-width:1180px){ .sgrid{ grid-template-columns:repeat(4,1fr); } }
  @media (max-width:820px){ .sgrid{ grid-template-columns:repeat(2,1fr); } }
  .scard { border:1px solid var(--line-soft); border-radius:12px; padding:13px; background:var(--ink); }
  .scard .hd { display:flex; align-items:center; gap:9px; margin-bottom:11px; }
  .mono2 { width:28px; height:28px; border-radius:8px; display:grid; place-items:center; color:#fff; font-weight:700; font-size:13px; flex:none; }
  .mono2 svg { width:17px; height:17px; }
  .scard .nm { font-size:13px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .scard .sd { margin-left:auto; width:9px; height:9px; border-radius:50%; background:var(--faint); flex:none; }
  .scard .sd.on { background:var(--ok); box-shadow:0 0 0 3px var(--ok-weak); }
  .rw { display:flex; gap:6px; }
  .rwp { flex:1; display:inline-flex; align-items:center; justify-content:center; gap:4px; font-size:11px; font-weight:600; padding:5px 6px; border-radius:7px; }
  .rwp.on { color:var(--ok); background:var(--ok-weak); }
  .rwp.off { color:var(--faint); background:var(--panel-2); }
  .scard .sd.down { background:var(--crit); box-shadow:0 0 0 3px var(--crit-weak); }
  .scard .sd.unk { background:var(--warn); box-shadow:0 0 0 3px var(--warn-weak); }
  .sgrid-sm { grid-template-columns:repeat(3,1fr); }
  @media (max-width:1180px){ .sgrid-sm{ grid-template-columns:repeat(2,1fr); } }

  .cols2 { display:grid; grid-template-columns:1fr 1.15fr; gap:16px; }
  @media (max-width:1000px){ .cols2{ grid-template-columns:1fr; } }
  .feed { display:flex; flex-direction:column; }
  .feed-row { display:flex; align-items:center; gap:12px; padding:11px 2px; border-bottom:1px solid var(--line-soft); font-size:13px; }
  .feed-row:last-child { border-bottom:0; }
  .feed-row .ft { font-weight:600; }
  .feed-row .fk { color:var(--muted); }
  .feed-row .fout { margin-left:auto; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.03em; }
  .feed-row .fout.allowed { color:var(--ok); } .feed-row .fout.denied, .feed-row .fout.error { color:var(--crit); } .feed-row .fout\.dry-run { color:var(--warn); }
  .feed-row .fd { color:var(--faint); font-family:var(--mono); font-size:11.5px; min-width:66px; text-align:right; }

  .chips { display:flex; flex-wrap:wrap; gap:9px; margin:0 0 4px; }
  .chip { font-size:12px; font-weight:600; padding:5px 12px; border-radius:999px; background:var(--panel); border:1px solid var(--line); color:var(--muted); }
  .chip.ok { color:var(--ok); background:var(--ok-weak); border-color:transparent; }
  .chip.bad { color:var(--crit); background:var(--crit-weak); border-color:transparent; }
  .chip.warn { color:var(--warn); background:var(--warn-weak); border-color:transparent; }
  .pill.warnp { color:var(--warn); background:var(--warn-weak); }
  .searchbox { width:100%; height:42px; margin-bottom:14px; border:1px solid var(--line); border-radius:10px; background:var(--ink); color:var(--text); padding:0 14px; font:inherit; font-size:13.5px; }

  .spark { width:100%; height:110px; display:block; }
  .ubar { height:8px; border-radius:4px; background:var(--panel-2); overflow:hidden; min-width:80px; }
  .ubar > i { display:block; height:100%; background:var(--accent); border-radius:4px; }

  .setlist { display:flex; flex-direction:column; }
  .setrow { display:flex; align-items:center; gap:16px; padding:12px 2px; border-bottom:1px solid var(--line-soft); font-size:13.5px; }
  .setrow:last-child { border-bottom:0; }
  .setk { color:var(--muted); min-width:230px; font-weight:550; }
  .setv { color:var(--text); font-size:13px; word-break:break-word; }
</style>
</head>`;
}

/** Auth / message pages: a simple top bar over a centered body. */
function page(title: string, body: string, opts: { name?: string; basePath?: string } = {}): string {
  const mark = `<span class="mark"><svg width="18" height="18" viewBox="0 0 32 32"><circle cx="16" cy="16" r="10" fill="none" stroke="white" stroke-opacity="0.6" stroke-width="2.5"/><circle cx="16" cy="16" r="5.5" fill="white"/></svg></span>`;
  const brand = opts.basePath
    ? `<a class="brand" href="${escapeHtml(opts.basePath)}">${mark}MCP Gateway</a>`
    : `<span class="brand">${mark}MCP Gateway</span>`;
  const right = opts.name
    ? `<span class="userchip"><span class="nm">${escapeHtml(opts.name)}</span></span><a class="btn" href="${escapeHtml(`${opts.basePath ?? ""}/logout`)}">Sign out</a>`
    : "";
  return `${head(title)}
<body>
<div class="topbar"><div class="row">${brand}<span class="spacer"></span>${right}</div></div>
<main class="wrap">${body}</main>
</body>
</html>`;
}

/** Dashboard shell: fixed sidebar + top app bar + main content. */
function appShell(
  title: string,
  main: string,
  ctx: { name: string; basePath: string; active: string[]; supported: string[]; nav?: string; crumb?: string; role?: string },
): string {
  const bp = escapeHtml(ctx.basePath);
  const at = ctx.nav ?? "api-keys";
  const initials = (ctx.name.match(/[A-Za-z0-9]/g) ?? ["u"]).slice(0, 2).join("").toUpperCase();
  const nav = (icon: string, label: string, active = false, href = bp) =>
    `<a href="${href}" class="${active ? "active" : ""}">${icon}<span>${label}</span></a>`;
  const I = {
    home: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>`,
    key: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="8" r="4"/><path d="M11 11l9 9M17 17l2-2M15 19l2-2"/></svg>`,
    list: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>`,
    chart: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>`,
    gear: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/></svg>`,
  };
  const sideSys = ctx.supported
    .filter((n) => ctx.active.includes(n))
    .slice(0, 6)
    .map((n) => `<div class="r">${sysMono(n)}<span>${escapeHtml(prettyName(n))}</span><span class="g"></span></div>`)
    .join("");
  return `${head(title)}
<body>
<div class="app">
  <aside class="sidebar">
    <div class="logo"><span class="mark"><svg width="20" height="20" viewBox="0 0 32 32"><circle cx="16" cy="16" r="10" fill="none" stroke="white" stroke-opacity="0.6" stroke-width="2.5"/><circle cx="16" cy="16" r="5.5" fill="white"/></svg></span>MCP Gateway</div>
    <div class="nav">
      <div class="navlabel">Main</div>
      ${nav(I.home, "Overview", at === "overview", `${bp}/overview`)}
      ${nav(I.key, "API Keys", at === "api-keys", bp)}
      ${nav(I.list, "Audit Logs", at === "audit", `${bp}/audit`)}
      ${nav(I.chart, "Usage &amp; Metrics", at === "usage", `${bp}/usage`)}
      ${nav(I.gear, "Settings", at === "settings", `${bp}/settings`)}
    </div>
    <div>
      <div class="navlabel">Connected systems · ${ctx.active.length} active</div>
      <div class="side-sys">${sideSys || '<div class="r" style="color:var(--faint)">None active</div>'}</div>
      <a class="side-link" href="#systems">View all systems →</a>
    </div>
    <div class="help"><b>Need help?</b><br>Check the docs or reach the team.</div>
  </aside>
  <div class="main">
    <div class="appbar">
      <span class="crumbs"><span class="live"></span>ultimate-devops <span>/</span> console <span>/</span> <b>${escapeHtml(ctx.crumb ?? "api-keys")}</b></span>
      <span class="spacer"></span>
      <button class="iconbtn" id="themeBtn" title="Toggle theme" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"/></svg></button>
      <div class="user"><span class="avatar">${escapeHtml(initials)}</span><span class="who"><div class="nm">${escapeHtml(ctx.name)}</div><div class="role">${escapeHtml(ctx.role ?? "Administrator")}</div></span><a class="btn" href="${bp}/logout">Sign out</a></div>
    </div>
    <div class="content">${main}</div>
  </div>
</div>
<script>
(function(){var K='udm_theme',r=document.documentElement,b=document.getElementById('themeBtn');
if(b)b.addEventListener('click',function(){var c=r.getAttribute('data-theme');
var m=c==='dark'?'light':c==='light'?'dark':(matchMedia('(prefers-color-scheme: dark)').matches?'light':'dark');
r.setAttribute('data-theme',m);try{localStorage.setItem(K,m);}catch(e){}});})();
</script>
</body>
</html>`;
}
