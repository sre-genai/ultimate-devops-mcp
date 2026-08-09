import { test } from "node:test";
import assert from "node:assert/strict";

const { loadConfig } = await import("../dist/config.js");
const { mapClaimsToIdentity } = await import("../dist/oidc.js");

function withEnv(vars, fn) {
  const saved = process.env;
  const base = { ...process.env };
  for (const k of Object.keys(base)) {
    if (k.startsWith("AUTH_OIDC") || k.startsWith("MCP_")) delete base[k];
  }
  process.env = { ...base, MCP_INSECURE: "1", ...vars };
  try {
    return fn();
  } finally {
    process.env = saved;
  }
}

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

test("oidc: issuer enables it with sensible defaults", () => {
  const cfg = withEnv(
    { AUTH_OIDC_ISSUER: "https://issuer.example.com/", AUTH_OIDC_AUDIENCE: "udm-api" },
    () => loadConfig(),
  );
  const o = cfg.oidc;
  assert.ok(o, "oidc should be configured");
  assert.equal(o.issuer, "https://issuer.example.com", "trailing slash trimmed");
  assert.equal(o.nameClaim, "email");
  assert.equal(o.groupsClaim, "groups");
  assert.deepEqual(o.allowedAlgs, ["RS256"]);
  assert.deepEqual(o.adminGroups, []);
});

test("oidc: AUTH_OIDC_ENABLED without an issuer is a fatal config error", () => {
  assert.throws(() => withEnv({ AUTH_OIDC_ENABLED: "true" }, () => loadConfig()), /AUTH_OIDC_ISSUER is missing/);
});

test("oidc: issuer without audience is a fatal config error (shared-issuer bypass guard)", () => {
  assert.throws(
    () => withEnv({ AUTH_OIDC_ISSUER: "https://issuer.example.com" }, () => loadConfig()),
    /AUTH_OIDC_AUDIENCE/,
  );
});

test("oidc: AUTH_OIDC_ALLOW_ANY_AUDIENCE opts out of the audience requirement", () => {
  const cfg = withEnv(
    { AUTH_OIDC_ISSUER: "https://issuer.example.com", AUTH_OIDC_ALLOW_ANY_AUDIENCE: "true" },
    () => loadConfig(),
  );
  assert.ok(cfg.oidc, "oidc configured");
  assert.equal(cfg.oidc.audience, undefined);
});

test("oidc: audience, claims, admin groups and group->tools map parse", () => {
  const cfg = withEnv(
    {
      AUTH_OIDC_ISSUER: "https://issuer.example.com",
      AUTH_OIDC_AUDIENCE: "udm-api",
      AUTH_OIDC_NAME_CLAIM: "preferred_username",
      AUTH_OIDC_GROUPS_CLAIM: "roles",
      AUTH_OIDC_ADMIN_GROUPS: "devops-admins, sre",
      AUTH_OIDC_GROUP_TOOLS: '{"readers":["postgres_query","prom_query"]}',
      AUTH_OIDC_ALGS: "RS256,ES256",
    },
    () => loadConfig(),
  );
  const o = cfg.oidc;
  assert.equal(o.audience, "udm-api");
  assert.equal(o.nameClaim, "preferred_username");
  assert.equal(o.groupsClaim, "roles");
  assert.deepEqual(o.adminGroups, ["devops-admins", "sre"]);
  assert.deepEqual(o.groupTools, { readers: ["postgres_query", "prom_query"] });
  assert.deepEqual(o.allowedAlgs, ["RS256", "ES256"]);
});

test("oidc: invalid AUTH_OIDC_GROUP_TOOLS JSON is a fatal config error", () => {
  assert.throws(
    () => withEnv({ AUTH_OIDC_ISSUER: "https://i", AUTH_OIDC_GROUP_TOOLS: "not json" }, () => loadConfig()),
    /AUTH_OIDC_GROUP_TOOLS is not valid JSON/,
  );
});

// ---------------------------------------------------------------------------
// Claims -> KeyIdentity mapping (the authorization decision)
// ---------------------------------------------------------------------------

const baseCfg = {
  issuer: "https://i",
  nameClaim: "email",
  groupsClaim: "groups",
  adminGroups: ["admins"],
  allowedAlgs: ["RS256"],
};

test("map: name from the name claim; admin group grants writes", () => {
  const id = mapClaimsToIdentity({ email: "a@x.io", sub: "u1", groups: ["admins", "eng"] }, baseCfg);
  assert.equal(id.name, "a@x.io");
  assert.equal(id.allowWrites, true);
});

test("map: non-admin user does not get writes; name falls back to sub", () => {
  const id = mapClaimsToIdentity({ sub: "u2", groups: ["eng"] }, baseCfg);
  assert.equal(id.name, "u2");
  assert.equal(id.allowWrites, false);
});

test("map: space-delimited groups string is parsed", () => {
  const id = mapClaimsToIdentity({ email: "b@x.io", groups: "eng admins" }, baseCfg);
  assert.equal(id.allowWrites, true);
});

test("map: group->tools produces the union allowlist for the user's groups", () => {
  const cfg = { ...baseCfg, groupTools: { readers: ["postgres_query"], oncall: ["k8s_pod_logs", "postgres_query"] } };
  const id = mapClaimsToIdentity({ email: "c@x.io", groups: ["readers", "oncall"] }, cfg);
  assert.deepEqual([...id.tools].sort(), ["k8s_pod_logs", "postgres_query"]);
});

test("map: with a group->tools map, an unmapped user gets a deny-all (empty) allowlist", () => {
  const cfg = { ...baseCfg, groupTools: { readers: ["postgres_query"] } };
  const id = mapClaimsToIdentity({ email: "d@x.io", groups: ["nobody"] }, cfg);
  assert.deepEqual(id.tools, []);
});
