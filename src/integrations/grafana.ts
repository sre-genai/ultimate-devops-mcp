import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig, GrafanaConfig } from "../config.js";
import { httpRequest, jsonResult, qs, safe } from "../util.js";

function api(cfg: GrafanaConfig, path: string, opts: Parameters<typeof httpRequest>[1] = {}) {
  return httpRequest(`${cfg.url}${path}`, {
    ...opts,
    headers: { authorization: `Bearer ${cfg.token}`, ...(opts.headers ?? {}) },
  });
}

export function registerGrafana(server: McpServer, config: AppConfig): boolean {
  const cfg = config.integrations.grafana;
  if (!cfg) return false;

  server.registerTool(
    "grafana_search_dashboards",
    {
      title: "Search Grafana dashboards",
      description: "Searches dashboards (and folders) by title.",
      inputSchema: {
        query: z.string().optional().describe("Title search text"),
        tag: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("grafana_search_dashboards", async ({ query, tag, limit }) =>
      jsonResult(
        await api(cfg, `/api/search${qs({ query, tag, limit: limit ?? 30, type: "dash-db" })}`),
      ),
    ),
  );

  server.registerTool(
    "grafana_get_dashboard",
    {
      title: "Get Grafana dashboard",
      description: "Fetches a dashboard definition by UID, summarizing panels (title, type, datasource, query expressions).",
      inputSchema: {
        uid: z.string().describe("Dashboard UID (from grafana_search_dashboards)"),
        full: z.boolean().optional().describe("Return the raw dashboard JSON instead of the panel summary"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("grafana_get_dashboard", async ({ uid, full }) => {
      const res = (await api(cfg, `/api/dashboards/uid/${encodeURIComponent(uid)}`)) as {
        meta?: unknown;
        dashboard?: {
          title?: string;
          tags?: string[];
          panels?: Array<{
            id?: number;
            title?: string;
            type?: string;
            datasource?: unknown;
            targets?: Array<Record<string, unknown>>;
          }>;
        };
      };
      if (full) return jsonResult(res);
      const d = res.dashboard;
      return jsonResult({
        title: d?.title,
        tags: d?.tags,
        panels: (d?.panels ?? []).map((p) => ({
          id: p.id,
          title: p.title,
          type: p.type,
          datasource: p.datasource,
          expressions: (p.targets ?? []).map((t) => t.expr ?? t.query ?? t.rawSql).filter(Boolean),
        })),
      });
    }),
  );

  server.registerTool(
    "grafana_list_datasources",
    {
      title: "List Grafana datasources",
      description: "Lists configured datasources (name, type, URL, default flag).",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safe("grafana_list_datasources", async () => {
      const res = (await api(cfg, "/api/datasources")) as Array<Record<string, unknown>>;
      return jsonResult(
        res.map((d) => ({ id: d.id, uid: d.uid, name: d.name, type: d.type, url: d.url, isDefault: d.isDefault })),
      );
    }),
  );

  server.registerTool(
    "grafana_list_alert_rules",
    {
      title: "List Grafana alert rules",
      description: "Lists provisioned alert rules (unified alerting).",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safe("grafana_list_alert_rules", async () => {
      const res = (await api(cfg, "/api/v1/provisioning/alert-rules")) as Array<Record<string, unknown>>;
      return jsonResult(
        res.map((r) => ({
          uid: r.uid,
          title: r.title,
          folderUID: r.folderUID,
          ruleGroup: r.ruleGroup,
          condition: r.condition,
          noDataState: r.noDataState,
          execErrState: r.execErrState,
          isPaused: r.isPaused,
        })),
      );
    }),
  );

  if (config.allowWrites) {
    server.registerTool(
      "grafana_create_annotation",
      {
        title: "Create Grafana annotation (write)",
        description:
          "Creates an annotation (e.g. to mark a deploy or incident on dashboards). Enabled because MCP_ALLOW_WRITES=true.",
        inputSchema: {
          text: z.string().describe("Annotation text"),
          tags: z.array(z.string()).optional(),
          dashboardUID: z.string().optional().describe("Attach to a specific dashboard"),
          panelId: z.number().int().optional(),
          timeEpochMs: z.number().int().optional().describe("Annotation time (default: now)"),
        },
        annotations: { destructiveHint: false },
      },
      safe("grafana_create_annotation", async ({ text, tags, dashboardUID, panelId, timeEpochMs }) =>
        jsonResult(
          await api(cfg, "/api/annotations", {
            method: "POST",
            body: { text, tags, dashboardUID, panelId, time: timeEpochMs ?? Date.now() },
          }),
        ),
      ),
    );
  }

  return true;
}
