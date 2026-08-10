import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// MCP_BOOTSTRAP_ADMIN: with no other auth configured, the server should mint a
// random admin token (rather than run unauthenticated / refuse a network bind),
// persist it, and require it. Bound to 0.0.0.0 to prove it no longer refuses.
const PORT = 22000 + (process.pid % 400);
const MCP = `http://127.0.0.1:${PORT}/mcp`;
const TOKEN_FILE = join(tmpdir(), `udm-bootstrap-${process.pid}.token`);

let child;
let bootErr = "";

before(async () => {
  try { rmSync(TOKEN_FILE); } catch { /* fresh */ }
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(AUTH_|MCP_)/.test(k)) delete env[k];
  child = spawn("node", ["dist/index.js"], {
    env: {
      ...env,
      MCP_HTTP_HOST: "0.0.0.0", // would REFUSE to start here without auth
      MCP_HTTP_PORT: String(PORT),
      MCP_BOOTSTRAP_ADMIN: "true",
      MCP_BOOTSTRAP_ADMIN_FILE: TOKEN_FILE,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (d) => { bootErr += d.toString(); });
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not become healthy (bootstrap should have let it bind 0.0.0.0).\n${bootErr}`);
});

after(() => {
  child?.kill();
  try { rmSync(TOKEN_FILE); } catch { /* ignore */ }
});

async function initialize(token) {
  const r = await fetch(MCP, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    }),
  });
  return { status: r.status, sid: r.headers.get("mcp-session-id") };
}

test("bootstrap persists a udm_admin_ token to the configured file (0600 path)", () => {
  assert.ok(existsSync(TOKEN_FILE), "token file should be created");
  const tok = readFileSync(TOKEN_FILE, "utf8").trim();
  assert.match(tok, /^udm_admin_[A-Za-z0-9_-]+$/);
});

test("without the bootstrap token the endpoint is not open (401)", async () => {
  assert.equal((await initialize()).status, 401);
});

test("the bootstrap token authenticates as a full-access key", async () => {
  const tok = readFileSync(TOKEN_FILE, "utf8").trim();
  const s = await initialize(tok);
  assert.equal(s.status, 200);
  assert.ok(s.sid, "a session id is issued");
});
