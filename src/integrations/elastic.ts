import { Client } from "@elastic/elasticsearch";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig, ElasticConfig } from "../config.js";
import { jsonResult, registerCloser, safe } from "../util.js";

let client: Client | undefined;

function getClient(cfg: ElasticConfig): Client {
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
    registerCloser("elasticsearch", async () => {
      await client?.close();
      client = undefined;
    });
  }
  return client;
}

export function registerElastic(server: McpServer, config: AppConfig): boolean {
  const cfg = config.integrations.elastic;
  if (!cfg) return false;

  server.registerTool(
    "es_search",
    {
      title: "Search Elasticsearch",
      description:
        'Runs a search against an index. Query uses Elasticsearch Query DSL as JSON, e.g. {"match": {"message": "error"}}. Omit query for match_all.',
      inputSchema: {
        index: z.string().describe("Index name or pattern, e.g. logs-*"),
        query: z.record(z.unknown()).optional().describe("Query DSL object (default match_all)"),
        size: z.number().int().min(1).max(100).optional().describe("Number of hits (default 10)"),
        from: z.number().int().min(0).optional().describe("Offset for pagination"),
        sort: z.array(z.record(z.unknown())).optional().describe('Sort spec, e.g. [{"@timestamp": "desc"}]'),
        aggs: z.record(z.unknown()).optional().describe("Aggregations object"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("es_search", async ({ index, query, size, from, sort, aggs }) => {
      const res = await getClient(cfg).search({
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
        pattern: z.string().optional().describe("Index pattern filter, e.g. logs-*"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("es_list_indices", async ({ pattern }) => {
      const res = await getClient(cfg).cat.indices({
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
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safe("es_cluster_health", async () => jsonResult(await getClient(cfg).cluster.health())),
  );

  server.registerTool(
    "es_get_document",
    {
      title: "Get Elasticsearch document",
      description: "Fetches a single document by index and ID.",
      inputSchema: {
        index: z.string(),
        id: z.string(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("es_get_document", async ({ index, id }) => jsonResult(await getClient(cfg).get({ index, id }))),
  );

  return true;
}
