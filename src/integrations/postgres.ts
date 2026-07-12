import pg from "pg";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig, PostgresConfig } from "../config.js";
import { jsonResult, registerCloser, safe, textResult } from "../util.js";

// ---------------------------------------------------------------------------
// Multi-database pool cache
//
// A Postgres connection is bound to ONE database, so to support "list the
// databases, then inspect any of them on demand" we keep a small, bounded cache
// of pools keyed by the resolved connection string (base URL with the target
// database swapped in). The cache is LRU-capped so touching many databases on a
// big instance (e.g. 300) can never open more than MAX_DB_POOLS × POOL_MAX
// connections total — the least-recently-used pool is closed when over cap.
// ---------------------------------------------------------------------------

const MAX_DB_POOLS = intEnv("POSTGRES_MAX_DB_POOLS", 8);
const POOL_MAX = intEnv("POSTGRES_POOL_MAX", 3);

function intEnv(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

interface Cached {
  pool: pg.Pool;
  lastUsed: number;
}
const pools = new Map<string, Cached>();
let closerRegistered = false;

/** Base connection string with the database segment replaced (or unchanged). */
function withDatabase(connectionString: string, database?: string): string {
  if (!database) return connectionString;
  let u: URL;
  try {
    u = new URL(connectionString);
  } catch {
    throw new Error(
      "cannot target a specific `database`: POSTGRES_URL is not a URL-form connection string (postgres://…)",
    );
  }
  u.pathname = `/${encodeURIComponent(database)}`;
  return u.toString();
}

function poolFor(cfg: PostgresConfig, database?: string): pg.Pool {
  const key = withDatabase(cfg.connectionString, database);
  const cached = pools.get(key);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached.pool;
  }
  // Evict the least-recently-used pool if we're at the cap.
  if (pools.size >= MAX_DB_POOLS) {
    let lruKey: string | undefined;
    let lru = Infinity;
    for (const [k, v] of pools) {
      if (v.lastUsed < lru) {
        lru = v.lastUsed;
        lruKey = k;
      }
    }
    if (lruKey) {
      const evicted = pools.get(lruKey)!;
      pools.delete(lruKey);
      void evicted.pool.end().catch(() => {});
    }
  }
  const poolConfig: pg.PoolConfig = {
    connectionString: key,
    max: POOL_MAX,
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
    application_name: "ultimate-devops-mcp",
  };
  // Server-side statement_timeout is delivered as a startup parameter, which
  // PgBouncer (transaction/statement pool mode) can reject. Under PgBouncer we
  // skip it and rely on the client-side query_timeout above.
  if (!cfg.pgbouncer) poolConfig.statement_timeout = 30_000;

  const pool = new pg.Pool(poolConfig);
  pool.on("error", () => {
    /* keep idle-client errors from crashing the process */
  });
  pools.set(key, { pool, lastUsed: Date.now() });

  if (!closerRegistered) {
    closerRegistered = true;
    registerCloser("postgres", async () => {
      const all = [...pools.values()];
      pools.clear();
      await Promise.allSettled(all.map((c) => c.pool.end()));
    });
  }
  return pool;
}

/** Build a database allow-matcher from config entries (exact names + /regex/).
 * Returns null when no allowlist is configured (all databases permitted). */
function buildDbFilter(allow?: string[]): ((name: string) => boolean) | null {
  if (!allow || allow.length === 0) return null;
  const exact = new Set<string>();
  const regexes: RegExp[] = [];
  for (const entry of allow) {
    if (entry.length >= 2 && entry.startsWith("/") && entry.endsWith("/")) {
      try {
        regexes.push(new RegExp(entry.slice(1, -1)));
        continue;
      } catch {
        /* invalid regex → fall through and treat as a literal name */
      }
    }
    exact.add(entry);
  }
  return (name: string) => exact.has(name) || regexes.some((r) => r.test(name));
}

const READ_ONLY_RE = /^\s*(select|with|explain|show|values|table)\b/i;
const DEFAULT_ROW_LIMIT = 200;
const DB_ARG = z
  .string()
  .optional()
  .describe(
    "Target database on the server. Omit to use the default from POSTGRES_URL; pass a name from postgres_list_databases to inspect another database on the same instance.",
  );

