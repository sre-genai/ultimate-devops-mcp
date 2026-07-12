import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig, BitbucketConfig } from "../config.js";
import { httpRequest, jsonResult, qs, safe } from "../util.js";

function api(cfg: BitbucketConfig, path: string, opts: Parameters<typeof httpRequest>[1] = {}) {
  return httpRequest(`${cfg.baseUrl}${path}`, {
    ...opts,
    headers: { authorization: cfg.authHeader, ...(opts.headers ?? {}) },
  });
}

type Obj = Record<string, unknown>;

/** Resolve the workspace: explicit arg wins, else the configured default. */
function ws(cfg: BitbucketConfig, workspace?: string): string {
  const w = workspace ?? cfg.workspace;
  if (!w) throw new Error("workspace is required (pass it, or set BITBUCKET_WORKSPACE)");
  return encodeURIComponent(w);
}

export function registerBitbucket(server: McpServer, config: AppConfig): boolean {
  const cfg = config.integrations.bitbucket;
  if (!cfg) return false;

  server.registerTool(
    "bitbucket_list_repositories",
    {
      title: "List Bitbucket repositories",
      description: "Lists repositories in a workspace, most recently updated first.",
      inputSchema: {
        workspace: z.string().optional().describe("Defaults to BITBUCKET_WORKSPACE"),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("bitbucket_list_repositories", async ({ workspace, limit }) => {
      const res = (await api(
        cfg,
        `/repositories/${ws(cfg, workspace)}${qs({ pagelen: limit ?? 30, sort: "-updated_on" })}`,
      )) as { values?: Obj[] };
      return jsonResult(
        (res.values ?? []).map((r) => ({
          fullName: r.full_name,
          isPrivate: r.is_private,
          mainBranch: (r as { mainbranch?: { name?: string } }).mainbranch?.name,
          updatedOn: r.updated_on,
          language: r.language,
          url: (r as { links?: { html?: { href?: string } } }).links?.html?.href,
        })),
      );
    }),
  );

  server.registerTool(
    "bitbucket_list_pull_requests",
    {
      title: "List Bitbucket pull requests",
      description: "Lists pull requests for a repo.",
      inputSchema: {
        workspace: z.string().optional(),
        repo: z.string().describe("Repository slug"),
        state: z.enum(["OPEN", "MERGED", "DECLINED", "SUPERSEDED"]).optional().describe("Default: OPEN"),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("bitbucket_list_pull_requests", async ({ workspace, repo, state, limit }) => {
      const res = (await api(
        cfg,
        `/repositories/${ws(cfg, workspace)}/${encodeURIComponent(repo)}/pullrequests${qs({
          state: state ?? "OPEN",
          pagelen: limit ?? 20,
        })}`,
      )) as { values?: Obj[] };
      return jsonResult(
        (res.values ?? []).map((p) => ({
          id: p.id,
          title: p.title,
          state: p.state,
          author: (p as { author?: { display_name?: string } }).author?.display_name,
          source: (p as { source?: { branch?: { name?: string } } }).source?.branch?.name,
          destination: (p as { destination?: { branch?: { name?: string } } }).destination?.branch?.name,
          url: (p as { links?: { html?: { href?: string } } }).links?.html?.href,
        })),
      );
    }),
  );

  server.registerTool(
    "bitbucket_get_pull_request",
    {
      title: "Get Bitbucket pull request",
      description: "Full detail of one PR including merge/approval state.",
      inputSchema: {
        workspace: z.string().optional(),
        repo: z.string(),
        id: z.number().int(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("bitbucket_get_pull_request", async ({ workspace, repo, id }) => {
      const p = (await api(
        cfg,
        `/repositories/${ws(cfg, workspace)}/${encodeURIComponent(repo)}/pullrequests/${id}`,
      )) as Obj;
      return jsonResult({
        id: p.id,
        title: p.title,
        description: String(p.description ?? "").slice(0, 2000),
        state: p.state,
        author: (p as { author?: { display_name?: string } }).author?.display_name,
        source: (p as { source?: { branch?: { name?: string } } }).source?.branch?.name,
        destination: (p as { destination?: { branch?: { name?: string } } }).destination?.branch?.name,
        commentCount: (p as { comment_count?: number }).comment_count,
        taskCount: (p as { task_count?: number }).task_count,
        url: (p as { links?: { html?: { href?: string } } }).links?.html?.href,
      });
    }),
  );

  server.registerTool(
    "bitbucket_list_pipelines",
    {
      title: "List Bitbucket pipelines",
      description: "Lists recent Bitbucket Pipelines runs for a repo — use to find failing CI.",
      inputSchema: {
        workspace: z.string().optional(),
        repo: z.string(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("bitbucket_list_pipelines", async ({ workspace, repo, limit }) => {
      const res = (await api(
        cfg,
        `/repositories/${ws(cfg, workspace)}/${encodeURIComponent(repo)}/pipelines${qs({
          pagelen: limit ?? 20,
          sort: "-created_on",
        })}`,
      )) as { values?: Obj[] };
      return jsonResult(
        (res.values ?? []).map((p) => ({
          uuid: p.uuid,
          buildNumber: (p as { build_number?: number }).build_number,
          state: (p as { state?: { name?: string; result?: { name?: string } } }).state?.name,
          result: (p as { state?: { result?: { name?: string } } }).state?.result?.name,
          ref: (p as { target?: { ref_name?: string } }).target?.ref_name,
          createdOn: p.created_on,
        })),
      );
    }),
  );

  server.registerTool(
    "bitbucket_get_pipeline",
    {
      title: "Get Bitbucket pipeline",
      description: "Detail of one pipeline run (state, result, timings).",
      inputSchema: {
        workspace: z.string().optional(),
        repo: z.string(),
        uuid: z.string().describe("Pipeline UUID (with braces, as returned by list)"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("bitbucket_get_pipeline", async ({ workspace, repo, uuid }) => {
      const p = (await api(
        cfg,
        `/repositories/${ws(cfg, workspace)}/${encodeURIComponent(repo)}/pipelines/${encodeURIComponent(uuid)}`,
      )) as Obj;
      return jsonResult({
        uuid: p.uuid,
        buildNumber: (p as { build_number?: number }).build_number,
        state: (p as { state?: { name?: string } }).state?.name,
        result: (p as { state?: { result?: { name?: string } } }).state?.result?.name,
        ref: (p as { target?: { ref_name?: string } }).target?.ref_name,
        createdOn: p.created_on,
        completedOn: (p as { completed_on?: string }).completed_on,
        durationSeconds: (p as { duration_in_seconds?: number }).duration_in_seconds,
      });
    }),
  );

  if (config.allowWrites) {
    server.registerTool(
      "bitbucket_trigger_pipeline",
      {
        title: "Trigger a Bitbucket pipeline (write)",
        description: "Runs the pipeline for a branch. Enabled because MCP_ALLOW_WRITES=true.",
        inputSchema: {
          workspace: z.string().optional(),
          repo: z.string(),
          branch: z.string().describe("Branch to run on"),
        },
        annotations: { destructiveHint: true },
      },
      safe("bitbucket_trigger_pipeline", async ({ workspace, repo, branch }) =>
        jsonResult(
          await api(cfg, `/repositories/${ws(cfg, workspace)}/${encodeURIComponent(repo)}/pipelines`, {
            method: "POST",
            body: { target: { type: "pipeline_ref_target", ref_type: "branch", ref_name: branch } },
          }),
        ),
      ),
    );
  }

  return true;
}
