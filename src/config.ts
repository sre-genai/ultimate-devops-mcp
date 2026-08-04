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
export interface ElasticConfig {
  node: string;
  apiKey?: string;
  username?: string;
  password?: string;
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
export interface DatadogConfig {
  site: string;
  apiKey: string;
  appKey: string;
}
export interface PrometheusConfig {
  url: string;
  bearerToken?: string;
}
export interface ArgoCDConfig {
  url: string;
  token: string;
}
export interface GitlabConfig {
  url: string;
  token: string;
}
export interface GitHubConfig {
  baseUrl: string;
  token: string;
}
export interface BitbucketConfig {
  baseUrl: string;
  authHeader: string;
  workspace?: string;
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

  // --- Elasticsearch ---
  const esNode = env("ELASTICSEARCH_NODE");
  if (esNode) {
    integrations.elastic = {
      node: esNode,
      apiKey: env("ELASTICSEARCH_API_KEY"),
      username: env("ELASTICSEARCH_USERNAME"),
      password: env("ELASTICSEARCH_PASSWORD"),
    };
  }

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

  // --- Datadog ---
  const ddApiKey = env("DATADOG_API_KEY");
  if (ddApiKey) {
    const appKey = env("DATADOG_APP_KEY");
    if (!appKey) {
      errors.push("DATADOG_API_KEY is set but DATADOG_APP_KEY is missing");
    } else {
      integrations.datadog = {
        site: env("DATADOG_SITE") ?? "datadoghq.com",
        apiKey: ddApiKey,
        appKey,
      };
    }
  }

  // --- Prometheus ---
  const promUrl = env("PROMETHEUS_URL");
  if (promUrl) {
    integrations.prometheus = {
      url: promUrl.replace(/\/+$/, ""),
      bearerToken: env("PROMETHEUS_BEARER_TOKEN"),
    };
  }

  // --- ArgoCD ---
  const argocdUrl = env("ARGOCD_URL");
  if (argocdUrl) {
    const token = env("ARGOCD_TOKEN");
    if (!token) {
      errors.push("ARGOCD_URL is set but ARGOCD_TOKEN is missing");
    } else {
      integrations.argocd = { url: argocdUrl.replace(/\/+$/, ""), token };
    }
  }

  // --- GitLab ---
  const gitlabToken = env("GITLAB_TOKEN");
  if (gitlabToken) {
    integrations.gitlab = {
      url: (env("GITLAB_URL") ?? "https://gitlab.com").replace(/\/+$/, ""),
      token: gitlabToken,
    };
  }

  // --- GitHub (github.com or GHE; GITHUB_API_URL like https://ghe.co/api/v3) ---
  const githubToken = env("GITHUB_TOKEN");
  if (githubToken) {
    integrations.github = {
      baseUrl: (env("GITHUB_API_URL") ?? "https://api.github.com").replace(/\/+$/, ""),
      token: githubToken,
    };
  }

  // --- Bitbucket (Cloud API 2.0: access token, or username + app password) ---
  const bbToken = env("BITBUCKET_TOKEN");
  const bbUser = env("BITBUCKET_USERNAME");
  const bbPass = env("BITBUCKET_APP_PASSWORD");
  if (bbToken || (bbUser && bbPass)) {
    integrations.bitbucket = {
      baseUrl: (env("BITBUCKET_API_URL") ?? "https://api.bitbucket.org/2.0").replace(/\/+$/, ""),
      authHeader: bbToken
        ? `Bearer ${bbToken}`
        : `Basic ${Buffer.from(`${bbUser}:${bbPass}`).toString("base64")}`,
      workspace: env("BITBUCKET_WORKSPACE"),
    };
  } else if (bbUser || bbPass) {
    errors.push(
      "Bitbucket needs BITBUCKET_TOKEN, or BOTH BITBUCKET_USERNAME and BITBUCKET_APP_PASSWORD",
    );
  }

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
  };
}

export function enabledIntegrationNames(config: AppConfig): string[] {
  return Object.entries(config.integrations)
    .filter(([, v]) => v !== undefined)
    .map(([k]) => k);
}