export function registerPostgres(server: McpServer, config: AppConfig): boolean {
  const cfg = config.integrations.postgres;
  if (!cfg) return false;

  const dbFilter = buildDbFilter(cfg.dbAllow);
  // Resolve a pool for an explicit target database, rejecting any name outside
  // the allowlist so the agent can't reach a DB just by guessing its name. The
  // default DB (no `database` arg) is the operator's own configured connection
  // and is always permitted.
  const targetPool = (database?: string) => {
    if (database !== undefined && dbFilter && !dbFilter(database)) {
      throw new Error(
        `database ${JSON.stringify(database)} is not in the allowed set (POSTGRES_DB_ALLOW)`,
      );
    }
    return poolFor(cfg, database);
  };

  server.registerTool(
    "postgres_list_databases",
    {
      title: "List Postgres databases",
      description:
        "Lists the databases on the server (name, owner, encoding, size), excluding templates and no-connect databases. Use a returned name as the `database` argument to the other Postgres tools.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safe("postgres_list_databases", async () => {
      const res = await poolFor(cfg).query(
        `SELECT d.datname AS name,
                pg_catalog.pg_get_userbyid(d.datdba) AS owner,
                pg_catalog.pg_encoding_to_char(d.encoding) AS encoding,
                CASE WHEN pg_catalog.has_database_privilege(d.datname, 'CONNECT')
                     THEN pg_catalog.pg_size_pretty(pg_catalog.pg_database_size(d.datname)) END AS size
         FROM pg_catalog.pg_database d
         WHERE NOT d.datistemplate AND d.datallowconn
         ORDER BY d.datname`,
      );
      const databases = dbFilter
        ? res.rows.filter((r: { name: string }) => dbFilter(r.name))
        : res.rows;
      return jsonResult({ count: databases.length, databases });
    }),
  );

  server.registerTool(
    "postgres_query",
    {
      title: "Run read-only SQL on Postgres",
      description:
        "Executes a read-only SQL statement (SELECT/WITH/EXPLAIN/SHOW) inside a READ ONLY transaction. Use $1, $2… placeholders with the params array. Results are capped.",
      inputSchema: {
        sql: z.string().describe("Read-only SQL statement"),
        params: z
          .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
          .optional()
          .describe("Positional parameters for $1, $2, ..."),
        rowLimit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe(`Max rows to return (default ${DEFAULT_ROW_LIMIT})`),
        database: DB_ARG,
      },
      annotations: { readOnlyHint: true },
    },
    safe("postgres_query", async ({ sql, params, rowLimit, database }) => {
      if (!READ_ONLY_RE.test(sql)) {
        throw new Error(
          "Only read-only statements (SELECT/WITH/EXPLAIN/SHOW/VALUES/TABLE) are allowed here. Use postgres_execute for writes (requires MCP_ALLOW_WRITES=true).",
        );
      }
      const client = await targetPool(database).connect();
      try {
        await client.query("BEGIN TRANSACTION READ ONLY");
        const res = await client.query(sql, params ?? []);
        await client.query("COMMIT");
        const limit = rowLimit ?? DEFAULT_ROW_LIMIT;
        const rows = res.rows.slice(0, limit);
        return jsonResult({
          database: database ?? "(default)",
          rowCount: res.rowCount,
          returned: rows.length,
          truncated: (res.rowCount ?? 0) > rows.length,
          rows,
        });
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }),
  );

  server.registerTool(
    "postgres_list_tables",
    {
      title: "List Postgres tables",
      description: "Lists tables and views with schema, type and approximate row counts.",
      inputSchema: {
        schema: z.string().optional().describe("Filter by schema name (default: all user schemas)"),
        database: DB_ARG,
      },
      annotations: { readOnlyHint: true },
    },
    safe("postgres_list_tables", async ({ schema, database }) => {
      const res = await targetPool(database).query(
        `SELECT n.nspname AS schema, c.relname AS name,
                CASE c.relkind WHEN 'r' THEN 'table' WHEN 'v' THEN 'view'
                               WHEN 'm' THEN 'materialized view' WHEN 'p' THEN 'partitioned table' END AS type,
                c.reltuples::bigint AS approx_rows
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('r','v','m','p')
           AND n.nspname NOT IN ('pg_catalog','information_schema')
           AND ($1::text IS NULL OR n.nspname = $1)
         ORDER BY n.nspname, c.relname
         LIMIT 500`,
        [schema ?? null],
      );
      return jsonResult({ database: database ?? "(default)", tables: res.rows });
    }),
  );

  server.registerTool(
    "postgres_describe_table",
    {
      title: "Describe a Postgres table",
      description: "Returns columns (name, type, nullable, default) and indexes for a table.",
      inputSchema: {
        table: z.string().describe("Table name"),
        schema: z.string().optional().describe("Schema name (default: public)"),
        database: DB_ARG,
      },
      annotations: { readOnlyHint: true },
    },
    safe("postgres_describe_table", async ({ table, schema, database }) => {
      const sch = schema ?? "public";
      const p = targetPool(database);
      const [columns, indexes] = await Promise.all([
        p.query(
          `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = $2
           ORDER BY ordinal_position`,
          [sch, table],
        ),
        p.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2`, [sch, table]),
      ]);
      if (columns.rows.length === 0) {
        return textResult(`Table ${sch}.${table} not found in database ${database ?? "(default)"}.`);
      }
      return jsonResult({
        database: database ?? "(default)",
        schema: sch,
        table,
        columns: columns.rows,
        indexes: indexes.rows,
      });
    }),
  );

  if (config.allowWrites) {
    server.registerTool(
      "postgres_execute",
      {
        title: "Execute SQL on Postgres (write)",
        description:
          "Executes an arbitrary SQL statement (INSERT/UPDATE/DELETE/DDL). Enabled because MCP_ALLOW_WRITES=true. Use with care.",
        inputSchema: {
          sql: z.string().describe("SQL statement to execute"),
          params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
          database: DB_ARG,
        },
        annotations: { destructiveHint: true },
      },
      safe("postgres_execute", async ({ sql, params, database }) => {
        const res = await targetPool(database).query(sql, params ?? []);
        return jsonResult({
          database: database ?? "(default)",
          command: res.command,
          rowCount: res.rowCount,
          rows: res.rows.slice(0, 50),
        });
      }),
    );
  }

  return true;
}
