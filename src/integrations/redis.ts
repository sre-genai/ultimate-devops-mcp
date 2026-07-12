import { Redis } from "ioredis";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../config.js";
import { jsonResult, registerCloser, safe, textResult } from "../util.js";

let redis: Redis | undefined;

function getRedis(url: string): Redis {
  if (!redis) {
    redis = new Redis(url, {
      lazyConnect: false,
      maxRetriesPerRequest: 2,
      connectTimeout: 10_000,
      enableOfflineQueue: true,
    });
    redis.on("error", () => {
      /* logged via command errors; prevent unhandled 'error' events */
    });
    registerCloser("redis", async () => {
      await redis?.quit().catch(() => redis?.disconnect());
      redis = undefined;
    });
  }
  return redis;
}

export function registerRedis(server: McpServer, config: AppConfig): boolean {
  const cfg = config.integrations.redis;
  if (!cfg) return false;

  server.registerTool(
    "redis_get",
    {
      title: "Get Redis key (type-aware)",
      description:
        "Reads a key regardless of type: string→GET, hash→HGETALL, list/set/zset→first 100 elements. Also returns the key's type and TTL.",
      inputSchema: {
        key: z.string(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("redis_get", async ({ key }) => {
      const r = getRedis(cfg.url);
      const type = await r.type(key);
      if (type === "none") return textResult(`Key "${key}" does not exist.`);
      const ttl = await r.ttl(key);
      let value: unknown;
      switch (type) {
        case "string":
          value = await r.get(key);
          break;
        case "hash":
          value = await r.hgetall(key);
          break;
        case "list":
          value = await r.lrange(key, 0, 99);
          break;
        case "set":
          value = await r.srandmember(key, 100);
          break;
        case "zset":
          value = await r.zrange(key, 0, 99, "WITHSCORES");
          break;
        case "stream":
          value = await r.xrange(key, "-", "+", "COUNT", 50);
          break;
        default:
          value = `Unsupported type: ${type}`;
      }
      return jsonResult({ key, type, ttlSeconds: ttl, value });
    }),
  );

  server.registerTool(
    "redis_keys",
    {
      title: "Scan Redis keys",
      description: "Finds keys matching a glob pattern using SCAN (safe on production — never uses KEYS).",
      inputSchema: {
        pattern: z.string().describe('Glob pattern, e.g. "session:*"'),
        count: z.number().int().min(1).max(1000).optional().describe("Max keys to return (default 100)"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("redis_keys", async ({ pattern, count }) => {
      const r = getRedis(cfg.url);
      const max = count ?? 100;
      const keys: string[] = [];
      let cursor = "0";
      do {
        const [next, batch] = await r.scan(cursor, "MATCH", pattern, "COUNT", 200);
        cursor = next;
        keys.push(...batch);
      } while (cursor !== "0" && keys.length < max);
      return jsonResult({ pattern, returned: Math.min(keys.length, max), keys: keys.slice(0, max) });
    }),
  );

  server.registerTool(
    "redis_info",
    {
      title: "Redis server info",
      description: "Returns INFO output (memory, clients, replication, keyspace...). Optionally a single section.",
      inputSchema: {
        section: z.enum(["server", "clients", "memory", "persistence", "stats", "replication", "cpu", "keyspace"]).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("redis_info", async ({ section }) => {
      const r = getRedis(cfg.url);
      const info = section ? await r.info(section) : await r.info();
      return textResult(info);
    }),
  );

  server.registerTool(
    "redis_ttl",
    {
      title: "Redis key TTL",
      description: "Returns the TTL of a key in seconds (-1 = no expiry, -2 = key missing).",
      inputSchema: {
        key: z.string(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("redis_ttl", async ({ key }) => jsonResult({ key, ttlSeconds: await getRedis(cfg.url).ttl(key) })),
  );

  if (config.allowWrites) {
    server.registerTool(
      "redis_set",
      {
        title: "Set Redis key (write)",
        description: "Sets a string key with optional TTL. Enabled because MCP_ALLOW_WRITES=true.",
        inputSchema: {
          key: z.string(),
          value: z.string(),
          ttlSeconds: z.number().int().min(1).optional(),
        },
        annotations: { destructiveHint: true },
      },
      safe("redis_set", async ({ key, value, ttlSeconds }) => {
        const r = getRedis(cfg.url);
        const res = ttlSeconds ? await r.set(key, value, "EX", ttlSeconds) : await r.set(key, value);
        return jsonResult({ key, result: res });
      }),
    );

    server.registerTool(
      "redis_delete",
      {
        title: "Delete Redis keys (write)",
        description: "Deletes specific keys (no patterns — list keys explicitly). Enabled because MCP_ALLOW_WRITES=true.",
        inputSchema: {
          keys: z.array(z.string()).min(1).max(100),
        },
        annotations: { destructiveHint: true },
      },
      safe("redis_delete", async ({ keys }) => {
        const deleted = await getRedis(cfg.url).del(...keys);
        return jsonResult({ requested: keys.length, deleted });
      }),
    );
  }

  return true;
}
