import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig, PagerDutyConfig } from "../config.js";
import { httpRequest, jsonResult, qs, safe } from "../util.js";

function api(cfg: PagerDutyConfig, path: string, opts: Parameters<typeof httpRequest>[1] = {}) {
  return httpRequest(`${cfg.baseUrl}${path}`, {
    ...opts,
    headers: {
      authorization: `Token token=${cfg.apiToken}`,
      accept: "application/vnd.pagerduty+json;version=2",
      ...(opts.headers ?? {}),
    },
  });
}

type Obj = Record<string, unknown>;

export function registerPagerDuty(server: McpServer, config: AppConfig): boolean {
  const cfg = config.integrations.pagerduty;
  if (!cfg) return false;

  server.registerTool(
    "pagerduty_list_incidents",
    {
      title: "List PagerDuty incidents",
      description: "Lists incidents, most recent first, optionally filtered by status or service.",
      inputSchema: {
        statuses: z.array(z.enum(["triggered", "acknowledged", "resolved"])).optional(),
        serviceIds: z.array(z.string()).optional().describe("Filter to specific service IDs"),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("pagerduty_list_incidents", async ({ statuses, serviceIds, limit }) => {
      const search = new URLSearchParams();
      search.set("limit", String(limit ?? 25));
      search.set("sort_by", "created_at:desc");
      for (const s of statuses ?? []) search.append("statuses[]", s);
      for (const id of serviceIds ?? []) search.append("service_ids[]", id);
      const res = (await api(cfg, `/incidents?${search.toString()}`)) as { incidents?: Obj[] };
      return jsonResult(
        (res.incidents ?? []).map((i) => ({
          id: i.id,
          incidentNumber: (i as { incident_number?: number }).incident_number,
          title: i.title,
          status: i.status,
          urgency: i.urgency,
          service: (i as { service?: { summary?: string } }).service?.summary,
          createdAt: (i as { created_at?: string }).created_at,
          url: (i as { html_url?: string }).html_url,
        })),
      );
    }),
  );

  server.registerTool(
    "pagerduty_get_incident",
    {
      title: "Get PagerDuty incident",
      description: "Full detail of one incident by ID.",
      inputSchema: {
        id: z.string().describe("Incident ID"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("pagerduty_get_incident", async ({ id }) => {
      const res = (await api(cfg, `/incidents/${encodeURIComponent(id)}`)) as { incident?: Obj };
      return jsonResult(res.incident ?? res);
    }),
  );

  server.registerTool(
    "pagerduty_list_services",
    {
      title: "List PagerDuty services",
      description: "Lists services (name, status, escalation policy).",
      inputSchema: {
        query: z.string().optional().describe("Filter by name fragment"),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("pagerduty_list_services", async ({ query, limit }) => {
      const res = (await api(cfg, `/services${qs({ query, limit: limit ?? 25 })}`)) as { services?: Obj[] };
      return jsonResult(
        (res.services ?? []).map((s) => ({
          id: s.id,
          name: s.name,
          status: s.status,
          escalationPolicy: (s as { escalation_policy?: { summary?: string } }).escalation_policy?.summary,
          url: (s as { html_url?: string }).html_url,
        })),
      );
    }),
  );

  server.registerTool(
    "pagerduty_list_oncalls",
    {
      title: "List PagerDuty on-calls",
      description: "Lists who is currently on call, optionally scoped to escalation policies.",
      inputSchema: {
        escalationPolicyIds: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("pagerduty_list_oncalls", async ({ escalationPolicyIds, limit }) => {
      const search = new URLSearchParams();
      search.set("limit", String(limit ?? 25));
      for (const id of escalationPolicyIds ?? []) search.append("escalation_policy_ids[]", id);
      const res = (await api(cfg, `/oncalls?${search.toString()}`)) as { oncalls?: Obj[] };
      return jsonResult(
        (res.oncalls ?? []).map((o) => ({
          user: (o as { user?: { summary?: string } }).user?.summary,
          escalationPolicy: (o as { escalation_policy?: { summary?: string } }).escalation_policy?.summary,
          escalationLevel: (o as { escalation_level?: number }).escalation_level,
          schedule: (o as { schedule?: { summary?: string } }).schedule?.summary,
          start: o.start,
          end: o.end,
        })),
      );
    }),
  );

  if (config.allowWrites) {
    server.registerTool(
      "pagerduty_create_incident",
      {
        title: "Create PagerDuty incident (write)",
        description: "Opens a new incident on a service. Enabled because MCP_ALLOW_WRITES=true.",
        inputSchema: {
          serviceId: z.string().describe("Target service ID"),
          title: z.string(),
          urgency: z.enum(["high", "low"]).optional(),
          details: z.string().optional().describe("Incident body / details"),
        },
        annotations: { destructiveHint: false },
      },
      safe("pagerduty_create_incident", async ({ serviceId, title, urgency, details }) => {
        const from = cfg.fromEmail;
        if (!from) throw new Error("PAGERDUTY_FROM_EMAIL is required to create incidents");
        return jsonResult(
          await api(cfg, "/incidents", {
            method: "POST",
            headers: { from },
            body: {
              incident: {
                type: "incident",
                title,
                service: { id: serviceId, type: "service_reference" },
                urgency: urgency ?? "high",
                body: details ? { type: "incident_body", details } : undefined,
              },
            },
          }),
        );
      }),
    );

    server.registerTool(
      "pagerduty_update_incident_status",
      {
        title: "Acknowledge or resolve a PagerDuty incident (write)",
        description:
          "Moves an incident to acknowledged or resolved. Enabled because MCP_ALLOW_WRITES=true.",
        inputSchema: {
          id: z.string().describe("Incident ID"),
          status: z.enum(["acknowledged", "resolved"]),
        },
        annotations: { destructiveHint: true },
      },
      safe("pagerduty_update_incident_status", async ({ id, status }) => {
        const from = cfg.fromEmail;
        if (!from) throw new Error("PAGERDUTY_FROM_EMAIL is required to change incident status");
        return jsonResult(
          await api(cfg, `/incidents/${encodeURIComponent(id)}`, {
            method: "PUT",
            headers: { from },
            body: { incident: { type: "incident_reference", status } },
          }),
        );
      }),
    );
  }

  return true;
}
