import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig, PrometheusConfig } from "../config.js";
import { httpRequest, jsonResult, qs, safe } from "../util.js";

function api(cfg: PrometheusConfig, path: string) {
  return httpRequest(`${cfg.url}${path}`, {
    headers: cfg.bearerToken ? { authorization: `Bearer ${cfg.bearerToken}` } : {},
  });
}

export function registerPrometheus(server: McpServer, config: AppConfig): boolean {
  const cfg = config.integrations.prometheus;
  if (!cfg) return false;

  server.registerTool(
    "prom_query",
    {
      title: "Prometheus instant query",
      description: 'Evaluates a PromQL expression at a single point in time, e.g. up{job="api"} or rate(http_requests_total[5m]).',
      inputSchema: {
        query: z.string().describe("PromQL expression"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("prom_query", async ({ query }) => {
      const res = (await api(cfg, `/api/v1/query${qs({ query })}`)) as {
        data?: { resultType?: string; result?: unknown[] };
      };
      return jsonResult({
        resultType: res.data?.resultType,
        result: (res.data?.result ?? []).slice(0, 100),
      });
    }),
  );

  server.registerTool(
    "prom_query_range",
    {
      title: "Prometheus range query",
      description: "Evaluates a PromQL expression over a time range (timeseries).",
      inputSchema: {
        query: z.string().describe("PromQL expression"),
        startMinutesAgo: z.number().int().min(1).max(10080).optional().describe("Range start (default 60)"),
        stepSeconds: z.number().int().min(5).max(3600).optional().describe("Resolution step (default 60)"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("prom_query_range", async ({ query, startMinutesAgo, stepSeconds }) => {
      const end = Math.floor(Date.now() / 1000);
      const start = end - (startMinutesAgo ?? 60) * 60;
      const res = (await api(
        cfg,
        `/api/v1/query_range${qs({ query, start, end, step: stepSeconds ?? 60 })}`,
      )) as { data?: { resultType?: string; result?: Array<{ metric?: unknown; values?: unknown[] }> } };
      return jsonResult({
        resultType: res.data?.resultType,
        series: (res.data?.result ?? []).slice(0, 20).map((s) => ({
          metric: s.metric,
          values: (s.values ?? []).slice(-100),
        })),
      });
    }),
  );

  server.registerTool(
    "prom_alerts",
    {
      title: "Prometheus active alerts",
      description: "Lists currently firing/pending alerts from Prometheus.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safe("prom_alerts", async () => {
      const res = (await api(cfg, "/api/v1/alerts")) as { data?: { alerts?: unknown[] } };
      return jsonResult(res.data?.alerts ?? []);
    }),
  );

  server.registerTool(
    "prom_targets",
    {
      title: "Prometheus scrape targets",
      description: "Lists scrape targets with health and last error — useful for finding down exporters.",
      inputSchema: {
        state: z.enum(["active", "dropped", "any"]).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("prom_targets", async ({ state }) => {
      const res = (await api(cfg, `/api/v1/targets${qs({ state: state === "any" ? undefined : (state ?? "active") })}`)) as {
        data?: { activeTargets?: Array<Record<string, unknown>>; droppedTargets?: unknown[] };
      };
      return jsonResult({
        active: (res.data?.activeTargets ?? []).slice(0, 200).map((t) => ({
          scrapePool: t.scrapePool,
          scrapeUrl: t.scrapeUrl,
          health: t.health,
          lastError: t.lastError,
          lastScrape: t.lastScrape,
          labels: t.labels,
        })),
        droppedCount: res.data?.droppedTargets?.length ?? 0,
      });
    }),
  );

  return true;
}
