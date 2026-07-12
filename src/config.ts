import "dotenv/config";

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
export interface GrafanaConfig {
  url: string;
  token: string;
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
  playwright?: PlaywrightConfig;
  temporal?: TemporalConfig;
}

export interface AppConfig {
  host: string;
  port: number;
  authToken?: string;
  allowWrites: boolean;
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

  // --- Grafana ---
  const grafanaUrl = env("GRAFANA_URL");
  if (grafanaUrl) {
    const token = env("GRAFANA_TOKEN") ?? env("GRAFANA_API_KEY");
    if (!token) {
      errors.push("GRAFANA_URL is set but GRAFANA_TOKEN is missing");
    } else {
      integrations.grafana = { url: grafanaUrl.replace(/\/+$/, ""), token };
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

  if (errors.length > 0) {
    throw new Error(`Configuration errors:\n  - ${errors.join("\n  - ")}`);
  }

  return {
    host: env("MCP_HTTP_HOST") ?? "0.0.0.0",
    port: envInt("MCP_HTTP_PORT", 8080),
    authToken: env("MCP_AUTH_TOKEN"),
    allowWrites: envBool("MCP_ALLOW_WRITES"),
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
