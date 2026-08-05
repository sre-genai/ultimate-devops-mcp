import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig, BitbucketInstance } from "../config.js";
import { httpRequest, jsonResult, qs, safe } from "../util.js";

function api(inst: BitbucketInstance, path: string, opts: Parameters<typeof httpRequest>[1] = {}) {
  return httpRequest(`${inst.baseUrl}${path}`, {
    ...opts,
    headers: { authorization: inst.authHeader, ...(opts.headers ?? {}) },
  });
}

type Obj = Record<string, unknown>;

/** Resolve the workspace: explicit arg wins, else the instance's default. */
function ws(inst: BitbucketInstance, workspace?: string): string {
  const w = workspace ?? inst.workspace;
  if (!w) throw new Error("workspace is required (pass it, or set BITBUCKET_WORKSPACE)");
  return encodeURIComponent(w);
}

export function registerBitbucket(server: McpServer, config: AppConfig): boolean {
  const cfg = config.integrations.bitbucket;
  if (!cfg) return false;
  const { instances, primary } = cfg;

  const names = Object.keys(instances);
  const multi = names.length > 1;
  const instanceArg = z
    .enum(names as [string, ...string[]])
    .optional()
    .describe(
      multi
        ? `Which Bitbucket to target: ${names.join(", ")} (default: ${primary}).`
        : `Bitbucket instance (only "${primary}" configured; optional).`,
    );

  function pick(instance?: string): BitbucketInstance {
    const inst = instances[instance ?? primary];
    if (!inst) {
      throw new Error(`Unknown Bitbucket instance "${instance}". Configured: ${names.join(", ")}.`);
    }
    return inst;
  }

  server.registerTool(
    "bitbucket_list_repositories",
    {
      title: "List Bitbucket repositories",
      description: "Lists repositories in a workspace, most recently updated first.",
      inputSchema: {
        instance: instanceArg,
        workspace: z.string().optional().describe("Defaults to BITBUCKET_WORKSPACE"),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("bitbucket_list_repositories", async ({ instance, workspace, limit }) => {
      const inst = pick(instance);
      const res = (await api(
        inst,
        `/repositories/${ws(inst, workspace)}${qs({ pagelen: limit ?? 30, sort: "-updated_on" })}`,
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
        instance: instanceArg,
        workspace: z.string().optional(),
        repo: z.string().describe("Repository slug"),
        state: z.enum(["OPEN", "MERGED", "DECLINED", "SUPERSEDED"]).optional().describe("Default: OPEN"),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("bitbucket_list_pull_requests", async ({ instance, workspace, repo, state, limit }) => {
      const inst = pick(instance);
      const res = (await api(
        inst,
        `/repositories/${ws(inst, workspace)}/${encodeURIComponent(repo)}/pullrequests${qs({
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
        instance: instanceArg,
        workspace: z.string().optional(),
        repo: z.string(),
        id: z.number().int(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("bitbucket_get_pull_request", async ({ instance, workspace, repo, id }) => {
      const inst = pick(instance);
      const p = (await api(
        inst,
        `/repositories/${ws(inst, workspace)}/${encodeURIComponent(repo)}/pullrequests/${id}`,
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
        instance: instanceArg,
        workspace: z.string().optional(),
        repo: z.string(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("bitbucket_list_pipelines", async ({ instance, workspace, repo, limit }) => {
      const inst = pick(instance);
      const res = (await api(
        inst,
        `/repositories/${ws(inst, workspace)}/${encodeURIComponent(repo)}/pipelines${qs({
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
        instance: instanceArg,
        workspace: z.string().optional(),
        repo: z.string(),
        uuid: z.string().describe("Pipeline UUID (with braces, as returned by list)"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("bitbucket_get_pipeline", async ({ instance, workspace, repo, uuid }) => {
      const inst = pick(instance);
      const p = (await api(
        inst,
        `/repositories/${ws(inst, workspace)}/${encodeURIComponent(repo)}/pipelines/${encodeURIComponent(uuid)}`,
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
          instance: instanceArg,
          workspace: z.string().optional(),
          repo: z.string(),
          branch: z.string().describe("Branch to run on"),
        },
        annotations: { destructiveHint: true },
      },
      safe("bitbucket_trigger_pipeline", async ({ instance, workspace, repo, branch }) => {
        const inst = pick(instance);
        return jsonResult(
          await api(inst, `/repositories/${ws(inst, workspace)}/${encodeURIComponent(repo)}/pipelines`, {
            method: "POST",
            body: { target: { type: "pipeline_ref_target", ref_type: "branch", ref_name: branch } },
          }),
        );
      }),
    );
  }

  return true;
}
