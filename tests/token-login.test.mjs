import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Console token-login (no IdP / no LDAP): paste an MCP_API_KEYS value to sign in.
// A write-capable key becomes an admin session; a read-only key does not.
const PORT = 24000 + (process.pid % 400);
const BASE = `http://127.0.0.1:${PORT}/console`;
const DB = join(tmpdir(), `udm-token-${process.pid}.db`);

let child;
let bootErr = "";

class Jar {
  constructor() { this.c = {}; }
  store(res) {
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const pair = sc.split(";")[0];
      const i = pair.indexOf("=");
      const k = pair.slice(0, i);
      const v = pair.slice(i + 1);
      if (v === "") delete this.c[k]; else this.c[k] = v;
    }
  }
  header() { return Object.entries(this.c).map(([k, v]) => `${k}=${v}`).join("; "); }
}

async function login(jar, token) {
  const g = await fetch(`${BASE}/login`, { headers: { cookie: jar.header() } });
  jar.store(g);
  const nonce = /name="csrf" value="([^"]+)"/.exec(await g.text())?.[1] ?? "";
  const p = await fetch(`${BASE}/login`, {
    method: "POST", redirect: "manual",
    headers: { cookie: jar.header(), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token, csrf: nonce }),
  });
  jar.store(p);
  return p.status;
}
const dashboard = async (jar) => (await fetch(BASE, { headers: { cookie: jar.header() } })).text();

before(async () => {
  try { rmSync(DB); } catch {}
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(AUTH_|MCP_)/.test(k)) delete env[k];
  child = spawn("node", ["dist/index.js"], {
    env: {
      ...env,
      MCP_HTTP_PORT: String(PORT),
      AUTH_CONSOLE_ENABLED: "true",
      AUTH_SESSION_SECRET: "test-session-secret-0123456789abcdef",
      AUTH_KEY_STORE: "sqlite",
      AUTH_KEYSTORE_SQLITE_PATH: DB,
      MCP_API_KEYS: JSON.stringify({
        tok_admin: { name: "admin", allowWrites: true },
        tok_read: { name: "ci", allowWrites: false },
      }),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (d) => { bootErr += d.toString(); });
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/healthz`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not become healthy.\n${bootErr}`);
});

after(() => {
  child?.kill();
  try { rmSync(DB); } catch {}
});

test("login page is a token-paste form (not username/password, not SSO)", async () => {
  const html = await (await fetch(`${BASE}/login`, { redirect: "manual" })).text();
  assert.match(html, /name="token"/);
  assert.match(html, /type="password"/);
  assert.doesNotMatch(html, /name="username"/);
});

test("a write-capable token signs in as admin (can mint write keys)", async () => {
  const jar = new Jar();
  assert.equal(await login(jar, "tok_admin"), 302);
  const html = await dashboard(jar);
  assert.match(html, /Your API keys/);
  assert.match(html, /Allow <strong>writes/);
});

test("a read-only token signs in without write access", async () => {
  const jar = new Jar();
  assert.equal(await login(jar, "tok_read"), 302);
  const html = await dashboard(jar);
  assert.match(html, /Your API keys/);
  assert.doesNotMatch(html, /Allow <strong>writes/);
  assert.match(html, /Read-only key/);
});

test("an invalid token is rejected (401)", async () => {
  assert.equal(await login(new Jar(), "nope"), 401);
});
