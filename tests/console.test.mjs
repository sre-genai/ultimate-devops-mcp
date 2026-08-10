import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Self-service key console: mounts, builds a correct PKCE authorize redirect,
// initializes its SQLite key store, rejects a forged callback, and does not
// become an auth bypass for /mcp. Full mint requires a browser+IdP round-trip;
// this covers the deterministic, security-relevant surface. Uses a mock IdP.
const MCP_PORT = 21000 + (process.pid % 400);
const IDP_PORT = 21500 + (process.pid % 400);
const ISSUER = `http://127.0.0.1:${IDP_PORT}`;
const BASE = `http://127.0.0.1:${MCP_PORT}/console`;
const DB = join(tmpdir(), `udm-console-${process.pid}.db`);

let idp;
let child;
let bootErr = "";

before(async () => {
  try { rmSync(DB); } catch { /* fresh */ }
  idp = http.createServer((req, res) => {
    if (req.url.startsWith("/.well-known/openid-configuration")) {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
      }));
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise((r) => idp.listen(IDP_PORT, r));

  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(AUTH_|MCP_)/.test(k)) delete env[k];
  child = spawn("node", ["dist/index.js"], {
    env: {
      ...env,
      MCP_HTTP_PORT: String(MCP_PORT),
      AUTH_OIDC_ISSUER: ISSUER,
      AUTH_OIDC_AUDIENCE: "udm",
      AUTH_OIDC_ADMIN_GROUPS: "platform-admins",
      AUTH_CONSOLE_ENABLED: "true",
      AUTH_OIDC_CLIENT_ID: "udm-console",
      AUTH_OIDC_CLIENT_SECRET: "shhh",
      AUTH_OIDC_REDIRECT_URI: `http://127.0.0.1:${MCP_PORT}/console/callback`,
      AUTH_SESSION_SECRET: "test-session-secret-0123456789abcdef",
      AUTH_KEY_STORE: "sqlite",
      AUTH_KEYSTORE_SQLITE_PATH: DB,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (d) => { bootErr += d.toString(); });
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${MCP_PORT}/healthz`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not become healthy.\n${bootErr}`);
});

after(() => {
  child?.kill();
  idp?.close();
  try { rmSync(DB); } catch { /* ignore */ }
});

test("gateway boots with the console + sqlite key store enabled", () => {
  assert.equal(child.exitCode, null, `should still be running; boot log:\n${bootErr}`);
  assert.ok(existsSync(DB), "sqlite key store file should be created");
});

test("console index mounts (not 404)", async () => {
  const r = await fetch(BASE, { redirect: "manual" });
  assert.notEqual(r.status, 404);
});

test("login builds a correct PKCE authorize redirect + a path-scoped flow cookie", async () => {
  const r = await fetch(`${BASE}/login`, { redirect: "manual" });
  assert.ok(r.status === 302 || r.status === 303, `expected redirect, got ${r.status}`);
  const loc = r.headers.get("location") ?? "";
  assert.ok(loc.startsWith(`${ISSUER}/authorize`), `should redirect to IdP authorize, got ${loc.slice(0, 80)}`);
  const u = new URL(loc);
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.ok(u.searchParams.get("code_challenge"), "PKCE code_challenge present");
  assert.ok(u.searchParams.get("state"), "state present");
  assert.equal(u.searchParams.get("client_id"), "udm-console");
  assert.equal(u.searchParams.get("redirect_uri"), `http://127.0.0.1:${MCP_PORT}/console/callback`);
  const setCookie = r.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /udm_console_flow=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /Path=\/console/);
});

test("callback with a forged/stateless request is rejected (4xx), not a crash", async () => {
  const r = await fetch(`${BASE}/callback?code=forged&state=forged`, { redirect: "manual" });
  assert.ok(r.status >= 400 && r.status < 500, `expected 4xx, got ${r.status}`);
});

test("the /mcp endpoint still requires auth — the console is not a bypass", async () => {
  const r = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    }),
  });
  assert.equal(r.status, 401);
});
