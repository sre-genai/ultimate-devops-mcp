import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ldap from "ldapjs";

// Native LDAP console login, end-to-end against an in-process directory:
// the username/password form binds to LDAP, maps memberOf → admin, and
// establishes a session. Disjoint ports; own process per file.
const MCP_PORT = 23000 + (process.pid % 400);
const LDAP_PORT = 23500 + (process.pid % 400);
const BASE = `http://127.0.0.1:${MCP_PORT}/console`;
const DB = join(tmpdir(), `udm-ldap-${process.pid}.db`);

const SVC = { dn: "cn=svc,dc=corp,dc=io", password: "svcpass" };
const USERS = {
  alice: { dn: "uid=alice,ou=people,dc=corp,dc=io", password: "pw-alice",
    attrs: { uid: ["alice"], cn: ["Alice Admin"], memberOf: ["cn=platform-admins,ou=groups,dc=corp,dc=io"] } },
  bob: { dn: "uid=bob,ou=people,dc=corp,dc=io", password: "pw-bob",
    attrs: { uid: ["bob"], cn: ["Bob Viewer"], memberOf: ["cn=viewers,ou=groups,dc=corp,dc=io"] } },
};
const norm = (dn) => String(dn).replace(/\s+/g, "").toLowerCase();

let server;
let child;
let bootErr = "";

// Minimal cookie jar over undici's getSetCookie().
class Jar {
  constructor() { this.c = {}; }
  store(res) {
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const pair = sc.split(";")[0];
      const i = pair.indexOf("=");
      const k = pair.slice(0, i);
      const v = pair.slice(i + 1);
      if (v === "") delete this.c[k];
      else this.c[k] = v;
    }
  }
  header() { return Object.entries(this.c).map(([k, v]) => `${k}=${v}`).join("; "); }
}

async function login(jar, username, password) {
  const g = await fetch(`${BASE}/login`, { headers: { cookie: jar.header() } });
  jar.store(g);
  const html = await g.text();
  const nonce = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const body = new URLSearchParams({ username, password, csrf: nonce });
  const p = await fetch(`${BASE}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: jar.header(), "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  jar.store(p);
  return p.status;
}
async function dashboard(jar) {
  const r = await fetch(BASE, { headers: { cookie: jar.header() } });
  return r.text();
}

before(async () => {
  try { rmSync(DB); } catch { /* fresh */ }
  server = ldap.createServer();
  server.on("error", () => {});
  server.bind("dc=corp,dc=io", (req, res, next) => {
    const dn = norm(req.dn.toString());
    const pw = req.credentials;
    if (dn === norm(SVC.dn) && pw === SVC.password) { res.end(); return next(); }
    const u = Object.values(USERS).find((x) => norm(x.dn) === dn);
    if (u && pw === u.password) { res.end(); return next(); }
    return next(new ldap.InvalidCredentialsError());
  });
  server.search("dc=corp,dc=io", (req, res, next) => {
    for (const u of Object.values(USERS)) {
      if (req.filter.matches(u.attrs)) res.send({ dn: u.dn, attributes: u.attrs });
    }
    res.end();
    return next();
  });
  await new Promise((r) => server.listen(LDAP_PORT, "127.0.0.1", r));

  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(AUTH_|MCP_)/.test(k)) delete env[k];
  child = spawn("node", ["dist/index.js"], {
    env: {
      ...env,
      MCP_HTTP_PORT: String(MCP_PORT),
      AUTH_CONSOLE_ENABLED: "true",
      AUTH_SESSION_SECRET: "test-session-secret-0123456789abcdef",
      AUTH_LDAP_URL: `ldap://127.0.0.1:${LDAP_PORT}`,
      AUTH_LDAP_BIND_DN: SVC.dn,
      AUTH_LDAP_BIND_PASSWORD: SVC.password,
      AUTH_LDAP_SEARCH_BASE: "ou=people,dc=corp,dc=io",
      AUTH_LDAP_SEARCH_FILTER: "(uid={{username}})",
      AUTH_LDAP_ADMIN_GROUPS: "platform-admins",
      AUTH_KEY_STORE: "sqlite",
      AUTH_KEYSTORE_SQLITE_PATH: DB,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (d) => { bootErr += d.toString(); });
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${MCP_PORT}/healthz`); if (r.ok) return; } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not become healthy.\n${bootErr}`);
});

after(() => {
  child?.kill();
  server?.close();
  try { rmSync(DB); } catch { /* ignore */ }
});

test("login page is a username/password form (LDAP mode, not an SSO redirect)", async () => {
  const r = await fetch(`${BASE}/login`, { redirect: "manual" });
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /name="username"/);
  assert.match(html, /type="password"/);
  assert.match(html, /name="csrf"/);
});

test("valid admin credentials sign in and map memberOf → write-capable", async () => {
  const jar = new Jar();
  const status = await login(jar, "alice", "pw-alice");
  assert.equal(status, 302);
  const html = await dashboard(jar);
  assert.match(html, /Your API keys/);
  assert.match(html, /Allow <strong>writes/); // admin group → can mint write keys
});

test("valid non-admin credentials sign in read-only", async () => {
  const jar = new Jar();
  const status = await login(jar, "bob", "pw-bob");
  assert.equal(status, 302);
  const html = await dashboard(jar);
  assert.match(html, /Your API keys/);
  assert.doesNotMatch(html, /Allow <strong>writes/);
  assert.match(html, /Read-only key/);
});

test("wrong password is rejected (401), no session established", async () => {
  const jar = new Jar();
  const status = await login(jar, "alice", "wrong");
  assert.equal(status, 401);
  // No session → the dashboard bounces back to /login.
  const r = await fetch(BASE, { headers: { cookie: jar.header() }, redirect: "manual" });
  assert.ok(r.status === 302 || r.status === 303);
});

test("unknown user is rejected (401)", async () => {
  const jar = new Jar();
  assert.equal(await login(jar, "nobody", "whatever"), 401);
});
