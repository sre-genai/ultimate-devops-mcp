import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

// End-to-end test of the OIDC/JWT auth path against a locally minted mock IdP
// (own RSA keypair + discovery/JWKS server + self-signed JWTs) — no real IdP.
// Disjoint port range from the other suites; each test file runs in its own
// process so process.pid keeps concurrent runs from colliding.
const MCP_PORT = 20000 + (process.pid % 400);
const IDP_PORT = 20500 + (process.pid % 400);
const ISSUER = `http://127.0.0.1:${IDP_PORT}`;
const AUD = "udm";
const MCP = `http://127.0.0.1:${MCP_PORT}/mcp`;

let idp;
let child;
let privateKey;
let bootErr = "";

function mint({ groups = [], aud = AUD, exp = "1h", email = "user@corp.io" } = {}) {
  return new SignJWT({ email, groups })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(aud)
    .setExpirationTime(exp)
    .sign(privateKey);
}

const headers = (tok) => ({
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  ...(tok ? { authorization: `Bearer ${tok}` } : {}),
});

function parseSSE(text) {
  for (const line of text.split("\n")) {
    const l = line.replace(/^data: /, "").trim();
    if (!l) continue;
    try {
      return JSON.parse(l);
    } catch {
      /* keep scanning */
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function session(tok) {
  const r = await fetch(MCP, {
    method: "POST",
    headers: headers(tok),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    }),
  });
  return { status: r.status, sid: r.headers.get("mcp-session-id") };
}

async function call(tok, sid, name, args = {}) {
  const r = await fetch(MCP, {
    method: "POST",
    headers: { ...headers(tok), "mcp-session-id": sid },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }),
  });
  const j = parseSSE(await r.text());
  const res = j?.result ?? {};
  return { isError: res.isError === true, text: res.content?.[0]?.text ?? "" };
}

before(async () => {
  const kp = await generateKeyPair("RS256");
  privateKey = kp.privateKey;
  const jwk = { ...(await exportJWK(kp.publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
  idp = http.createServer((req, res) => {
    if (req.url.startsWith("/.well-known/openid-configuration")) {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks` }));
    }
    if (req.url.startsWith("/jwks")) {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ keys: [jwk] }));
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise((r) => idp.listen(IDP_PORT, r));

  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(AUTH_|MCP_|SENTRY_)/.test(k)) delete env[k];
  child = spawn("node", ["dist/index.js"], {
    env: {
      ...env,
      MCP_HTTP_PORT: String(MCP_PORT),
      MCP_ALLOW_WRITES: "true",
      AUTH_OIDC_ISSUER: ISSUER,
      AUTH_OIDC_AUDIENCE: AUD,
      AUTH_OIDC_ADMIN_GROUPS: "platform-admins",
      SENTRY_TOKEN: "dummy",
      SENTRY_ORG: "acme",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (d) => {
    bootErr += d.toString();
  });

  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${MCP_PORT}/healthz`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not become healthy.\n${bootErr}`);
});

after(() => {
  child?.kill();
  idp?.close();
});

test("no bearer token is rejected with 401", async () => {
  assert.equal((await session()).status, 401);
});

test("JWT with the wrong audience is rejected", async () => {
  assert.equal((await session(await mint({ aud: "someone-else" }))).status, 401);
});

test("expired JWT is rejected", async () => {
  assert.equal((await session(await mint({ exp: Math.floor(Date.now() / 1000) - 60 }))).status, 401);
});

test("JWT with a tampered signature is rejected", async () => {
  const good = await mint({ groups: ["platform-admins"] });
  const tampered = good.slice(0, -3) + (good.slice(-3) === "AAA" ? "BBB" : "AAA");
  assert.equal((await session(tampered)).status, 401);
});

test("valid JWT authenticates and can read", async () => {
  const tok = await mint({ groups: ["platform-admins"] });
  const s = await session(tok);
  assert.equal(s.status, 200);
  assert.ok(s.sid, "a session id is issued");
  const status = await call(tok, s.sid, "devops_status");
  assert.equal(status.isError, false);
  assert.match(status.text, /ultimate-devops-mcp/);
});

test("admin group maps to allowWrites: the write passes governance to the handler", async () => {
  const tok = await mint({ groups: ["platform-admins"] });
  const s = await session(tok);
  const w = await call(tok, s.sid, "sentry_update_issue", { id: "1", status: "resolved" });
  // Governance allowed it, so it reaches the (dummy) Sentry backend and fails
  // there — NOT a permission error.
  assert.equal(w.isError, true);
  assert.doesNotMatch(w.text, /not permitted/i);
});

test("non-admin group is denied writes by governance but can still read", async () => {
  const tok = await mint({ groups: ["viewers"] });
  const s = await session(tok);
  const w = await call(tok, s.sid, "sentry_update_issue", { id: "1", status: "resolved" });
  assert.equal(w.isError, true);
  assert.match(w.text, /not permitted/i);
  const r = await call(tok, s.sid, "devops_status");
  assert.equal(r.isError, false);
});
