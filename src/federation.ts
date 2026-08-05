// MCP federation: front other MCP servers and re-expose their tools through
// this server's single /mcp endpoint, namespaced as `<name>__<remoteTool>`.
//
// Remote servers are contacted once (on the first session that needs them) over
// Streamable HTTP; the connected clients and their tool lists are cached at
// module scope and reused across sessions, so each per-session McpServer only
// registers lightweight proxy tools that forward calls over the shared clients.
// A connection failure logs and skips that server — it never blocks boot.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig, FederatedServerConfig } from "./config.js";
import { logger } from "./logger.js";
import { registerCloser, safe } from "./util.js";

const CLIENT_NAME = "ultimate-devops-mcp-federation";
const CLIENT_VERSION = "1.0.0";

interface RemoteTool {
  name: string;
  description?: string;
  inputSchema?: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
  annotations?: Record<string, unknown>;
}

interface FederatedEntry {
  client: Client;
  tools: RemoteTool[];
}

// Populated once, keyed by federated server name; reused across all sessions.
const cache = new Map<string, FederatedEntry>();
let discovery: Promise<void> | undefined;

/** Connects to one remote server, lists its tools, and caches the client. */
async function connectServer(cfg: FederatedServerConfig): Promise<void> {
  const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });
  const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
    requestInit: cfg.token ? { headers: { authorization: `Bearer ${cfg.token}` } } : undefined,
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    cache.set(cfg.name, { client, tools: tools as RemoteTool[] });
    registerCloser(`federation:${cfg.name}`, () => client.close());
    logger.info(
      { server: cfg.name, url: cfg.url, tools: tools.length },
      "connected to federated MCP server",
    );
  } catch (err) {
    // Skip this server — a downstream being unreachable must not crash boot.
    await client.close().catch(() => {});
    logger.warn(
      { server: cfg.name, url: cfg.url, err: err instanceof Error ? err.message : String(err) },
      "failed to connect to federated MCP server — skipping",
    );
  }
}

/** Connects to every configured remote server once (concurrently). */
async function discover(servers: FederatedServerConfig[]): Promise<void> {
  await Promise.all(servers.map(connectServer));
}

/**
 * Turns a remote tool's JSON-Schema input into a permissive Zod object so the
 * proxy advertises the real parameters yet never strips arguments it doesn't
 * recognize (`.passthrough()`) — the remote server remains the source of truth
 * for validation.
 */
function toZod(schema: unknown): z.ZodTypeAny {
  if (!schema || typeof schema !== "object") return z.any();
  const s = schema as Record<string, unknown>;
  if (Array.isArray(s.enum) && s.enum.length > 0 && s.enum.every((v) => typeof v === "string")) {
    return z.enum(s.enum as [string, ...string[]]);
  }
  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  let zod: z.ZodTypeAny;
  switch (type) {
    case "string":
      zod = z.string();
      break;
    case "number":
      zod = z.number();
      break;
    case "integer":
      zod = z.number().int();
      break;
    case "boolean":
      zod = z.boolean();
      break;
    case "array":
      zod = z.array(s.items ? toZod(s.items) : z.any());
      break;
    case "object":
      zod = toZodObject(s);
      break;
    default:
      zod = z.any();
  }
  if (typeof s.description === "string") zod = zod.describe(s.description);
  return zod;
}

function toZodObject(schema: Record<string, unknown>): z.ZodTypeAny {
  const props = (schema.properties as Record<string, unknown>) ?? {};
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, value] of Object.entries(props)) {
    let field = toZod(value);
    if (!required.has(key)) field = field.optional();
    shape[key] = field;
  }
  return z.object(shape).passthrough();
}

/** Registers a single proxy tool that forwards to the remote server. */
function registerProxy(server: McpServer, name: string, client: Client, tool: RemoteTool): void {
  const proxyName = `${name}__${tool.name}`;
  server.registerTool(
    proxyName,
    {
      title: (tool.annotations?.title as string | undefined) ?? proxyName,
      description: `[federated: ${name}] ${tool.description ?? `Proxies ${tool.name} on the "${name}" MCP server.`}`,
      inputSchema: toZodObject(tool.inputSchema ?? { type: "object" }),
      annotations: tool.annotations,
    },
    safe(proxyName, async (args: Record<string, unknown>) => {
      const result = await client.callTool({ name: tool.name, arguments: args });
      return result as CallToolResult;
    }),
  );
}

/**
 * Registers proxy tools for every reachable federated server onto `server`.
 * Returns the names of the servers that connected (and thus contributed tools).
 * Safe to call once per session: remote connections are established only on the
 * first call and cached thereafter.
 */
export async function registerFederation(server: McpServer, config: AppConfig): Promise<string[]> {
  const cfg = config.federation;
  if (!cfg || cfg.servers.length === 0) return [];

  if (!discovery) discovery = discover(cfg.servers);
  await discovery;

  const active: string[] = [];
  for (const [name, entry] of cache) {
    for (const tool of entry.tools) registerProxy(server, name, entry.client, tool);
    active.push(name);
  }
  return active;
}
