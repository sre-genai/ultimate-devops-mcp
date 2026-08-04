import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig, GitlabInstance } from "../config.js";
import { httpRequest, jsonResult, qs, safe, textResult } from "../util.js";

function api(inst: GitlabInstance, path: string, opts: Parameters<typeof httpRequest>[1] = {}) {
  return httpRequest(`${inst.url}/api/v4${path}`, {
    ...opts,
    headers: { "private-token": inst.token, ...(opts.headers ?? {}) },
  });
}

/** Accepts numeric project IDs or "group/subgroup/project" paths. */
function pid(project: string): string {
  return encodeURIComponent(project);
}

export function registerGitlab(server: McpServer, config: AppConfig): boolean {
  const cfg = config.integrations.gitlab;
  if (!cfg) return false;
  const { instances, primary } = cfg;

  const names = Object.keys(instances);
  const multi = names.length > 1;
  const instanceArg = z
    .enum(names as [string, ...string[]])
    .optional()
    .describe(
      multi
        ? `Which GitLab to target: ${names.join(", ")} (default: ${primary}).`
        : `GitLab instance (only "${primary}" configured; optional).`,
    );

  function pick(instance?: string): GitlabInstance {
    const inst = instances[instance ?? primary];
    if (!inst) {
      throw new Error(`Unknown GitLab instance "${instance}". Configured: ${names.join(", ")}.`);
    }
    return inst;
  }

  server.registerTool(
    "gitlab_list_projects",
    {
      title: "List GitLab projects",
      description: "Lists projects you're a member of, sorted by recent activity.",
      inputSchema: {
        instance: instanceArg,
        search: z.string().optional().describe("Project name filter"),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("gitlab_list_projects", async ({ instance, search, limit }) => {
      const res = (await api(
        pick(instance),
        `/projects${qs({
          search,
          membership: true,
          per_page: limit ?? 30,
          order_by: "last_activity_at",
          simple: true,
        })}`,
      )) as Array<Record<string, unknown>>;
      return jsonResult(
        res.map((p) => ({
          id: p.id,
          path: (p as { path_with_namespace?: string }).path_with_namespace,
          description: p.description,
          defaultBranch: (p as { default_branch?: string }).default_branch,
          lastActivityAt: (p as { last_activity_at?: string }).last_activity_at,
          webUrl: (p as { web_url?: string }).web_url,
        })),
      );
    }),
  );

  server.registerTool(
    "gitlab_list_pipelines",
    {
      title: "List GitLab pipelines",
      description: "Lists recent CI pipelines for a project.",
      inputSchema: {
        instance: instanceArg,
        project: z.string().describe('Project ID or "group/project" path'),
        ref: z.string().optional().describe("Branch/tag filter"),
        status: z
          .enum(["running", "pending", "success", "failed", "canceled", "skipped", "created", "manual"])
          .optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("gitlab_list_pipelines", async ({ instance, project, ref, status, limit }) => {
      const res = (await api(
        pick(instance),
        `/projects/${pid(project)}/pipelines${qs({ ref, status, per_page: limit ?? 20 })}`,
      )) as Array<Record<string, unknown>>;
      return jsonResult(
        res.map((p) => ({
          id: p.id,
          status: p.status,
          ref: p.ref,
          sha: typeof p.sha === "string" ? p.sha.slice(0, 10) : p.sha,
          source: p.source,
          createdAt: (p as { created_at?: string }).created_at,
          webUrl: (p as { web_url?: string }).web_url,
        })),
      );
    }),
  );

  server.registerTool(
    "gitlab_pipeline_jobs",
    {
      title: "List GitLab pipeline jobs",
      description: "Lists jobs in a pipeline with stage, status and duration — use to find failing jobs.",
      inputSchema: {
        instance: instanceArg,
        project: z.string(),
        pipelineId: z.number().int(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("gitlab_pipeline_jobs", async ({ instance, project, pipelineId }) => {
      const res = (await api(pick(instance), `/projects/${pid(project)}/pipelines/${pipelineId}/jobs${qs({ per_page: 100 })}`)) as Array<
        Record<string, unknown>
      >;
      return jsonResult(
        res.map((j) => ({
          id: j.id,
          name: j.name,
          stage: j.stage,
          status: j.status,
          durationSeconds: j.duration,
          failureReason: (j as { failure_reason?: string }).failure_reason,
          webUrl: (j as { web_url?: string }).web_url,
        })),
      );
    }),
  );

  server.registerTool(
    "gitlab_job_log",
    {
      title: "Get GitLab job log",
      description: "Fetches the trace/log of a CI job (tail of it) — use to diagnose failures.",
      inputSchema: {
        instance: instanceArg,
        project: z.string(),
        jobId: z.number().int(),
        tailLines: z.number().int().min(10).max(2000).optional().describe("Lines from the end (default 200)"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("gitlab_job_log", async ({ instance, project, jobId, tailLines }) => {
      const trace = (await api(pick(instance), `/projects/${pid(project)}/jobs/${jobId}/trace`, { raw: true })) as string;
      const lines = trace.split("\n");
      const tail = lines.slice(-(tailLines ?? 200)).join("\n");
      return textResult(tail || "(empty log)");
    }),
  );

  server.registerTool(
    "gitlab_list_merge_requests",
    {
      title: "List GitLab merge requests",
      description: "Lists merge requests for a project.",
      inputSchema: {
        instance: instanceArg,
        project: z.string(),
        state: z.enum(["opened", "closed", "merged", "all"]).optional().describe("Default: opened"),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("gitlab_list_merge_requests", async ({ instance, project, state, limit }) => {
      const res = (await api(
        pick(instance),
        `/projects/${pid(project)}/merge_requests${qs({ state: state ?? "opened", per_page: limit ?? 20, order_by: "updated_at" })}`,
      )) as Array<Record<string, unknown>>;
      return jsonResult(
        res.map((mr) => ({
          iid: mr.iid,
          title: mr.title,
          state: mr.state,
          sourceBranch: (mr as { source_branch?: string }).source_branch,
          targetBranch: (mr as { target_branch?: string }).target_branch,
          author: (mr as { author?: { username?: string } }).author?.username,
          draft: mr.draft,
          hasConflicts: (mr as { has_conflicts?: boolean }).has_conflicts,
          webUrl: (mr as { web_url?: string }).web_url,
        })),
      );
    }),
  );

  server.registerTool(
    "gitlab_get_merge_request",
    {
      title: "Get GitLab merge request",
      description: "Full detail of one merge request including pipeline status and merge status.",
      inputSchema: {
        instance: instanceArg,
        project: z.string(),
        iid: z.number().int().describe("MR IID (the number in the MR URL)"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("gitlab_get_merge_request", async ({ instance, project, iid }) => {
      const mr = (await api(pick(instance), `/projects/${pid(project)}/merge_requests/${iid}`)) as Record<string, unknown>;
      return jsonResult({
        iid: mr.iid,
        title: mr.title,
        description: String(mr.description ?? "").slice(0, 2000),
        state: mr.state,
        detailedMergeStatus: (mr as { detailed_merge_status?: string }).detailed_merge_status,
        sourceBranch: (mr as { source_branch?: string }).source_branch,
        targetBranch: (mr as { target_branch?: string }).target_branch,
        author: (mr as { author?: { username?: string } }).author?.username,
        pipeline: (mr as { head_pipeline?: { id?: number; status?: string; web_url?: string } }).head_pipeline,
        changesCount: (mr as { changes_count?: string }).changes_count,
        webUrl: (mr as { web_url?: string }).web_url,
      });
    }),
  );

  if (config.allowWrites) {
    server.registerTool(
      "gitlab_trigger_pipeline",
      {
        title: "Trigger GitLab pipeline (write)",
        description: "Creates a new pipeline on a ref. Enabled because MCP_ALLOW_WRITES=true.",
        inputSchema: {
          instance: instanceArg,
          project: z.string(),
          ref: z.string().describe("Branch or tag to run on"),
          variables: z.record(z.string()).optional().describe("CI variables as key/value"),
        },
        annotations: { destructiveHint: true },
      },
      safe("gitlab_trigger_pipeline", async ({ instance, project, ref, variables }) =>
        jsonResult(
          await api(pick(instance), `/projects/${pid(project)}/pipeline`, {
            method: "POST",
            body: {
              ref,
              variables: variables ? Object.entries(variables).map(([key, value]) => ({ key, value })) : undefined,
            },
          }),
        ),
      ),
    );

    server.registerTool(
      "gitlab_retry_job",
      {
        title: "Retry GitLab job (write)",
        description: "Retries a failed CI job. Enabled because MCP_ALLOW_WRITES=true.",
        inputSchema: {
          instance: instanceArg,
          project: z.string(),
          jobId: z.number().int(),
        },
        annotations: { destructiveHint: true },
      },
      safe("gitlab_retry_job", async ({ instance, project, jobId }) =>
        jsonResult(await api(pick(instance), `/projects/${pid(project)}/jobs/${jobId}/retry`, { method: "POST" })),
      ),
    );
  }

  return true;
}
