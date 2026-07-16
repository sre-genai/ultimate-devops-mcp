import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./config.js";
import { jsonResult, safe } from "./util.js";
import { registerPostgres } from "./integrations/postgres.js";
import { registerMongo } from "./integrations/mongo.js";
import { registerNeo4j } from "./integrations/neo4j.js";
import { registerElastic } from "./integrations/elastic.js";
import { registerKafka } from "./integrations/kafka.js";
import { registerRedis } from "./integrations/redis.js";
import { registerKubernetes } from "./integrations/kubernetes.js";
import { registerGrafana } from "./integrations/grafana.js";
import { registerDatadog } from "./integrations/datadog.js";
import { registerPrometheus } from "./integrations/prometheus.js";
import { registerArgoCD } from "./integrations/argocd.js";
import { registerGitlab } from "./integrations/gitlab.js";
import { registerGitHub } from "./integrations/github.js";
import { registerBitbucket } from "./integrations/bitbucket.js";
import { registerJira } from "./integrations/jira.js";
import { registerPlaywright } from "./integrations/playwright.js";
import { registerTemporal } from "./integrations/temporal.js";

export const SERVER_NAME = "ultimate-devops-mcp";
export const SERVER_VERSION = "1.0.0";

type Registrar = (server: McpServer, config: AppConfig) => boolean;

const REGISTRARS: Record<string, Registrar> = {
  postgres: registerPostgres,
  mongodb: registerMongo,
  neo4j: registerNeo4j,
  elasticsearch: registerElastic,
  kafka: registerKafka,
  redis: registerRedis,
  kubernetes: registerKubernetes,
  grafana: registerGrafana,
  datadog: registerDatadog,
  prometheus: registerPrometheus,
  argocd: registerArgoCD,
  gitlab: registerGitlab,
  github: registerGitHub,
  bitbucket: registerBitbucket,
  jira: registerJira,
  playwright: registerPlaywright,
  temporal: registerTemporal,
};

/**
 * Builds an McpServer instance for one client session. Tool handlers reference
 * module-level lazy clients, so DB pools / producers / browsers are shared
 * across sessions and created only on first use.
 */
export function createMcpServer(config: AppConfig): { server: McpServer; enabled: string[] } {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const enabled: string[] = [];
  for (const [name, register] of Object.entries(REGISTRARS)) {
    if (register(server, config)) enabled.push(name);
  }

  server.registerTool(
    "devops_status",
    {
      title: "DevOps MCP status",
      description:
        "Shows which integrations are enabled on this server, whether write operations are allowed, and the server version. Call this first to discover what this server can reach.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safe("devops_status", async () =>
      jsonResult({
        server: SERVER_NAME,
        version: SERVER_VERSION,
        enabledIntegrations: enabled,
        writesAllowed: config.allowWrites,
        hint:
          enabled.length === 0
            ? "No integrations configured. Set integration env vars (e.g. POSTGRES_URL, GRAFANA_URL+GRAFANA_TOKEN) and restart."
            : undefined,
      }),
    ),
  );

  return { server, enabled };
}
