import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig, SentryConfig } from "../config.js";
import { httpRequest, jsonResult, qs, safe } from "../util.js";

function api(cfg: SentryConfig, path: string, opts: Parameters<typeof httpRequest>[1] = {}) {
  return httpRequest(`${cfg.baseUrl}${path}`, {
    ...opts,
    headers: { authorization: `Bearer ${cfg.token}`, ...(opts.headers ?? {}) },
  });
}

type Obj = Record<string, unknown>;

export function registerSentry(server: McpServer, config: AppConfig): boolean {
  const cfg = config.integrations.sentry;
  if (!cfg) return false;

  server.registerTool(
    "sentry_list_projects",
    {
      title: "List Sentry projects",
      description: "Lists projects in the configured organization.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safe("sentry_list_projects", async () => {
      const res = (await api(cfg, `/api/0/organizations/${encodeURIComponent(cfg.org)}/projects/`)) as Obj[];
      return jsonResult(
        (res ?? []).map((p) => ({
          id: p.id,
          slug: p.slug,
          name: p.name,
          platform: p.platform,
          dateCreated: (p as { dateCreated?: string }).dateCreated,
        })),
      );
    }),
  );

  server.registerTool(
    "sentry_list_issues",
    {
      title: "List Sentry issues",
      description:
        'Lists issues for a project, optionally filtered by a Sentry search query, e.g. "is:unresolved".',
      inputSchema: {
        project: z.string().describe("Project slug"),
        query: z.string().optional().describe('Sentry issue search (default "is:unresolved")'),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("sentry_list_issues", async ({ project, query, limit }) => {
      const res = (await api(
        cfg,
        `/api/0/projects/${encodeURIComponent(cfg.org)}/${encodeURIComponent(project)}/issues/${qs({
          query: query ?? "is:unresolved",
          limit: limit ?? 25,
        })}`,
      )) as Obj[];
      return jsonResult(
        (res ?? []).map((i) => ({
          id: i.id,
          shortId: (i as { shortId?: string }).shortId,
          title: i.title,
          culprit: i.culprit,
          level: i.level,
          status: i.status,
          count: i.count,
          userCount: (i as { userCount?: number }).userCount,
          firstSeen: (i as { firstSeen?: string }).firstSeen,
          lastSeen: (i as { lastSeen?: string }).lastSeen,
          permalink: i.permalink,
        })),
      );
    }),
  );

  server.registerTool(
    "sentry_get_issue",
    {
      title: "Get Sentry issue",
      description: "Full detail of one issue by ID.",
      inputSchema: {
        id: z.string().describe("Issue ID (numeric or short ID)"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("sentry_get_issue", async ({ id }) =>
      jsonResult(await api(cfg, `/api/0/issues/${encodeURIComponent(id)}/`)),
    ),
  );

  server.registerTool(
    "sentry_list_events",
    {
      title: "List Sentry issue events",
      description: "Lists the most recent events for an issue (individual occurrences).",
      inputSchema: {
        id: z.string().describe("Issue ID"),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("sentry_list_events", async ({ id, limit }) => {
      const res = (await api(cfg, `/api/0/issues/${encodeURIComponent(id)}/events/`)) as Obj[];
      return jsonResult(
        (res ?? []).slice(0, limit ?? 25).map((e) => ({
          eventID: (e as { eventID?: string }).eventID,
          message: e.message,
          title: e.title,
          platform: e.platform,
          dateCreated: (e as { dateCreated?: string }).dateCreated,
          tags: (e as { tags?: Array<{ key?: string; value?: string }> }).tags,
        })),
      );
    }),
  );

  if (config.allowWrites) {
    server.registerTool(
      "sentry_update_issue",
      {
        title: "Resolve or ignore a Sentry issue (write)",
        description:
          "Sets an issue status to resolved, ignored, or unresolved. Enabled because MCP_ALLOW_WRITES=true.",
        inputSchema: {
          id: z.string().describe("Issue ID"),
          status: z.enum(["resolved", "ignored", "unresolved"]),
        },
        annotations: { destructiveHint: false },
      },
      safe("sentry_update_issue", async ({ id, status }) =>
        jsonResult(
          await api(cfg, `/api/0/issues/${encodeURIComponent(id)}/`, {
            method: "PUT",
            body: { status },
          }),
        ),
      ),
    );
  }

  return true;
}
