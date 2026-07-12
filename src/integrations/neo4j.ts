import neo4j, { type Driver } from "neo4j-driver";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig, Neo4jConfig } from "../config.js";
import { jsonResult, registerCloser, safe } from "../util.js";

let driver: Driver | undefined;

function getDriver(cfg: Neo4jConfig): Driver {
  if (!driver) {
    driver = neo4j.driver(cfg.url, neo4j.auth.basic(cfg.username, cfg.password), {
      disableLosslessIntegers: true,
      connectionAcquisitionTimeout: 10_000,
    });
    registerCloser("neo4j", async () => {
      await driver?.close();
      driver = undefined;
    });
  }
  return driver;
}

const DEFAULT_LIMIT = 100;

async function runCypher(
  cfg: Neo4jConfig,
  query: string,
  params: Record<string, unknown>,
  mode: "READ" | "WRITE",
  limit: number,
) {
  const session = getDriver(cfg).session({
    database: cfg.database,
    defaultAccessMode: mode === "READ" ? neo4j.session.READ : neo4j.session.WRITE,
  });
  try {
    const result = await session.run(query, params);
    const records = result.records.slice(0, limit).map((r) => r.toObject());
    return {
      recordCount: result.records.length,
      returned: records.length,
      truncated: result.records.length > records.length,
      records,
      counters: result.summary.counters.updates(),
    };
  } finally {
    await session.close();
  }
}

export function registerNeo4j(server: McpServer, config: AppConfig): boolean {
  const cfg = config.integrations.neo4j;
  if (!cfg) return false;

  server.registerTool(
    "neo4j_read_cypher",
    {
      title: "Run read-only Cypher on Neo4j",
      description:
        "Executes a Cypher query in a READ session (write clauses are rejected by the database). Use $param placeholders with the params object.",
      inputSchema: {
        query: z.string().describe("Cypher query, e.g. MATCH (n:Service) RETURN n.name LIMIT 10"),
        params: z.record(z.unknown()).optional().describe("Query parameters for $placeholders"),
        limit: z.number().int().min(1).max(500).optional().describe(`Max records (default ${DEFAULT_LIMIT})`),
      },
      annotations: { readOnlyHint: true },
    },
    safe("neo4j_read_cypher", async ({ query, params, limit }) =>
      jsonResult(await runCypher(cfg, query, params ?? {}, "READ", limit ?? DEFAULT_LIMIT)),
    ),
  );

  server.registerTool(
    "neo4j_schema",
    {
      title: "Get Neo4j schema",
      description: "Returns node labels, relationship types and property keys in the database.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safe("neo4j_schema", async () => {
      const [labels, relTypes, propKeys] = await Promise.all([
        runCypher(cfg, "CALL db.labels() YIELD label RETURN label", {}, "READ", 500),
        runCypher(cfg, "CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType", {}, "READ", 500),
        runCypher(cfg, "CALL db.propertyKeys() YIELD propertyKey RETURN propertyKey", {}, "READ", 500),
      ]);
      return jsonResult({
        labels: labels.records.map((r) => r.label),
        relationshipTypes: relTypes.records.map((r) => r.relationshipType),
        propertyKeys: propKeys.records.map((r) => r.propertyKey),
      });
    }),
  );

  if (config.allowWrites) {
    server.registerTool(
      "neo4j_write_cypher",
      {
        title: "Run write Cypher on Neo4j (write)",
        description: "Executes a Cypher query in a WRITE session (CREATE/MERGE/SET/DELETE). Enabled because MCP_ALLOW_WRITES=true.",
        inputSchema: {
          query: z.string(),
          params: z.record(z.unknown()).optional(),
        },
        annotations: { destructiveHint: true },
      },
      safe("neo4j_write_cypher", async ({ query, params }) =>
        jsonResult(await runCypher(cfg, query, params ?? {}, "WRITE", DEFAULT_LIMIT)),
      ),
    );
  }

  return true;
}
