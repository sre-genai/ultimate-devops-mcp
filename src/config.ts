import "dotenv/config";
import type { KeyIdentity } from "./audit.js";

export interface PostgresConfig {
  connectionString: string;
  /** Connecting through PgBouncer (transaction/statement pool mode): skip the
   * server-side statement_timeout startup param it can reject. */
  pgbouncer: boolean;
  /** Optional allowlist of database names the tools may list/target. Each entry
   * is either an exact name or a `/regex/`. Empty/undefined = all databases. */
  dbAllow?: string[];
}
export interface MongoConfig {
  uri: string;
}
export interface Neo4jConfig {
  url: string;
  username: string;
  password: string;
  database?: string;
}
export interface ElasticInstance {
  node: string;
  apiKey?: string;
  username?: string;
  password?: string;
}
export interface ElasticConfig {
  /** Named Elasticsearch instances, keyed by lowercase name. */
  instances: Record<string, ElasticInstance>;
  /** Instance used when a tool call omits `instance`. */
  primary: string;
}
export interface KafkaConfig {
  brokers: string[];
  clientId: string;
  ssl: boolean;
  saslMechanism?: "plain" | "scram-sha-256" | "scram-sha-512";
  saslUsername?: string;
  saslPassword?: string;
}
export interface RedisConfig {
  url: string;
}
export interface KubernetesConfig {
  kubeconfigPath?: string;
}
export interface GrafanaInstance {
  url: string;
  token: string;
}

export interface GrafanaConfig {
  /** Named Grafana instances, keyed by lowercase instance name. */
  instances: Record<string, GrafanaInstance>;
  /** The instance used when a tool call omits `instance`. */
  primary: string;
}
export interface DatadogInstance {
  site: string;
  apiKey: string;
  appKey: string;
}
export interface DatadogConfig {
  /** Named Datadog instances, keyed by lowercase name. */
  instances: Record<string, DatadogInstance>;
  /** Instance used when a tool call omits `instance`. */
  primary: string;
}
export interface PrometheusInstance {
  url: string;
  bearerToken?: string;
}
export interface PrometheusConfig {
  /** Named Prometheus instances, keyed by lowercase name. */
  instances: Record<string, PrometheusInstance>;
  /** Instance used when a tool call omits `instance`. */
  primary: string;
}
export interface ArgoCDInstance {
  url: string;
  token: string;
}
export interface ArgoCDConfig {
  /** Named ArgoCD instances, keyed by lowercase name. */
  instances: Record<string, ArgoCDInstance>;
  /** Instance used when a tool call omits `instance`. */
  primary: string;
}
export interface GitlabInstance {
  url: string;
  token: string;
}
export interface GitlabConfig {
  /** Named GitLab instances, keyed by lowercase name. */
  instances: Record<string, GitlabInstance>;
  /** Instance used when a tool call omits `instance`. */
  primary: string;
}
export interface GitHubInstance {
  baseUrl: string;
  token: string;
}
export interface GitHubConfig {
  /** Named GitHub instances, keyed by lowercase name. */
  instances: Record<string, GitHubInstance>;
  /** Instance used when a tool call omits `instance`. */
  primary: string;
}
export interface BitbucketInstance {
  baseUrl: string;
  authHeader: string;
  workspace?: string;
}
export interface BitbucketConfig {
  /** Named Bitbucket instances, keyed by lowercase name. */
  instances: Record<string, BitbucketInstance>;
  /** Instance used when a tool call omits `instance`. */
  primary: string;
}

export interface JiraInstance {
  /** Site root, e.g. https://yourco.atlassian.net (no trailing slash). */
  baseUrl: string;
  authHeader: string;
  /** REST version: 3 for Jira Cloud, 2 for Server/Data Center. */
  apiVersion: 2 | 3;
}

export interface JiraConfig {
  /** Named Jira instances, keyed by lowercase name. */
  instances: Record<string, JiraInstance>;
  /** Instance used when a tool call omits `instance`. */
  primary: string;
}
export interface PlaywrightConfig {
  noSandbox: boolean;
}
export interface TemporalConfig {
  address: string;
  namespace: string;
  apiKey?: string;
  tls: boolean;
  tlsCert?: string;
  tlsKey?: string;
  tlsCA?: string;
  serverName?: string;
}

