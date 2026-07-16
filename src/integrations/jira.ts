import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig, JiraInstance } from "../config.js";
import { httpRequest, jsonResult, qs, safe } from "../util.js";

type Obj = Record<string, unknown>;

function api(inst: JiraInstance, path: string, opts: Parameters<typeof httpRequest>[1] = {}) {
  return httpRequest(`${inst.baseUrl}${path}`, {
    ...opts,
    headers: { authorization: inst.authHeader, accept: "application/json", ...(opts.headers ?? {}) },
  });
}

/** Core REST path for this instance's version (v3 Cloud / v2 Server). */
const rest = (inst: JiraInstance, p: string) => `/rest/api/${inst.apiVersion}${p}`;

/**
 * Rich-text body for a description/comment. Jira Cloud (v3) expects Atlassian
 * Document Format; Server/DC (v2) expects a plain string.
 */
function richText(inst: JiraInstance, text: string): unknown {
  if (inst.apiVersion >= 3) {
    return { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
  }
  return text;
}

/** Flatten an ADF document (or pass through a plain string) to readable text. */
function adfToText(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  const n = node as Obj;
  if (n.type === "text") return String(n.text ?? "");
  const kids = Array.isArray(n.content) ? (n.content as unknown[]).map(adfToText).join("") : "";
  return n.type === "paragraph" || n.type === "heading" ? kids + "\n" : kids;
}

function mapIssue(i: Obj): Obj {
  const f = (i.fields ?? {}) as Obj;
  const named = (v: unknown) => (v as { name?: string } | undefined)?.name;
  return {
    key: i.key,
    summary: f.summary,
    type: named(f.issuetype),
    status: named(f.status),
    priority: named(f.priority),
    assignee: (f.assignee as { displayName?: string } | undefined)?.displayName ?? null,
    updated: f.updated,
  };
}

export function registerJira(server: McpServer, config: AppConfig): boolean {
  const cfg = config.integrations.jira;
  if (!cfg) return false;
  const { instances, primary } = cfg;

  const names = Object.keys(instances);
  const multi = names.length > 1;
  const instanceArg = z
    .enum(names as [string, ...string[]])
    .optional()
    .describe(
      multi
        ? `Which Jira to target: ${names.join(", ")} (default: ${primary}).`
        : `Jira instance (only "${primary}" configured; optional).`,
    );

  function pick(instance?: string): JiraInstance {
    const inst = instances[instance ?? primary];
    if (!inst) {
      throw new Error(`Unknown Jira instance "${instance}". Configured: ${names.join(", ")}.`);
    }
    return inst;
  }

  const SEARCH_FIELDS = "summary,status,assignee,priority,issuetype,updated";

  server.registerTool(
    "jira_search",
    {
      title: "Search Jira issues (JQL)",
      description:
        'Runs a JQL query and returns matching issues. Example JQL: `project = OPS AND status = "In Progress" ORDER BY updated DESC`.',
      inputSchema: {
        instance: instanceArg,
        jql: z.string().describe("JQL query string"),
        limit: z.number().int().min(1).max(100).optional().describe("Max issues (default 30)"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("jira_search", async ({ instance, jql, limit }) => {
      const inst = pick(instance);
      const res = (await api(
        inst,
        rest(inst, `/search${qs({ jql, maxResults: limit ?? 30, fields: SEARCH_FIELDS })}`),
      )) as { issues?: Obj[]; total?: number };
      return jsonResult({ total: res.total, issues: (res.issues ?? []).map(mapIssue) });
    }),
  );

  server.registerTool(
    "jira_get_issue",
    {
      title: "Get a Jira issue",
      description: "Fetches one issue by key with description and recent comments.",
      inputSchema: {
        instance: instanceArg,
        key: z.string().describe('Issue key, e.g. "OPS-1234"'),
      },
      annotations: { readOnlyHint: true },
    },
    safe("jira_get_issue", async ({ instance, key }) => {
      const inst = pick(instance);
      const i = (await api(
        inst,
        rest(inst, `/issue/${encodeURIComponent(key)}${qs({ fields: "*all" })}`),
      )) as Obj;
      const f = (i.fields ?? {}) as Obj;
      const comments = ((f.comment as { comments?: Obj[] } | undefined)?.comments ?? []).slice(-5).map((c) => ({
        author: (c.author as { displayName?: string } | undefined)?.displayName,
        created: c.created,
        body: adfToText(c.body).slice(0, 1000),
      }));
      return jsonResult({
        ...mapIssue(i),
        reporter: (f.reporter as { displayName?: string } | undefined)?.displayName,
        labels: f.labels,
        created: f.created,
        description: adfToText(f.description).slice(0, 4000),
        comments,
      });
    }),
  );

  server.registerTool(
    "jira_list_projects",
    {
      title: "List Jira projects",
      description: "Lists projects visible to the configured account.",
      inputSchema: {
        instance: instanceArg,
        query: z.string().optional().describe("Filter by name/key text (Cloud only)"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("jira_list_projects", async ({ instance, query }) => {
      const inst = pick(instance);
      // Cloud (v3) paginates via /project/search; Server (v2) returns a flat array.
      const raw = await api(
        inst,
        inst.apiVersion >= 3 ? rest(inst, `/project/search${qs({ query, maxResults: 100 })}`) : rest(inst, "/project"),
      );
      const list = (Array.isArray(raw) ? raw : ((raw as { values?: Obj[] }).values ?? [])) as Obj[];
      return jsonResult(
        list.map((p) => ({ id: p.id, key: p.key, name: p.name, type: p.projectTypeKey, lead: (p.lead as { displayName?: string } | undefined)?.displayName })),
      );
    }),
  );

  server.registerTool(
    "jira_get_transitions",
    {
      title: "Get available Jira transitions",
      description: "Lists the workflow transitions available for an issue (use the id with jira_transition_issue).",
      inputSchema: {
        instance: instanceArg,
        key: z.string().describe("Issue key"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("jira_get_transitions", async ({ instance, key }) => {
      const inst = pick(instance);
      const res = (await api(inst, rest(inst, `/issue/${encodeURIComponent(key)}/transitions`))) as {
        transitions?: Obj[];
      };
      return jsonResult(
        (res.transitions ?? []).map((t) => ({ id: t.id, name: t.name, to: (t.to as { name?: string } | undefined)?.name })),
      );
    }),
  );

  server.registerTool(
    "jira_list_boards",
    {
      title: "List Jira Agile boards",
      description: "Lists Scrum/Kanban boards (Agile API). Use a board id with jira_list_sprints.",
      inputSchema: {
        instance: instanceArg,
        projectKeyOrId: z.string().optional().describe("Filter boards to a project"),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("jira_list_boards", async ({ instance, projectKeyOrId, limit }) => {
      const inst = pick(instance);
      const res = (await api(
        inst,
        `/rest/agile/1.0/board${qs({ projectKeyOrId, maxResults: limit ?? 50 })}`,
      )) as { values?: Obj[] };
      return jsonResult(
        (res.values ?? []).map((b) => ({ id: b.id, name: b.name, type: b.type })),
      );
    }),
  );

  server.registerTool(
    "jira_list_sprints",
    {
      title: "List sprints for a board",
      description: "Lists sprints on an Agile board (default: active + future).",
      inputSchema: {
        instance: instanceArg,
        boardId: z.number().int().describe("Board id (from jira_list_boards)"),
        state: z.enum(["active", "future", "closed"]).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("jira_list_sprints", async ({ instance, boardId, state, limit }) => {
      const inst = pick(instance);
      const res = (await api(
        inst,
        `/rest/agile/1.0/board/${boardId}/sprint${qs({ state: state ?? "active,future", maxResults: limit ?? 50 })}`,
      )) as { values?: Obj[] };
      return jsonResult(
        (res.values ?? []).map((s) => ({
          id: s.id,
          name: s.name,
          state: s.state,
          startDate: s.startDate,
          endDate: s.endDate,
          goal: s.goal,
        })),
      );
    }),
  );

  if (config.allowWrites) {
    server.registerTool(
      "jira_create_issue",
      {
        title: "Create a Jira issue (write)",
        description: "Creates an issue in a project. Enabled because MCP_ALLOW_WRITES=true.",
        inputSchema: {
          instance: instanceArg,
          projectKey: z.string().describe('Project key, e.g. "OPS"'),
          summary: z.string(),
          issueType: z.string().optional().describe('Issue type name (default "Task")'),
          description: z.string().optional(),
          labels: z.array(z.string()).optional(),
        },
        annotations: { destructiveHint: false },
      },
      safe("jira_create_issue", async ({ instance, projectKey, summary, issueType, description, labels }) => {
        const inst = pick(instance);
        const fields: Obj = {
          project: { key: projectKey },
          summary,
          issuetype: { name: issueType ?? "Task" },
        };
        if (description) fields.description = richText(inst, description);
        if (labels) fields.labels = labels;
        return jsonResult(await api(inst, rest(inst, "/issue"), { method: "POST", body: { fields } }));
      }),
    );

    server.registerTool(
      "jira_transition_issue",
      {
        title: "Transition a Jira issue (write)",
        description: "Moves an issue to a new status. Get valid ids from jira_get_transitions.",
        inputSchema: {
          instance: instanceArg,
          key: z.string(),
          transitionId: z.string().describe("Transition id from jira_get_transitions"),
          comment: z.string().optional().describe("Optional comment added with the transition"),
        },
        annotations: { destructiveHint: false },
      },
      safe("jira_transition_issue", async ({ instance, key, transitionId, comment }) => {
        const inst = pick(instance);
        const body: Obj = { transition: { id: transitionId } };
        if (comment) body.update = { comment: [{ add: { body: richText(inst, comment) } }] };
        await api(inst, rest(inst, `/issue/${encodeURIComponent(key)}/transitions`), { method: "POST", body });
        return jsonResult({ ok: true, key, transitionId });
      }),
    );

    server.registerTool(
      "jira_add_comment",
      {
        title: "Add a comment to a Jira issue (write)",
        description: "Posts a comment on an issue.",
        inputSchema: {
          instance: instanceArg,
          key: z.string(),
          body: z.string().describe("Comment text"),
        },
        annotations: { destructiveHint: false },
      },
      safe("jira_add_comment", async ({ instance, key, body }) => {
        const inst = pick(instance);
        return jsonResult(
          await api(inst, rest(inst, `/issue/${encodeURIComponent(key)}/comment`), {
            method: "POST",
            body: { body: richText(inst, body) },
          }),
        );
      }),
    );

    server.registerTool(
      "jira_assign_issue",
      {
        title: "Assign a Jira issue (write)",
        description:
          "Assigns an issue. On Jira Cloud pass an accountId; on Server/DC pass a username.",
        inputSchema: {
          instance: instanceArg,
          key: z.string(),
          assignee: z.string().describe("accountId (Cloud) or username (Server/DC)"),
        },
        annotations: { destructiveHint: false },
      },
      safe("jira_assign_issue", async ({ instance, key, assignee }) => {
        const inst = pick(instance);
        const body = inst.apiVersion >= 3 ? { accountId: assignee } : { name: assignee };
        await api(inst, rest(inst, `/issue/${encodeURIComponent(key)}/assignee`), { method: "PUT", body });
        return jsonResult({ ok: true, key, assignee });
      }),
    );
  }

  return true;
}
