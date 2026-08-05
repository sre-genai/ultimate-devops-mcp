import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "./config.js";
import { errorResult, jsonResult, safe } from "./util.js";
import { audit, currentContext, keyAllowsTool, LOCAL_IDENTITY } from "./audit.js";
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
import { registerFederation } from "./federation.js";
import { registerPagerDuty } from "./integrations/pagerduty.js";
import { registerSentry } from "./integrations/sentry.js";
import { registerJenkins } from "./integrations/jenkins.js";
import { registerSlack } from "./integrations/slack.js";
import { registerVault } from "./integrations/vault.js";
import { registerInvestigate } from "./tools/investigate.js";

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
  pagerduty: registerPagerDuty,
  sentry: registerSentry,
  jenkins: registerJenkins,
  slack: registerSlack,
  vault: registerVault,
};

/**
 * Governance interceptor: wrap `server.registerTool` so every tool handler is
 * enforced and audited at the single dispatch point that already sees the tool
 * name, its annotations (read vs. write), and the handler. Chosen over wrapping
 * util.ts `safe()` because only here is the read/write signal available, and it
 * leaves the shared util.ts untouched. A tool is treated as a write unless it is
 * explicitly `readOnlyHint: true` (fail-closed for governance). Enforced, in
 * order: per-key tool allowlist -> per-key write permission -> write dry-run.
 */
function installGovernance(server: McpServer, config: AppConfig): void {
  const original = server.registerTool.bind(server);
  const patched: typeof server.registerTool = ((name: string, def: any, handler: any) => {
    const isWrite = def?.annotations?.readOnlyHint !== true;
    const governed = async (args: unknown, extra: unknown): Promise<CallToolResult> => {
      const started = Date.now();
      const ctx = currentContext();
      const key = ctx?.key ?? LOCAL_IDENTITY;
      const sessionId = ctx?.sessionId;
      const emit = (outcome: "allowed" | "denied" | "dry-run" | "error", reason?: string) =>
        audit({ tool: name, write: isWrite, key: key.name, sessionId, outcome, reason, durationMs: Date.now() - started });

      if (!keyAllowsTool(key, name)) {
        emit("denied", "tool not in key scope");
        return errorResult(new Error(`Tool "${name}" is not permitted for this API key`));
      }
      if (isWrite && !key.allowWrites) {
        emit("denied", "writes not permitted for key");
        return errorResult(new Error(`Write tool "${name}" is not permitted for this API key`));
      }
      if (isWrite && config.writeDryRun) {
        emit("dry-run");
        return jsonResult({
          dryRun: true,
          tool: name,
          note: "MCP_WRITE_DRYRUN is enabled — no changes were made. This is a preview of the requested write.",
          args,
        });
      }
      const result = await handler(args, extra);
      emit((result as CallToolResult)?.isError ? "error" : "allowed");
      return result as CallToolResult;
    };
    return original(name, def, governed as typeof handler);
  }) as typeof server.registerTool;
  // Shadow the instance method so every subsequent registerTool call is governed.
  (server as { registerTool: typeof server.registerTool }).registerTool = patched;
}

/**
 * Builds an McpServer instance for one client session. Tool handlers reference
 * module-level lazy clients, so DB pools / producers / browsers are shared
 * across sessions and created only on first use.
 */
export async function createMcpServer(
  config: AppConfig,
): Promise<{ server: McpServer; enabled: string[] }> {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  installGovernance(server, config);

  const enabled: string[] = [];
  for (const [name, register] of Object.entries(REGISTRARS)) {
    if (register(server, config)) enabled.push(name);
  }

  // Federated MCP servers re-expose their tools as `<name>__<remoteTool>`.
  const federated = await registerFederation(server, config);
  for (const name of federated) enabled.push(`federation:${name}`);

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

  // Cross-integration meta-tool: correlates one service's signals across every
  // enabled integration in a single call.
  registerInvestigate(server, config);

  return { server, enabled };
}
