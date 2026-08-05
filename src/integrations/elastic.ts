import { Client } from "@elastic/elasticsearch";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig, ElasticInstance } from "../config.js";
import { jsonResult, registerCloser, safe } from "../util.js";

// One lazily-created client per named instance, shared across sessions.
const clients = new Map<string, Client>();

function getClient(name: string, cfg: ElasticInstance): Client {
  let client = clients.get(name);
  if (!client) {
    client = new Client({
      node: cfg.node,
      auth: cfg.apiKey
        ? { apiKey: cfg.apiKey }
        : cfg.username && cfg.password
          ? { username: cfg.username, password: cfg.password }
          : undefined,
      requestTimeout: 30_000,
    });
    clients.set(name, client);
    registerCloser(`elasticsearch:${name}`, async () => {
      await clients.get(name)?.close();
      clients.delete(name);
    });
  }
  return client;
}

export function registerElastic(server: McpServer, config: AppConfig): boolean {
  const cfg = config.integrations.elastic;
  if (!cfg) return false;
  const { instances, primary } = cfg;

  const names = Object.keys(instances);
  const multi = names.length > 1;
  const instanceArg = z
    .enum(names as [string, ...string[]])
    .optional()
    .describe(
      multi
        ? `Which Elasticsearch to target: ${names.join(", ")} (default: ${primary}).`
        : `Elasticsearch instance (only "${primary}" configured; optional).`,
    );

  function pick(instance?: string): Client {
    const name = instance ?? primary;
    const inst = instances[name];
    if (!inst) {
      throw new Error(`Unknown Elasticsearch instance "${instance}". Configured: ${names.join(", ")}.`);
    }
    return getClient(name, inst);
  }

  server.registerTool(
    "es_search",
    {
      title: "Search Elasticsearch",
      description:
        'Runs a search against an index. Query uses Elasticsearch Query DSL as JSON, e.g. {"match": {"message": "error"}}. Omit query for match_all.',
      inputSchema: {
        instance: instanceArg,
        index: z.string().describe("Index name or pattern, e.g. logs-*"),
        query: z.record(z.unknown()).optional().describe("Query DSL object (default match_all)"),
        size: z.number().int().min(1).max(100).optional().describe("Number of hits (default 10)"),
        from: z.number().int().min(0).optional().describe("Offset for pagination"),
        sort: z.array(z.record(z.unknown())).optional().describe('Sort spec, e.g. [{"@timestamp": "desc"}]'),
        aggs: z.record(z.unknown()).optional().describe("Aggregations object"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("es_search", async ({ instance, index, query, size, from, sort, aggs }) => {
      const res = await pick(instance).search({
        index,
        query: (query ?? { match_all: {} }) as Record<string, unknown>,
        size: size ?? 10,
        from,
        sort: sort as never,
        aggs: aggs as never,
      });
      return jsonResult({
        took: res.took,
        total: res.hits.total,
        hits: res.hits.hits,
        aggregations: res.aggregations,
      });
    }),
  );

  server.registerTool(
    "es_list_indices",
    {
      title: "List Elasticsearch indices",
      description: "Lists indices with health, doc count and size.",
      inputSchema: {
        instance: instanceArg,
        pattern: z.string().optional().describe("Index pattern filter, e.g. logs-*"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("es_list_indices", async ({ instance, pattern }) => {
      const res = await pick(instance).cat.indices({
        index: pattern,
        format: "json",
        h: "health,status,index,docs.count,store.size,pri,rep",
        s: "index",
      });
      return jsonResult(res);
    }),
  );

  server.registerTool(
    "es_cluster_health",
    {
      title: "Elasticsearch cluster health",
      description: "Returns cluster health: status, nodes, shards, pending tasks.",
      inputSchema: {
        instance: instanceArg,
      },
      annotations: { readOnlyHint: true },
    },
    safe("es_cluster_health", async ({ instance }) => jsonResult(await pick(instance).cluster.health())),
  );

  server.registerTool(
    "es_get_document",
    {
      title: "Get Elasticsearch document",
      description: "Fetches a single document by index and ID.",
      inputSchema: {
        instance: instanceArg,
        index: z.string(),
        id: z.string(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("es_get_document", async ({ instance, index, id }) => jsonResult(await pick(instance).get({ index, id }))),
  );

  return true;
}