export interface FederatedServerConfig {
  /** Lowercase namespace prefix for this server's tools (`<name>__<remoteTool>`). */
  name: string;
  /** Remote MCP endpoint (Streamable HTTP), e.g. https://host/mcp. */
  url: string;
  /** Optional bearer token sent as `Authorization: Bearer <token>`. */
  token?: string;
}

export interface FederationConfig {
  servers: FederatedServerConfig[];
}

export interface Integrations {
  postgres?: PostgresConfig;
  mongo?: MongoConfig;
  neo4j?: Neo4jConfig;
  elastic?: ElasticConfig;
  kafka?: KafkaConfig;
  redis?: RedisConfig;
  kubernetes?: KubernetesConfig;
  grafana?: GrafanaConfig;
  datadog?: DatadogConfig;
  prometheus?: PrometheusConfig;
  argocd?: ArgoCDConfig;
  gitlab?: GitlabConfig;
  github?: GitHubConfig;
  bitbucket?: BitbucketConfig;
  jira?: JiraConfig;
  playwright?: PlaywrightConfig;
  temporal?: TemporalConfig;
}

export interface AppConfig {
  host: string;
  port: number;
  authToken?: string;
  /** Scoped API keys: token secret -> {name, tools?, allowWrites}. The bare
   * MCP_AUTH_TOKEN (authToken) remains a separate full-access key. */
  apiKeys?: Record<string, KeyIdentity>;
  allowWrites: boolean;
  /** When true, write/mutating tools return a preview instead of executing. */
  writeDryRun: boolean;
  logLevel: string;
  rateLimitPerMinute: number;
  sessionIdleTimeoutMs: number;
  maxResultChars: number;
  trustProxy: boolean;
  integrations: Integrations;
  federation?: FederationConfig;
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

function envBool(name: string, fallback = false): boolean {
  const v = env(name);
  if (v === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function envInt(name: string, fallback: number): number {
  const v = env(name);
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n) || n <= 0) {
    throw new Error(`Invalid value for ${name}: "${v}" (expected positive integer)`);
  }
  return n;
}

/**
 * Shared parser for the "<PREFIX>_INSTANCES" multi-instance convention used by
 * the HTTP integrations. Reads a comma-separated PREFIX_INSTANCES list, parses
 * each named instance's env vars via `parseOne`, and registers a bare
 * single-instance config (PREFIX_… with no list) as "default" for backward
 * compatibility. `probe` is the env suffix that signals a listed instance is
 * present (e.g. "URL", "TOKEN"); a listed name missing it is a config error.
 * PREFIX_PRIMARY (or the first listed name) chooses the default instance.
 * (Grafana and Jira keep their own inline copies for their extra auth handling.)
 */
function parseInstances<T>(
  prefix: string,
  label: string,
  probe: string | undefined,
  errors: string[],
  parseOne: (envPrefix: string, name: string) => T | undefined,
): { instances: Record<string, T>; primary: string } | undefined {
  const instances: Record<string, T> = {};
  const names = (env(`${prefix}_INSTANCES`) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const name of names) {
    const key = name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    if (probe && !env(`${prefix}_${key}_${probe}`)) {
      errors.push(`${prefix}_INSTANCES lists "${name}" but ${prefix}_${key}_${probe} is missing`);
      continue;
    }
    const inst = parseOne(`${prefix}_${key}_`, `${label} instance "${name}"`);
    if (inst) instances[name.toLowerCase()] = inst;
  }
  // Backward-compatible bare single instance → "default".
  const bare = parseOne(`${prefix}_`, label);
  if (bare) instances["default"] = bare;
  if (Object.keys(instances).length === 0) return undefined;

  const requested = env(`${prefix}_PRIMARY`)?.toLowerCase();
  if (requested && !instances[requested]) {
    errors.push(`${prefix}_PRIMARY="${requested}" is not one of the configured ${label} instances`);
  }
  const firstListed = names[0]?.toLowerCase();
  const primary =
    requested && instances[requested]
      ? requested
      : firstListed && instances[firstListed]
        ? firstListed
        : Object.keys(instances)[0];
  return { instances, primary };
}

/**
 * Each integration is enabled only when its required env vars are present.
 * Partially-configured integrations fail fast at boot with a clear message.
 */
export function loadConfig(): AppConfig {
  const errors: string[] = [];
  const integrations: Integrations = {};

  // --- Postgres ---
  const pgUrl = env("POSTGRES_URL") ?? env("DATABASE_URL");
  if (pgUrl) {
    const dbAllow = (env("POSTGRES_DB_ALLOW") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    integrations.postgres = {
      connectionString: pgUrl,
      pgbouncer: envBool("POSTGRES_PGBOUNCER"),
      dbAllow: dbAllow.length > 0 ? dbAllow : undefined,
    };
  }

  // --- MongoDB ---
  const mongoUri = env("MONGODB_URI");
  if (mongoUri) integrations.mongo = { uri: mongoUri };

  // --- Neo4j ---
  const neo4jUrl = env("NEO4J_URL");
  if (neo4jUrl) {
    const username = env("NEO4J_USERNAME");
    const password = env("NEO4J_PASSWORD");
    if (!username || !password) {
      errors.push("NEO4J_URL is set but NEO4J_USERNAME/NEO4J_PASSWORD are missing");
    } else {
      integrations.neo4j = { url: neo4jUrl, username, password, database: env("NEO4J_DATABASE") };
    }
  }

  // --- Elasticsearch (single or multi-instance) ---
  // Multi: ELASTICSEARCH_INSTANCES=prod,staging with ELASTICSEARCH_PROD_NODE
  // (+ _API_KEY or _USERNAME/_PASSWORD) per name. Bare ELASTICSEARCH_NODE →
  // "default".
  integrations.elastic = parseInstances<ElasticInstance>(
    "ELASTICSEARCH",
    "Elasticsearch",
    "NODE",
    errors,
    (p) => {
      const node = env(`${p}NODE`);
      if (!node) return undefined;
      return {
        node,
        apiKey: env(`${p}API_KEY`),
        username: env(`${p}USERNAME`),
        password: env(`${p}PASSWORD`),
      };
    },
  );

  // --- Kafka ---
  const kafkaBrokers = env("KAFKA_BROKERS");
  if (kafkaBrokers) {
    const mechanism = env("KAFKA_SASL_MECHANISM");
    if (mechanism && !["plain", "scram-sha-256", "scram-sha-512"].includes(mechanism)) {
      errors.push(`KAFKA_SASL_MECHANISM must be plain|scram-sha-256|scram-sha-512, got "${mechanism}"`);
    }
    integrations.kafka = {
      brokers: kafkaBrokers.split(",").map((b) => b.trim()).filter(Boolean),
      clientId: env("KAFKA_CLIENT_ID") ?? "ultimate-devops-mcp",
      ssl: envBool("KAFKA_SSL"),
      saslMechanism: mechanism as KafkaConfig["saslMechanism"],
      saslUsername: env("KAFKA_SASL_USERNAME"),
      saslPassword: env("KAFKA_SASL_PASSWORD"),
    };
  }

  // --- Redis ---
  const redisUrl = env("REDIS_URL");
  if (redisUrl) integrations.redis = { url: redisUrl };

  // --- Kubernetes ---
  if (envBool("K8S_ENABLED") || env("KUBECONFIG")) {
    integrations.kubernetes = { kubeconfigPath: env("KUBECONFIG") };
  }

  // --- Grafana (single or multi-instance) ---
  // Multi-instance: GRAFANA_INSTANCES=prod,nonprod with GRAFANA_PROD_URL /
  // GRAFANA_PROD_TOKEN (and _NONPROD_…) pairs. Single-instance (bare
  // GRAFANA_URL / GRAFANA_TOKEN) still works and registers as "default".
  {
    const instances: Record<string, GrafanaInstance> = {};
    const names = (env("GRAFANA_INSTANCES") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const name of names) {
      const key = name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
      const url = env(`GRAFANA_${key}_URL`);
      const token = env(`GRAFANA_${key}_TOKEN`) ?? env(`GRAFANA_${key}_API_KEY`);
      if (!url) {
        errors.push(`GRAFANA_INSTANCES lists "${name}" but GRAFANA_${key}_URL is missing`);
      } else if (!token) {
        errors.push(`GRAFANA_${key}_URL is set but GRAFANA_${key}_TOKEN (or _API_KEY) is missing`);
      } else {
        instances[name.toLowerCase()] = { url: url.replace(/\/+$/, ""), token };
      }
    }
    // Backward-compatible bare single instance → "default".
    const bareUrl = env("GRAFANA_URL");
    if (bareUrl) {
      const token = env("GRAFANA_TOKEN") ?? env("GRAFANA_API_KEY");
      if (!token) {
        errors.push("GRAFANA_URL is set but GRAFANA_TOKEN is missing");
      } else {
        instances["default"] = { url: bareUrl.replace(/\/+$/, ""), token };
      }
    }
    if (Object.keys(instances).length > 0) {
      const requested = env("GRAFANA_PRIMARY")?.toLowerCase();
      if (requested && !instances[requested]) {
        errors.push(`GRAFANA_PRIMARY="${requested}" is not one of the configured Grafana instances`);
      }
      const firstListed = names[0]?.toLowerCase();
      const primary =
        requested && instances[requested]
          ? requested
          : firstListed && instances[firstListed]
            ? firstListed
            : Object.keys(instances)[0];
      integrations.grafana = { instances, primary };
    }
  }

  // --- Datadog (single or multi-instance) ---
  // Multi: DATADOG_INSTANCES=prod,staging with DATADOG_PROD_API_KEY /
  // DATADOG_PROD_APP_KEY (+ optional _SITE) per name. Bare DATADOG_API_KEY +
  // DATADOG_APP_KEY → "default".
  integrations.datadog = parseInstances<DatadogInstance>(
    "DATADOG",
    "Datadog",
    "API_KEY",
    errors,
    (p) => {
      const apiKey = env(`${p}API_KEY`);
      if (!apiKey) return undefined;
      const appKey = env(`${p}APP_KEY`);
      if (!appKey) {
        errors.push(`${p}API_KEY is set but ${p}APP_KEY is missing`);
        return undefined;
      }
      return { site: env(`${p}SITE`) ?? "datadoghq.com", apiKey, appKey };
    },
  );

  // --- Prometheus (single or multi-instance) ---
  // Multi: PROMETHEUS_INSTANCES=prod,staging with PROMETHEUS_PROD_URL (+ optional
  // _BEARER_TOKEN) per name. Bare PROMETHEUS_URL → "default".
  integrations.prometheus = parseInstances<PrometheusInstance>(
    "PROMETHEUS",
    "Prometheus",
    "URL",
    errors,
    (p) => {
      const url = env(`${p}URL`);
      if (!url) return undefined;
      return { url: url.replace(/\/+$/, ""), bearerToken: env(`${p}BEARER_TOKEN`) };
    },
  );

  // --- ArgoCD (single or multi-instance) ---
  // Multi: ARGOCD_INSTANCES=prod,staging with ARGOCD_PROD_URL / ARGOCD_PROD_TOKEN
  // per name. Bare ARGOCD_URL + ARGOCD_TOKEN → "default".
  integrations.argocd = parseInstances<ArgoCDInstance>("ARGOCD", "ArgoCD", "URL", errors, (p) => {
    const url = env(`${p}URL`);
    if (!url) return undefined;
    const token = env(`${p}TOKEN`);
    if (!token) {
      errors.push(`${p}URL is set but ${p}TOKEN is missing`);
      return undefined;
    }
    return { url: url.replace(/\/+$/, ""), token };
  });

  // --- GitLab (single or multi-instance) ---
  // Multi: GITLAB_INSTANCES=prod,onprem with GITLAB_PROD_TOKEN (+ optional _URL)
  // per name. Bare GITLAB_TOKEN → "default".
  integrations.gitlab = parseInstances<GitlabInstance>("GITLAB", "GitLab", "TOKEN", errors, (p) => {
    const token = env(`${p}TOKEN`);
    if (!token) return undefined;
    return { url: (env(`${p}URL`) ?? "https://gitlab.com").replace(/\/+$/, ""), token };
  });

  // --- GitHub (github.com or GHE; single or multi-instance) ---
  // Multi: GITHUB_INSTANCES=cloud,ghe with GITHUB_CLOUD_TOKEN (+ optional
  // _API_URL like https://ghe.co/api/v3) per name. Bare GITHUB_TOKEN → "default".
  integrations.github = parseInstances<GitHubInstance>("GITHUB", "GitHub", "TOKEN", errors, (p) => {
    const token = env(`${p}TOKEN`);
    if (!token) return undefined;
    return { baseUrl: (env(`${p}API_URL`) ?? "https://api.github.com").replace(/\/+$/, ""), token };
  });

  // --- Bitbucket (Cloud API 2.0: access token, or username + app password) ---
  // Multi: BITBUCKET_INSTANCES=prod,sandbox with BITBUCKET_PROD_TOKEN (or
  // _USERNAME + _APP_PASSWORD, + optional _WORKSPACE / _API_URL) per name. Bare
  // BITBUCKET_TOKEN (or USERNAME+APP_PASSWORD) → "default".
  integrations.bitbucket = parseInstances<BitbucketInstance>(
    "BITBUCKET",
    "Bitbucket",
    undefined,
    errors,
    (p, name) => {
      const token = env(`${p}TOKEN`);
      const user = env(`${p}USERNAME`);
      const pass = env(`${p}APP_PASSWORD`);
      if (!token && !(user && pass)) {
        if (user || pass) {
          errors.push(`${name} needs ${p}TOKEN, or BOTH ${p}USERNAME and ${p}APP_PASSWORD`);
        }
        return undefined;
      }
      return {
        baseUrl: (env(`${p}API_URL`) ?? "https://api.bitbucket.org/2.0").replace(/\/+$/, ""),
        authHeader: token
          ? `Bearer ${token}`
          : `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`,
        workspace: env(`${p}WORKSPACE`),
      };
    },
  );

  // --- Jira (single or multi-instance; Cloud basic-auth or Server/DC bearer) ---
  // Cloud:  JIRA_URL + JIRA_EMAIL + JIRA_API_TOKEN  (REST v3)
  // Server: JIRA_URL + JIRA_TOKEN                    (REST v2, bearer PAT)
  // Multi:  JIRA_INSTANCES=prod,sandbox + JIRA_PROD_URL/EMAIL/API_TOKEN … pairs.
  {
    const parseJira = (prefix: string, label: string): JiraInstance | undefined => {
      const url = env(`${prefix}URL`);
      if (!url) return undefined; // not configured
      const email = env(`${prefix}EMAIL`);
      const apiToken = env(`${prefix}API_TOKEN`);
      const token = env(`${prefix}TOKEN`);
      if (email && apiToken) {
        return {
          baseUrl: url.replace(/\/+$/, ""),
          authHeader: `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`,
          apiVersion: 3,
        };
      }
      if (token) {
        return { baseUrl: url.replace(/\/+$/, ""), authHeader: `Bearer ${token}`, apiVersion: 2 };
      }
      errors.push(
        `${label} needs ${prefix}EMAIL + ${prefix}API_TOKEN (Jira Cloud) or ${prefix}TOKEN (Server/DC)`,
      );
      return undefined;
    };

    const instances: Record<string, JiraInstance> = {};
    const names = (env("JIRA_INSTANCES") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const name of names) {
      const key = name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
      if (!env(`JIRA_${key}_URL`)) {
        errors.push(`JIRA_INSTANCES lists "${name}" but JIRA_${key}_URL is missing`);
        continue;
      }
      const inst = parseJira(`JIRA_${key}_`, `Jira instance "${name}"`);
      if (inst) instances[name.toLowerCase()] = inst;
    }
    const bare = parseJira("JIRA_", "Jira");
    if (bare) instances["default"] = bare;

    if (Object.keys(instances).length > 0) {
      const requested = env("JIRA_PRIMARY")?.toLowerCase();
      if (requested && !instances[requested]) {
        errors.push(`JIRA_PRIMARY="${requested}" is not one of the configured Jira instances`);
      }
      const firstListed = names[0]?.toLowerCase();
      const primary =
        requested && instances[requested]
          ? requested
          : firstListed && instances[firstListed]
            ? firstListed
            : Object.keys(instances)[0];
      integrations.jira = { instances, primary };
    }
  }

  // --- Playwright ---
  if (envBool("PLAYWRIGHT_ENABLED")) {
    integrations.playwright = { noSandbox: envBool("PLAYWRIGHT_NO_SANDBOX") };
  }

  // --- Temporal (Cloud: API key + TLS; self-hosted: plain gRPC or mTLS) ---
  const temporalAddress = env("TEMPORAL_ADDRESS");
  if (temporalAddress) {
    const apiKey = env("TEMPORAL_API_KEY");
    integrations.temporal = {
      address: temporalAddress,
      namespace: env("TEMPORAL_NAMESPACE") ?? "default",
      apiKey,
      // Temporal Cloud always uses TLS; self-hosted honors TEMPORAL_TLS / mTLS paths.
      tls: apiKey ? true : envBool("TEMPORAL_TLS") || Boolean(env("TEMPORAL_TLS_CERT")),
      tlsCert: env("TEMPORAL_TLS_CERT"),
      tlsKey: env("TEMPORAL_TLS_KEY"),
      tlsCA: env("TEMPORAL_TLS_CA"),
      serverName: env("TEMPORAL_TLS_SERVER_NAME"),
    };
    if (integrations.temporal.tlsCert && !integrations.temporal.tlsKey) {
      errors.push("TEMPORAL_TLS_CERT is set but TEMPORAL_TLS_KEY is missing (mTLS needs both)");
    }
  }

  // --- MCP federation (front other MCP servers, re-expose their tools namespaced) ---
  // MCP_FEDERATE=name1,name2 with MCP_FEDERATE_<NAME>_URL (required) and
  // MCP_FEDERATE_<NAME>_TOKEN (optional bearer) per entry.
  let federation: FederationConfig | undefined;
  {
    const names = (env("MCP_FEDERATE") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const servers: FederatedServerConfig[] = [];
    for (const name of names) {
      const key = name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
      const url = env(`MCP_FEDERATE_${key}_URL`);
      if (!url) {
        errors.push(`MCP_FEDERATE lists "${name}" but MCP_FEDERATE_${key}_URL is missing`);
        continue;
      }
      servers.push({
        name: name.toLowerCase(),
        url: url.replace(/\/+$/, ""),
        token: env(`MCP_FEDERATE_${key}_TOKEN`),
      });
    }
    if (servers.length > 0) federation = { servers };
  }

  // --- Scoped API keys (optional; MCP_AUTH_TOKEN stays a full-access key) ---
  // MCP_API_KEYS is a JSON object mapping each token secret to a scope:
  //   {"tok_ci":{"name":"ci","tools":["postgres_query"],"allowWrites":false}}
  let apiKeys: Record<string, KeyIdentity> | undefined;
  const rawKeys = env("MCP_API_KEYS");
  if (rawKeys) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawKeys);
    } catch {
      errors.push("MCP_API_KEYS is not valid JSON (expected an object mapping token -> scope)");
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const map: Record<string, KeyIdentity> = {};
      for (const [secret, spec] of Object.entries(parsed as Record<string, unknown>)) {
        if (!secret || typeof spec !== "object" || spec === null || Array.isArray(spec)) {
          errors.push(`MCP_API_KEYS["${secret}"] must be an object { name, tools?, allowWrites? }`);
          continue;
        }
        const s = spec as { name?: unknown; tools?: unknown; allowWrites?: unknown };
        map[secret] = {
          name: typeof s.name === "string" && s.name.trim() ? s.name.trim() : "unnamed",
          tools: Array.isArray(s.tools) ? s.tools.filter((t): t is string => typeof t === "string") : undefined,
          allowWrites: s.allowWrites === true,
        };
      }
      if (Object.keys(map).length > 0) apiKeys = map;
    } else if (parsed !== undefined) {
      errors.push("MCP_API_KEYS must be a JSON object mapping token -> scope");
    }
  }

