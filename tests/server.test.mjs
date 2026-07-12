// End-to-end tests for the Ultimate DevOps MCP server.
// Spawns the built server (dist/) and drives the real Streamable HTTP protocol.
// Run: npm test   (builds first, then `node --test tests/`)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 18500 + (process.pid % 500);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "test-token-for-ci";

let child;

function sseData(body) {
  const line = body.split("\n").find((l) => l.startsWith("data: {"));
  assert.ok(line, `no SSE data line in response:\n${body}`);
  return JSON.parse(line.slice(6));
}

async function post(payload, { session, token = TOKEN } = {}) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (session) headers["mcp-session-id"] = session;
  return fetch(`${BASE}/mcp`, { method: "POST", headers, body: JSON.stringify(payload) });
}

async function initialize() {
  const res = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "node-test", version: "0" },
    },
  });
  assert.equal(res.status, 200);
  const session = res.headers.get("mcp-session-id");
  assert.ok(session, "initialize response must carry mcp-session-id");
  const init = sseData(await res.text());
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, { session });
  return { session, init };
}

before(async () => {
  child = spawn("node", ["dist/index.js"], {
    env: {
      ...process.env,
      MCP_HTTP_PORT: String(PORT),
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_AUTH_TOKEN: TOKEN,
      MCP_ALLOW_WRITES: "true",
      LOG_LEVEL: "silent",
      // Enable a few integrations with fake creds: clients are lazy, so tool
      // REGISTRATION must work without any live backend.
      POSTGRES_URL: "postgres://fake:fake@127.0.0.1:1/fake",
      REDIS_URL: "redis://127.0.0.1:1",
      GITLAB_TOKEN: "glpat-fake",
      PROMETHEUS_URL: "http://127.0.0.1:1",
    },
    stdio: "ignore",
  });
  // Wait for readiness
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error("server did not become healthy");
});

after(() => {
  child?.kill("SIGTERM");
});

test("healthz and readyz report status and integrations", async () => {
  const ready = await (await fetch(`${BASE}/readyz`)).json();
  assert.equal(ready.status, "ok");
  assert.deepEqual(
    [...ready.integrations].sort(),
    ["gitlab", "postgres", "prometheus", "redis"],
  );
});

test("requests without bearer token are rejected with 401", async () => {
  const res = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { token: null });
  assert.equal(res.status, 401);
});

test("requests with a wrong token are rejected with 401", async () => {
  const res = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { token: "wrong" });
  assert.equal(res.status, 401);
});

test("initialize handshake returns server info and session id", async () => {
  const { init } = await initialize();
  assert.equal(init.result.serverInfo.name, "ultimate-devops-mcp");
  assert.equal(init.result.protocolVersion, "2025-03-26");
});

test("non-initialize request without session id is rejected", async () => {
  const res = await post({ jsonrpc: "2.0", id: 9, method: "tools/list" });
  assert.equal(res.status, 400);
});

test("tools/list exposes enabled integrations including write tools", async () => {
  const { session } = await initialize();
  const res = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { session });
  const { result } = sseData(await res.text());
  const names = result.tools.map((t) => t.name);

  for (const expected of [
    "devops_status",
    "postgres_query",
    "postgres_execute", // write tool — MCP_ALLOW_WRITES=true
    "redis_get",
    "redis_set",
    "gitlab_list_pipelines",
    "prom_query",
  ]) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
  // Integrations that are NOT configured must NOT register tools.
  assert.ok(!names.includes("kafka_list_topics"), "kafka should not be registered");
  assert.ok(!names.includes("k8s_list"), "kubernetes should not be registered");
});

test("devops_status tool reports enabled integrations and write mode", async () => {
  const { session } = await initialize();
  const res = await post(
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "devops_status", arguments: {} } },
    { session },
  );
  const { result } = sseData(await res.text());
  const status = JSON.parse(result.content[0].text);
  assert.equal(status.server, "ultimate-devops-mcp");
  assert.equal(status.writesAllowed, true);
  assert.deepEqual([...status.enabledIntegrations].sort(), ["gitlab", "postgres", "prometheus", "redis"]);
});

test("tool call against unreachable backend returns isError result, not a crash", async () => {
  const { session } = await initialize();
  const res = await post(
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "prom_query", arguments: { query: "up" } },
    },
    { session },
  );
  const { result } = sseData(await res.text());
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /^Error:/);

  // The session must still be usable afterwards.
  const res2 = await post(
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "devops_status", arguments: {} } },
    { session },
  );
  const { result: r2 } = sseData(await res2.text());
  assert.ok(JSON.parse(r2.content[0].text).server);
});

test("session can be terminated with DELETE and is gone afterwards", async () => {
  const { session } = await initialize();
  const del = await fetch(`${BASE}/mcp`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${TOKEN}`, "mcp-session-id": session },
  });
  assert.ok(del.status < 300, `DELETE failed: ${del.status}`);
  const res = await post({ jsonrpc: "2.0", id: 6, method: "tools/list" }, { session });
  assert.equal(res.status, 400);
});
