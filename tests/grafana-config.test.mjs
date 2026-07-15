import { test } from "node:test";
import assert from "node:assert/strict";

// The config module reads process.env at call time via loadConfig().
const { loadConfig } = await import("../dist/config.js");

/** Run loadConfig with a clean, controlled env (only the given keys set). */
function withEnv(vars, fn) {
  const saved = process.env;
  // Keep PATH etc. but drop every GRAFANA_* + MCP_* so tests are isolated.
  const base = { ...process.env };
  for (const k of Object.keys(base)) {
    if (k.startsWith("GRAFANA") || k.startsWith("MCP_")) delete base[k];
  }
  process.env = { ...base, MCP_INSECURE: "1", ...vars };
  try {
    return fn();
  } finally {
    process.env = saved;
  }
}

test("backward-compatible single instance registers as 'default' primary", () => {
  const cfg = withEnv(
    { GRAFANA_URL: "https://g.example.com/", GRAFANA_TOKEN: "tok" },
    () => loadConfig(),
  );
  const g = cfg.integrations.grafana;
  assert.ok(g, "grafana should be configured");
  assert.equal(g.primary, "default");
  assert.deepEqual(Object.keys(g.instances), ["default"]);
  assert.equal(g.instances.default.url, "https://g.example.com", "trailing slash trimmed");
  assert.equal(g.instances.default.token, "tok");
});

test("multi-instance: prod + nonprod, first listed is primary", () => {
  const cfg = withEnv(
    {
      GRAFANA_INSTANCES: "prod, nonprod",
      GRAFANA_PROD_URL: "https://grafana.prod.example.com",
      GRAFANA_PROD_TOKEN: "prod-tok",
      GRAFANA_NONPROD_URL: "https://grafana.staging.example.com",
      GRAFANA_NONPROD_TOKEN: "np-tok",
    },
    () => loadConfig(),
  );
  const g = cfg.integrations.grafana;
  assert.ok(g);
  assert.equal(g.primary, "prod");
  assert.deepEqual(Object.keys(g.instances).sort(), ["nonprod", "prod"]);
  assert.equal(g.instances.prod.token, "prod-tok");
  assert.equal(g.instances.nonprod.url, "https://grafana.staging.example.com");
});

test("GRAFANA_PRIMARY overrides which instance is default", () => {
  const cfg = withEnv(
    {
      GRAFANA_INSTANCES: "prod,nonprod",
      GRAFANA_PRIMARY: "nonprod",
      GRAFANA_PROD_URL: "https://p",
      GRAFANA_PROD_TOKEN: "p",
      GRAFANA_NONPROD_URL: "https://n",
      GRAFANA_NONPROD_TOKEN: "n",
    },
    () => loadConfig(),
  );
  assert.equal(cfg.integrations.grafana.primary, "nonprod");
});

test("an instance missing its token fails config validation", () => {
  assert.throws(
    () =>
      withEnv(
        {
          GRAFANA_INSTANCES: "prod",
          GRAFANA_PROD_URL: "https://p",
          // no GRAFANA_PROD_TOKEN
        },
        () => loadConfig(),
      ),
    /GRAFANA_PROD_URL is set but GRAFANA_PROD_TOKEN/,
  );
});

test("no grafana env → integration absent", () => {
  const cfg = withEnv({}, () => loadConfig());
  assert.equal(cfg.integrations.grafana, undefined);
});
