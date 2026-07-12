import { MongoClient, type Document } from "mongodb";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../config.js";
import { jsonResult, registerCloser, safe } from "../util.js";

let client: MongoClient | undefined;
let connecting: Promise<MongoClient> | undefined;

async function getClient(uri: string): Promise<MongoClient> {
  if (client) return client;
  if (!connecting) {
    connecting = new MongoClient(uri, {
      serverSelectionTimeoutMS: 10_000,
      appName: "ultimate-devops-mcp",
    })
      .connect()
      .then((c) => {
        client = c;
        registerCloser("mongodb", async () => {
          await client?.close();
          client = undefined;
          connecting = undefined;
        });
        return c;
      })
      .catch((err) => {
        connecting = undefined;
        throw err;
      });
  }
  return connecting;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

export function registerMongo(server: McpServer, config: AppConfig): boolean {
  const cfg = config.integrations.mongo;
  if (!cfg) return false;

  server.registerTool(
    "mongo_find",
    {
      title: "Find MongoDB documents",
      description: "Runs a find query with optional projection and sort. Filter uses MongoDB query syntax as a JSON object.",
      inputSchema: {
        database: z.string().describe("Database name"),
        collection: z.string().describe("Collection name"),
        filter: z.record(z.unknown()).optional().describe('MongoDB filter, e.g. {"status": "failed"}'),
        projection: z.record(z.unknown()).optional().describe('Projection, e.g. {"_id": 0, "name": 1}'),
        sort: z.record(z.unknown()).optional().describe('Sort spec, e.g. {"createdAt": -1}'),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Max documents (default ${DEFAULT_LIMIT})`),
      },
      annotations: { readOnlyHint: true },
    },
    safe("mongo_find", async ({ database, collection, filter, projection, sort, limit }) => {
      const c = await getClient(cfg.uri);
      const docs = await c
        .db(database)
        .collection(collection)
        .find((filter ?? {}) as Document, { projection: projection as Document | undefined })
        .sort((sort ?? {}) as Document)
        .limit(limit ?? DEFAULT_LIMIT)
        .toArray();
      return jsonResult({ count: docs.length, documents: docs });
    }),
  );

  server.registerTool(
    "mongo_aggregate",
    {
      title: "Run MongoDB aggregation",
      description: "Runs an aggregation pipeline (array of stage objects). Results are capped.",
      inputSchema: {
        database: z.string(),
        collection: z.string(),
        pipeline: z.array(z.record(z.unknown())).describe('Aggregation stages, e.g. [{"$match": ...}, {"$group": ...}]'),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Max results (default ${DEFAULT_LIMIT})`),
      },
      annotations: { readOnlyHint: true },
    },
    safe("mongo_aggregate", async ({ database, collection, pipeline, limit }) => {
      const banned = ["$out", "$merge"];
      for (const stage of pipeline) {
        for (const key of Object.keys(stage)) {
          if (banned.includes(key) && !config.allowWrites) {
            throw new Error(`${key} stages are disabled (writes not allowed on this server).`);
          }
        }
      }
      const c = await getClient(cfg.uri);
      const cursor = c.db(database).collection(collection).aggregate(pipeline as Document[]);
      const docs: Document[] = [];
      const max = limit ?? DEFAULT_LIMIT;
      for await (const doc of cursor) {
        docs.push(doc);
        if (docs.length >= max) break;
      }
      await cursor.close();
      return jsonResult({ count: docs.length, documents: docs });
    }),
  );

  server.registerTool(
    "mongo_list_collections",
    {
      title: "List MongoDB collections",
      description: "Lists collections in a database with document counts. Omit database to list databases instead.",
      inputSchema: {
        database: z.string().optional().describe("Database name; omit to list all databases"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("mongo_list_collections", async ({ database }) => {
      const c = await getClient(cfg.uri);
      if (!database) {
        const dbs = await c.db().admin().listDatabases();
        return jsonResult(dbs.databases);
      }
      const cols = await c.db(database).listCollections().toArray();
      const withCounts = await Promise.all(
        cols.slice(0, 100).map(async (col) => ({
          name: col.name,
          type: col.type,
          estimatedCount: await c.db(database).collection(col.name).estimatedDocumentCount().catch(() => null),
        })),
      );
      return jsonResult(withCounts);
    }),
  );

  server.registerTool(
    "mongo_count",
    {
      title: "Count MongoDB documents",
      description: "Counts documents matching a filter.",
      inputSchema: {
        database: z.string(),
        collection: z.string(),
        filter: z.record(z.unknown()).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("mongo_count", async ({ database, collection, filter }) => {
      const c = await getClient(cfg.uri);
      const count = await c.db(database).collection(collection).countDocuments((filter ?? {}) as Document);
      return jsonResult({ count });
    }),
  );

  if (config.allowWrites) {
    server.registerTool(
      "mongo_insert",
      {
        title: "Insert MongoDB documents (write)",
        description: "Inserts one or more documents. Enabled because MCP_ALLOW_WRITES=true.",
        inputSchema: {
          database: z.string(),
          collection: z.string(),
          documents: z.array(z.record(z.unknown())).min(1).max(100),
        },
        annotations: { destructiveHint: true },
      },
      safe("mongo_insert", async ({ database, collection, documents }) => {
        const c = await getClient(cfg.uri);
        const res = await c.db(database).collection(collection).insertMany(documents as Document[]);
        return jsonResult({ insertedCount: res.insertedCount, insertedIds: res.insertedIds });
      }),
    );

    server.registerTool(
      "mongo_update",
      {
        title: "Update MongoDB documents (write)",
        description: "Updates documents matching a filter. Enabled because MCP_ALLOW_WRITES=true.",
        inputSchema: {
          database: z.string(),
          collection: z.string(),
          filter: z.record(z.unknown()).describe("Match filter — refuse to run with an empty filter unless many=true"),
          update: z.record(z.unknown()).describe('Update document, e.g. {"$set": {"status": "resolved"}}'),
          many: z.boolean().optional().describe("Update all matches (default: first match only)"),
          upsert: z.boolean().optional(),
        },
        annotations: { destructiveHint: true },
      },
      safe("mongo_update", async ({ database, collection, filter, update, many, upsert }) => {
        if (Object.keys(filter).length === 0 && !many) {
          throw new Error("Empty filter would match all documents — set many=true to confirm a collection-wide update.");
        }
        const c = await getClient(cfg.uri);
        const coll = c.db(database).collection(collection);
        const res = many
          ? await coll.updateMany(filter as Document, update as Document, { upsert })
          : await coll.updateOne(filter as Document, update as Document, { upsert });
        return jsonResult({ matchedCount: res.matchedCount, modifiedCount: res.modifiedCount, upsertedId: res.upsertedId });
      }),
    );
  }

  return true;
}
