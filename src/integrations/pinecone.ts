import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig, PineconeConfig } from "../config.js";
import { httpRequest, jsonResult, safe } from "../util.js";

type Obj = Record<string, unknown>;

// Control-plane calls (index management) go to api.pinecone.io; data-plane calls
// (stats/query/upsert/delete) go to the per-index host returned by describe.
function control(cfg: PineconeConfig, path: string, opts: Parameters<typeof httpRequest>[1] = {}) {
  return httpRequest(`https://api.pinecone.io${path}`, {
    ...opts,
    headers: { "Api-Key": cfg.apiKey, "X-Pinecone-API-Version": cfg.apiVersion, ...(opts.headers ?? {}) },
  });
}
function data(cfg: PineconeConfig, host: string, path: string, opts: Parameters<typeof httpRequest>[1] = {}) {
  return httpRequest(`https://${host}${path}`, {
    ...opts,
    headers: { "Api-Key": cfg.apiKey, "X-Pinecone-API-Version": cfg.apiVersion, ...(opts.headers ?? {}) },
  });
}

// Cache index-name -> data-plane host so query/stats/upsert don't re-describe every call.
const hostCache = new Map<string, string>();
async function hostFor(cfg: PineconeConfig, index: string): Promise<string> {
  const cached = hostCache.get(index);
  if (cached) return cached;
  const desc = (await control(cfg, `/indexes/${encodeURIComponent(index)}`)) as { host?: string };
  if (!desc?.host) throw new Error(`Index "${index}" has no host (is it ready?)`);
  hostCache.set(index, desc.host);
  return desc.host;
}

export function registerPinecone(server: McpServer, config: AppConfig): boolean {
  const cfg = config.integrations.pinecone;
  if (!cfg) return false;

  server.registerTool(
    "pinecone_list_indexes",
    {
      title: "List Pinecone indexes",
      description: "Lists all indexes in the project, with dimension, metric, host and status.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safe("pinecone_list_indexes", async () => {
      const res = (await control(cfg, "/indexes")) as { indexes?: Obj[] };
      return jsonResult(
        (res?.indexes ?? []).map((i) => ({
          name: i.name,
          dimension: i.dimension,
          metric: i.metric,
          host: i.host,
          status: i.status,
          spec: i.spec,
        })),
      );
    }),
  );

  server.registerTool(
    "pinecone_describe_index",
    {
      title: "Describe Pinecone index",
      description: "Full configuration and status of one index.",
      inputSchema: { index: z.string().describe("Index name") },
      annotations: { readOnlyHint: true },
    },
    safe("pinecone_describe_index", async ({ index }) =>
      jsonResult(await control(cfg, `/indexes/${encodeURIComponent(index)}`)),
    ),
  );

  server.registerTool(
    "pinecone_index_stats",
    {
      title: "Pinecone index stats",
      description: "Vector counts per namespace, dimension and index fullness for an index.",
      inputSchema: {
        index: z.string().describe("Index name"),
        filter: z.record(z.any()).optional().describe("Optional metadata filter to scope the counts"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("pinecone_index_stats", async ({ index, filter }) => {
      const host = await hostFor(cfg, index);
      return jsonResult(await data(cfg, host, "/describe_index_stats", { method: "POST", body: filter ? { filter } : {} }));
    }),
  );

  server.registerTool(
    "pinecone_query",
    {
      title: "Query Pinecone (vector search)",
      description:
        "Nearest-neighbour search in an index. Provide either a raw `vector` or an existing `id` to search by. Returns the topK matches with scores.",
      inputSchema: {
        index: z.string().describe("Index name"),
        topK: z.number().int().min(1).max(1000).optional().describe("Number of matches (default 10)"),
        vector: z.array(z.number()).optional().describe("Query vector (mutually exclusive with id)"),
        id: z.string().optional().describe("Query by an existing vector's id (mutually exclusive with vector)"),
        namespace: z.string().optional(),
        filter: z.record(z.any()).optional().describe("Metadata filter"),
        includeMetadata: z.boolean().optional(),
        includeValues: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("pinecone_query", async ({ index, topK, vector, id, namespace, filter, includeMetadata, includeValues }) => {
      if (!vector && !id) throw new Error("Provide either `vector` or `id` to query by");
      const host = await hostFor(cfg, index);
      const body: Obj = { topK: topK ?? 10, includeMetadata: includeMetadata ?? true, includeValues: includeValues ?? false };
      if (vector) body.vector = vector;
      if (id) body.id = id;
      if (namespace) body.namespace = namespace;
      if (filter) body.filter = filter;
      return jsonResult(await data(cfg, host, "/query", { method: "POST", body }));
    }),
  );

  if (config.allowWrites) {
    server.registerTool(
      "pinecone_upsert",
      {
        title: "Upsert vectors into Pinecone (write)",
        description: "Inserts or overwrites vectors in an index. Enabled because MCP_ALLOW_WRITES=true.",
        inputSchema: {
          index: z.string(),
          vectors: z
            .array(
              z.object({
                id: z.string(),
                values: z.array(z.number()),
                metadata: z.record(z.any()).optional(),
              }),
            )
            .min(1)
            .max(1000),
          namespace: z.string().optional(),
        },
        annotations: { destructiveHint: false },
      },
      safe("pinecone_upsert", async ({ index, vectors, namespace }) => {
        const host = await hostFor(cfg, index);
        const body: Obj = { vectors };
        if (namespace) body.namespace = namespace;
        return jsonResult(await data(cfg, host, "/vectors/upsert", { method: "POST", body }));
      }),
    );

    server.registerTool(
      "pinecone_delete",
      {
        title: "Delete vectors from Pinecone (write)",
        description:
          "Deletes vectors by id, by metadata filter, or all vectors in a namespace. Enabled because MCP_ALLOW_WRITES=true.",
        inputSchema: {
          index: z.string(),
          ids: z.array(z.string()).optional(),
          deleteAll: z.boolean().optional().describe("Delete every vector in the namespace"),
          filter: z.record(z.any()).optional(),
          namespace: z.string().optional(),
        },
        annotations: { destructiveHint: true },
      },
      safe("pinecone_delete", async ({ index, ids, deleteAll, filter, namespace }) => {
        if (!ids && !deleteAll && !filter) throw new Error("Provide `ids`, `filter`, or `deleteAll: true`");
        const host = await hostFor(cfg, index);
        const body: Obj = {};
        if (ids) body.ids = ids;
        if (deleteAll) body.deleteAll = true;
        if (filter) body.filter = filter;
        if (namespace) body.namespace = namespace;
        await data(cfg, host, "/vectors/delete", { method: "POST", body });
        return jsonResult({ deleted: true, index, namespace: namespace ?? "(default)", ids, deleteAll: deleteAll ?? false });
      }),
    );
  }

  return true;
}
