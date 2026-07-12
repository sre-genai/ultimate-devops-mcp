import pg from "pg";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../config.js";
import { jsonResult, registerCloser, safe, textResult } from "../util.js";

let pool: pg.Pool | undefined;

function getPool(connectionString: string): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString,
      max: 5,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 30_000,
      query_timeout: 30_000,
      application_name: "ultimate-devops-mcp",
    });
    pool.on("error", () => {
      /* keep idle-client errors from crashing the process */
    });
    registerCloser("postgres", async () => {
      await pool?.end();
      pool = undefined;
    });
  }
  return pool;
}

const READ_ONLY_RE = /^\s*(select|with|explain|show|values|table)\b/i;
const DEFAULT_ROW_LIMIT = 200;

export function registerPostgres(server: McpServer, config: AppConfig): boolean {
  const cfg = config.integrations.postgres;
  if (!cfg) return false;

  server.registerTool(
    "postgres_query",
    {
      title: "Run read-only SQL on Postgres",
      description:
        "Executes a read-only SQL statement (SELECT/WITH/EXPLAIN/SHOW) against Postgres inside a READ ONLY transaction. Use $1, $2... placeholders with the params array. Results are capped.",
      inputSchema: {
        sql: z.string().describe("Read-only SQL statement"),
        params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional()
          .describe("Positional parameters for $1, $2, ..."),
        rowLimit: z.number().int().min(1).max(1000).optional()
          .describe(`Max rows to return (default ${DEFAULT_ROW_LIMIT})`),
      },
      annotations: { readOnlyHint: true },
    },
    safe("postgres_query", async ({ sql, params, rowLimit }) => {
      if (!READ_ONLY_RE.test(sql)) {
        throw new Error(
          "Only read-only statements (SELECT/WITH/EXPLAIN/SHOW/VALUES/TABLE) are allowed here. Use postgres_execute for writes (requires MCP_ALLOW_WRITES=true).",
        );
      }
      const client = await getPool(cfg.connectionString).connect();
      try {
        await client.query("BEGIN TRANSACTION READ ONLY");
        const res = await client.query(sql, params ?? []);
        await client.query("COMMIT");
        const limit = rowLimit ?? DEFAULT_ROW_LIMIT;
        const rows = res.rows.slice(0, limit);
        return jsonResult({
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
      },
      annotations: { readOnlyHint: true },
    },
    safe("postgres_list_tables", async ({ schema }) => {
      const res = await getPool(cfg.connectionString).query(
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
      return jsonResult(res.rows);
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
      },
      annotations: { readOnlyHint: true },
    },
    safe("postgres_describe_table", async ({ table, schema }) => {
      const sch = schema ?? "public";
      const p = getPool(cfg.connectionString);
      const [columns, indexes] = await Promise.all([
        p.query(
          `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = $2
           ORDER BY ordinal_position`,
          [sch, table],
        ),
        p.query(
          `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2`,
          [sch, table],
        ),
      ]);
      if (columns.rows.length === 0) {
        return textResult(`Table ${sch}.${table} not found.`);
      }
      return jsonResult({ schema: sch, table, columns: columns.rows, indexes: indexes.rows });
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
        },
        annotations: { destructiveHint: true },
      },
      safe("postgres_execute", async ({ sql, params }) => {
        const res = await getPool(cfg.connectionString).query(sql, params ?? []);
        return jsonResult({ command: res.command, rowCount: res.rowCount, rows: res.rows.slice(0, 50) });
      }),
    );
  }

  return true;
}