  if (errors.length > 0) {
    throw new Error(`Configuration errors:\n  - ${errors.join("\n  - ")}`);
  }

  return {
    // Bind loopback by default so the server isn't network-exposed out of the
    // box (it holds real integration credentials + is unauthenticated unless
    // MCP_AUTH_TOKEN is set). Set MCP_HTTP_HOST=0.0.0.0 to expose it deliberately
    // (only behind auth + network policy; the Docker image sets it explicitly).
    host: env("MCP_HTTP_HOST") ?? "127.0.0.1",
    port: envInt("MCP_HTTP_PORT", 8080),
    authToken: env("MCP_AUTH_TOKEN"),
    apiKeys,
    allowWrites: envBool("MCP_ALLOW_WRITES"),
    writeDryRun: envBool("MCP_WRITE_DRYRUN"),
    logLevel: env("LOG_LEVEL") ?? "info",
    rateLimitPerMinute: envInt("MCP_RATE_LIMIT_PER_MINUTE", 300),
    sessionIdleTimeoutMs: envInt("MCP_SESSION_IDLE_TIMEOUT_MINUTES", 30) * 60_000,
    maxResultChars: envInt("MCP_MAX_RESULT_CHARS", 50_000),
    trustProxy: envBool("MCP_TRUST_PROXY"),
    integrations,
    federation,
  };
}

export function enabledIntegrationNames(config: AppConfig): string[] {
  return Object.entries(config.integrations)
    .filter(([, v]) => v !== undefined)
    .map(([k]) => k);
}
