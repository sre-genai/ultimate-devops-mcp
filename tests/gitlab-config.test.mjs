import { test } from "node:test";
import assert from "node:assert/strict";

const { loadConfig } = await import("../dist/config.js");

/** Run loadConfig with a clean, controlled env (only the given keys set). */
function withEnv(vars, fn) {
  const saved = process.env;
  const base = { ...process.env };
  for (const k of Object.keys(base)) {
    if (k.startsWith("GITLAB") || k.startsWith("MCP_")) delete base[k];
  }
  process.env = { ...base, MCP_INSECURE: "1", ...vars };
  try {
    return fn();
  } finally {
    process.env = saved;
  }
}

test("backward-compatible single instance registers as 'default', URL defaults to gitlab.com", () => {
  const cfg = withEnv({ GITLAB_TOKEN: "tok" }, () => loadConfig());
  const g = cfg.integrations.gitlab;
  assert.ok(g, "gitlab should be configured");
  assert.equal(g.primary, "default");
  assert.deepEqual(Object.keys(g.instances), ["default"]);
  assert.equal(g.instances.default.url, "https://gitlab.com");
  assert.equal(g.instances.default.token, "tok");
});

test("self-hosted URL trailing slash is trimmed", () => {
  const cfg = withEnv({ GITLAB_TOKEN: "tok", GITLAB_URL: "https://gitlab.internal/" }, () => loadConfig());
  assert.equal(cfg.integrations.gitlab.instances.default.url, "https://gitlab.internal");
});

test("multi-instance: cloud + onprem, first listed is primary", () => {
  const cfg = withEnv(
    {
      GITLAB_INSTANCES: "cloud, onprem",
      GITLAB_CLOUD_TOKEN: "ctok",
      GITLAB_ONPREM_TOKEN: "otok",
      GITLAB_ONPREM_URL: "https://gitlab.internal",
    },
    () => loadConfig(),
  );
  const g = cfg.integrations.gitlab;
  assert.ok(g);
  assert.equal(g.primary, "cloud");
  assert.deepEqual(Object.keys(g.instances).sort(), ["cloud", "onprem"]);
  assert.equal(g.instances.cloud.url, "https://gitlab.com", "cloud defaults to gitlab.com");
  assert.equal(g.instances.onprem.url, "https://gitlab.internal");
  assert.equal(g.instances.onprem.token, "otok");
});

test("GITLAB_PRIMARY overrides which instance is default", () => {
  const cfg = withEnv(
    {
      GITLAB_INSTANCES: "cloud,onprem",
      GITLAB_PRIMARY: "onprem",
      GITLAB_CLOUD_TOKEN: "ctok",
      GITLAB_ONPREM_TOKEN: "otok",
    },
    () => loadConfig(),
  );
  assert.equal(cfg.integrations.gitlab.primary, "onprem");
});

test("a listed instance missing its token fails config validation", () => {
  assert.throws(
    () =>
      withEnv(
        {
          GITLAB_INSTANCES: "onprem",
          GITLAB_ONPREM_URL: "https://gitlab.internal",
          // no GITLAB_ONPREM_TOKEN
        },
        () => loadConfig(),
      ),
    /GITLAB_INSTANCES lists "onprem" but GITLAB_ONPREM_TOKEN is missing/,
  );
});

test("no gitlab env → integration absent", () => {
  const cfg = withEnv({}, () => loadConfig());
  assert.equal(cfg.integrations.gitlab, undefined);
});
