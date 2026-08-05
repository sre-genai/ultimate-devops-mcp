import { test } from "node:test";
import assert from "node:assert/strict";

const { loadConfig } = await import("../dist/config.js");

/** Run loadConfig with a clean, controlled env (only the given keys set). */
function withEnv(vars, fn) {
  const saved = process.env;
  const base = { ...process.env };
  for (const k of Object.keys(base)) {
    if (k.startsWith("DATADOG") || k.startsWith("MCP_")) delete base[k];
  }
  process.env = { ...base, MCP_INSECURE: "1", ...vars };
  try {
    return fn();
  } finally {
    process.env = saved;
  }
}

test("backward-compatible single instance registers as 'default' primary", () => {
  const cfg = withEnv({ DATADOG_API_KEY: "ak", DATADOG_APP_KEY: "app" }, () => loadConfig());
  const d = cfg.integrations.datadog;
  assert.ok(d, "datadog should be configured");
  assert.equal(d.primary, "default");
  assert.deepEqual(Object.keys(d.instances), ["default"]);
  assert.equal(d.instances.default.apiKey, "ak");
  assert.equal(d.instances.default.appKey, "app");
  assert.equal(d.instances.default.site, "datadoghq.com", "site defaults");
});

test("multi-instance: prod + eu, first listed is primary, per-instance site", () => {
  const cfg = withEnv(
    {
      DATADOG_INSTANCES: "prod, eu",
      DATADOG_PROD_API_KEY: "pak",
      DATADOG_PROD_APP_KEY: "papp",
      DATADOG_EU_API_KEY: "eak",
      DATADOG_EU_APP_KEY: "eapp",
      DATADOG_EU_SITE: "datadoghq.eu",
    },
    () => loadConfig(),
  );
  const d = cfg.integrations.datadog;
  assert.ok(d);
  assert.equal(d.primary, "prod");
  assert.deepEqual(Object.keys(d.instances).sort(), ["eu", "prod"]);
  assert.equal(d.instances.prod.site, "datadoghq.com");
  assert.equal(d.instances.eu.site, "datadoghq.eu");
});

test("DATADOG_PRIMARY overrides which instance is default", () => {
  const cfg = withEnv(
    {
      DATADOG_INSTANCES: "prod,eu",
      DATADOG_PRIMARY: "eu",
      DATADOG_PROD_API_KEY: "pak",
      DATADOG_PROD_APP_KEY: "papp",
      DATADOG_EU_API_KEY: "eak",
      DATADOG_EU_APP_KEY: "eapp",
    },
    () => loadConfig(),
  );
  assert.equal(cfg.integrations.datadog.primary, "eu");
});

test("an instance missing its app key fails config validation", () => {
  assert.throws(
    () =>
      withEnv(
        {
          DATADOG_INSTANCES: "prod",
          DATADOG_PROD_API_KEY: "pak",
          // no DATADOG_PROD_APP_KEY
        },
        () => loadConfig(),
      ),
    /DATADOG_PROD_API_KEY is set but DATADOG_PROD_APP_KEY/,
  );
});

test("no datadog env → integration absent", () => {
  const cfg = withEnv({}, () => loadConfig());
  assert.equal(cfg.integrations.datadog, undefined);
});
