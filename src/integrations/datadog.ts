import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig, DatadogConfig } from "../config.js";
import { httpRequest, jsonResult, qs, safe } from "../util.js";

function api(cfg: DatadogConfig, path: string, opts: Parameters<typeof httpRequest>[1] = {}) {
  return httpRequest(`https://api.${cfg.site}${path}`, {
    ...opts,
    headers: {
      "dd-api-key": cfg.apiKey,
      "dd-application-key": cfg.appKey,
      ...(opts.headers ?? {}),
    },
  });
}

const nowSec = () => Math.floor(Date.now() / 1000);

export function registerDatadog(server: McpServer, config: AppConfig): boolean {
  const cfg = config.integrations.datadog;
  if (!cfg) return false;

  server.registerTool(
    "datadog_query_metrics",
    {
      title: "Query Datadog metrics",
      description:
        'Runs a timeseries metrics query, e.g. "avg:system.cpu.user{service:api} by {host}". Time range is relative minutes from now.',
      inputSchema: {
        query: z.string().describe("Datadog metrics query string"),
        fromMinutesAgo: z.number().int().min(1).max(10080).optional().describe("Range start (default 60)"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("datadog_query_metrics", async ({ query, fromMinutesAgo }) => {
      const to = nowSec();
      const from = to - (fromMinutesAgo ?? 60) * 60;
      const res = (await api(cfg, `/api/v1/query${qs({ from, to, query })}`)) as {
        series?: Array<{ metric?: string; scope?: string; pointlist?: Array<[number, number]> }>;
        status?: string;
      };
      return jsonResult({
        status: res.status,
        series: (res.series ?? []).slice(0, 20).map((s) => ({
          metric: s.metric,
          scope: s.scope,
          points: (s.pointlist ?? []).slice(-50),
        })),
      });
    }),
  );

  server.registerTool(
    "datadog_search_logs",
    {
      title: "Search Datadog logs",
      description: 'Searches logs with Datadog query syntax, e.g. "service:api status:error".',
      inputSchema: {
        query: z.string().describe("Log search query"),
        fromMinutesAgo: z.number().int().min(1).max(10080).optional().describe("Range start (default 60)"),
        limit: z.number().int().min(1).max(100).optional().describe("Max log events (default 25)"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("datadog_search_logs", async ({ query, fromMinutesAgo, limit }) => {
      const res = (await api(cfg, "/api/v2/logs/events/search", {
        method: "POST",
        body: {
          filter: { query, from: `now-${fromMinutesAgo ?? 60}m`, to: "now" },
          page: { limit: limit ?? 25 },
          sort: "-timestamp",
        },
      })) as { data?: Array<{ attributes?: Record<string, unknown> }> };
      return jsonResult(
        (res.data ?? []).map((e) => ({
          timestamp: e.attributes?.timestamp,
          status: e.attributes?.status,
          service: e.attributes?.service,
          host: e.attributes?.host,
          message: String(e.attributes?.message ?? "").slice(0, 2000),
          tags: e.attributes?.tags,
        })),
      );
    }),
  );

  server.registerTool(
    "datadog_list_monitors",
    {
      title: "List Datadog monitors",
      description: "Lists monitors, optionally filtered by search query (name, tag, status).",
      inputSchema: {
        query: z.string().optional().describe('Monitor search, e.g. "status:alert" or a name fragment'),
      },
      annotations: { readOnlyHint: true },
    },
    safe("datadog_list_monitors", async ({ query }) => {
      if (query) {
        const res = (await api(cfg, `/api/v1/monitor/search${qs({ query, per_page: 50 })}`)) as {
          monitors?: Array<Record<string, unknown>>;
        };
        return jsonResult(res.monitors ?? []);
      }
      const res = (await api(cfg, `/api/v1/monitor${qs({ page_size: 50 })}`)) as Array<Record<string, unknown>>;
      return jsonResult(
        res.map((m) => ({
          id: m.id,
          name: m.name,
          type: m.type,
          overallState: (m as { overall_state?: string }).overall_state,
          tags: m.tags,
        })),
      );
    }),
  );

  server.registerTool(
    "datadog_get_monitor",
    {
      title: "Get Datadog monitor",
      description: "Fetches full monitor detail by ID, including query and current state.",
      inputSchema: {
        id: z.number().int().describe("Monitor ID"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("datadog_get_monitor", async ({ id }) => jsonResult(await api(cfg, `/api/v1/monitor/${id}`))),
  );

  server.registerTool(
    "datadog_list_events",
    {
      title: "List Datadog events",
      description: "Lists events from the event stream (deploys, alerts, custom events).",
      inputSchema: {
        fromMinutesAgo: z.number().int().min(1).max(10080).optional().describe("Range start (default 60)"),
        priority: z.enum(["normal", "low"]).optional(),
        tags: z.string().optional().describe('Comma-separated tag filter, e.g. "service:api"'),
      },
      annotations: { readOnlyHint: true },
    },
    safe("datadog_list_events", async ({ fromMinutesAgo, priority, tags }) => {
      const end = nowSec();
      const start = end - (fromMinutesAgo ?? 60) * 60;
      const res = (await api(cfg, `/api/v1/events${qs({ start, end, priority, tags })}`)) as {
        events?: Array<Record<string, unknown>>;
      };
      return jsonResult(
        (res.events ?? []).slice(0, 50).map((e) => ({
          id: e.id,
          title: e.title,
          text: String(e.text ?? "").slice(0, 500),
          alertType: (e as { alert_type?: string }).alert_type,
          dateHappened: (e as { date_happened?: number }).date_happened,
          tags: e.tags,
        })),
      );
    }),
  );

  if (config.allowWrites) {
    server.registerTool(
      "datadog_post_event",
      {
        title: "Post Datadog event (write)",
        description: "Posts an event to the Datadog event stream (e.g. deploy markers). Enabled because MCP_ALLOW_WRITES=true.",
        inputSchema: {
          title: z.string(),
          text: z.string(),
          alertType: z.enum(["error", "warning", "info", "success"]).optional(),
          tags: z.array(z.string()).optional(),
        },
        annotations: { destructiveHint: false },
      },
      safe("datadog_post_event", async ({ title, text, alertType, tags }) =>
        jsonResult(
          await api(cfg, "/api/v1/events", {
            method: "POST",
            body: { title, text, alert_type: alertType, tags },
          }),
        ),
      ),
    );
  }

  return true;
}
