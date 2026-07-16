import { test } from "node:test";
import assert from "node:assert/strict";

const { loadConfig } = await import("../dist/config.js");

function withEnv(vars, fn) {
  const saved = process.env;
  const base = { ...process.env };
  for (const k of Object.keys(base)) {
    if (k.startsWith("JIRA") || k.startsWith("MCP_")) delete base[k];
  }
  process.env = { ...base, MCP_INSECURE: "1", ...vars };
  try {
    return fn();
  } finally {
    process.env = saved;
  }
}

test("Jira Cloud: email + API token → basic auth, REST v3, 'default' primary", () => {
  const cfg = withEnv(
    { JIRA_URL: "https://co.atlassian.net/", JIRA_EMAIL: "me@co.com", JIRA_API_TOKEN: "tok" },
    () => loadConfig(),
  );
  const j = cfg.integrations.jira;
  assert.ok(j);
  assert.equal(j.primary, "default");
  assert.equal(j.instances.default.apiVersion, 3);
  assert.equal(j.instances.default.baseUrl, "https://co.atlassian.net");
  assert.match(j.instances.default.authHeader, /^Basic /);
});

test("Jira Server/DC: bare token → bearer auth, REST v2", () => {
  const cfg = withEnv({ JIRA_URL: "https://jira.internal", JIRA_TOKEN: "pat" }, () => loadConfig());
  const inst = cfg.integrations.jira.instances.default;
  assert.equal(inst.apiVersion, 2);
  assert.equal(inst.authHeader, "Bearer pat");
});

test("multi-instance: prod (cloud) + sandbox (server), first listed primary", () => {
  const cfg = withEnv(
    {
      JIRA_INSTANCES: "prod, sandbox",
      JIRA_PROD_URL: "https://co.atlassian.net",
      JIRA_PROD_EMAIL: "me@co.com",
      JIRA_PROD_API_TOKEN: "ptok",
      JIRA_SANDBOX_URL: "https://jira.sandbox.internal",
      JIRA_SANDBOX_TOKEN: "spat",
    },
    () => loadConfig(),
  );
  const j = cfg.integrations.jira;
  assert.equal(j.primary, "prod");
  assert.deepEqual(Object.keys(j.instances).sort(), ["prod", "sandbox"]);
  assert.equal(j.instances.prod.apiVersion, 3);
  assert.equal(j.instances.sandbox.apiVersion, 2);
});

test("URL present but no credentials → config error", () => {
  assert.throws(
    () => withEnv({ JIRA_URL: "https://co.atlassian.net" }, () => loadConfig()),
    /Jira needs JIRA_EMAIL \+ JIRA_API_TOKEN .* or JIRA_TOKEN/,
  );
});

test("no jira env → integration absent", () => {
  assert.equal(withEnv({}, () => loadConfig()).integrations.jira, undefined);
});
