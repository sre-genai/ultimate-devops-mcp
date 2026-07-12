import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig, GitHubConfig } from "../config.js";
import { httpRequest, jsonResult, qs, safe, textResult } from "../util.js";

function api(cfg: GitHubConfig, path: string, opts: Parameters<typeof httpRequest>[1] = {}) {
  return httpRequest(`${cfg.baseUrl}${path}`, {
    ...opts,
    headers: {
      authorization: `Bearer ${cfg.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(opts.headers ?? {}),
    },
  });
}

type Obj = Record<string, unknown>;

export function registerGitHub(server: McpServer, config: AppConfig): boolean {
  const cfg = config.integrations.github;
  if (!cfg) return false;

  server.registerTool(
    "github_list_repos",
    {
      title: "List GitHub repositories",
      description:
        "Lists repositories for an org or user (owner), or the authenticated user's repos when owner is omitted. Sorted by recent push.",
      inputSchema: {
        owner: z.string().optional().describe("Org or user login; omit for your own repos"),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("github_list_repos", async ({ owner, limit }) => {
      const per_page = limit ?? 30;
      const path = owner
        ? `/orgs/${encodeURIComponent(owner)}/repos${qs({ per_page, sort: "pushed" })}`
        : `/user/repos${qs({ per_page, sort: "pushed", affiliation: "owner,collaborator,organization_member" })}`;
      // Fall back to the user endpoint if the owner isn't an org.
      let res: Obj[];
      try {
        res = (await api(cfg, path)) as Obj[];
      } catch {
        res = (await api(cfg, `/users/${encodeURIComponent(owner ?? "")}/repos${qs({ per_page, sort: "pushed" })}`)) as Obj[];
      }
      return jsonResult(
        res.map((r) => ({
          fullName: r.full_name,
          private: r.private,
          defaultBranch: r.default_branch,
          description: r.description,
          pushedAt: r.pushed_at,
          openIssues: r.open_issues_count,
          url: r.html_url,
        })),
      );
    }),
  );

  server.registerTool(
    "github_list_pull_requests",
    {
      title: "List GitHub pull requests",
      description: "Lists pull requests for a repo.",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        state: z.enum(["open", "closed", "all"]).optional().describe("Default: open"),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("github_list_pull_requests", async ({ owner, repo, state, limit }) => {
      const res = (await api(
        cfg,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls${qs({
          state: state ?? "open",
          per_page: limit ?? 20,
          sort: "updated",
          direction: "desc",
        })}`,
      )) as Obj[];
      return jsonResult(
        res.map((p) => ({
          number: p.number,
          title: p.title,
          state: p.state,
          draft: p.draft,
          head: (p as { head?: { ref?: string } }).head?.ref,
          base: (p as { base?: { ref?: string } }).base?.ref,
          author: (p as { user?: { login?: string } }).user?.login,
          url: p.html_url,
        })),
      );
    }),
  );

  server.registerTool(
    "github_get_pull_request",
    {
      title: "Get GitHub pull request",
      description: "Full detail of one PR: mergeable state, review/CI status, diff size.",
      inputSchema: { owner: z.string(), repo: z.string(), number: z.number().int() },
      annotations: { readOnlyHint: true },
    },
    safe("github_get_pull_request", async ({ owner, repo, number }) => {
      const pr = (await api(
        cfg,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`,
      )) as Obj;
      return jsonResult({
        number: pr.number,
        title: pr.title,
        body: String(pr.body ?? "").slice(0, 2000),
        state: pr.state,
        merged: pr.merged,
        mergeable: pr.mergeable,
        mergeableState: (pr as { mergeable_state?: string }).mergeable_state,
        head: (pr as { head?: { ref?: string } }).head?.ref,
        base: (pr as { base?: { ref?: string } }).base?.ref,
        additions: pr.additions,
        deletions: pr.deletions,
        changedFiles: (pr as { changed_files?: number }).changed_files,
        url: pr.html_url,
      });
    }),
  );

  server.registerTool(
    "github_list_workflow_runs",
    {
      title: "List GitHub Actions runs",
      description: "Lists recent GitHub Actions workflow runs for a repo — use to find failing CI.",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        branch: z.string().optional(),
        status: z
          .enum(["queued", "in_progress", "completed", "success", "failure", "cancelled"])
          .optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("github_list_workflow_runs", async ({ owner, repo, branch, status, limit }) => {
      const res = (await api(
        cfg,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs${qs({
          branch,
          status,
          per_page: limit ?? 20,
        })}`,
      )) as { workflow_runs?: Obj[] };
      return jsonResult(
        (res.workflow_runs ?? []).map((r) => ({
          id: r.id,
          name: r.name,
          status: r.status,
          conclusion: r.conclusion,
          branch: (r as { head_branch?: string }).head_branch,
          event: r.event,
          runNumber: (r as { run_number?: number }).run_number,
          createdAt: r.created_at,
          url: r.html_url,
        })),
      );
    }),
  );

  server.registerTool(
    "github_workflow_run_jobs",
    {
      title: "List GitHub Actions run jobs",
      description: "Lists jobs (and their steps' conclusions) for a workflow run — use to pinpoint a CI failure.",
      inputSchema: { owner: z.string(), repo: z.string(), runId: z.number().int() },
      annotations: { readOnlyHint: true },
    },
    safe("github_workflow_run_jobs", async ({ owner, repo, runId }) => {
      const res = (await api(
        cfg,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}/jobs${qs({ per_page: 100 })}`,
      )) as { jobs?: Obj[] };
      return jsonResult(
        (res.jobs ?? []).map((j) => ({
          id: j.id,
          name: j.name,
          status: j.status,
          conclusion: j.conclusion,
          startedAt: (j as { started_at?: string }).started_at,
          completedAt: (j as { completed_at?: string }).completed_at,
          failedSteps: ((j as { steps?: Array<{ name?: string; conclusion?: string }> }).steps ?? [])
            .filter((s) => s.conclusion === "failure")
            .map((s) => s.name),
          url: j.html_url,
        })),
      );
    }),
  );

  server.registerTool(
    "github_list_issues",
    {
      title: "List GitHub issues",
      description: "Lists issues for a repo (excludes pull requests).",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        state: z.enum(["open", "closed", "all"]).optional(),
        labels: z.string().optional().describe("Comma-separated label filter"),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("github_list_issues", async ({ owner, repo, state, labels, limit }) => {
      const res = (await api(
        cfg,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues${qs({
          state: state ?? "open",
          labels,
          per_page: limit ?? 20,
        })}`,
      )) as Obj[];
      return jsonResult(
        res
          .filter((i) => !i.pull_request)
          .map((i) => ({
            number: i.number,
            title: i.title,
            state: i.state,
            author: (i as { user?: { login?: string } }).user?.login,
            labels: ((i as { labels?: Array<{ name?: string }> }).labels ?? []).map((l) => l.name),
            comments: i.comments,
            url: i.html_url,
          })),
      );
    }),
  );

  server.registerTool(
    "github_get_issue",
    {
      title: "Get GitHub issue",
      description: "Full detail (body + metadata) of one issue.",
      inputSchema: { owner: z.string(), repo: z.string(), number: z.number().int() },
      annotations: { readOnlyHint: true },
    },
    safe("github_get_issue", async ({ owner, repo, number }) => {
      const i = (await api(
        cfg,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`,
      )) as Obj;
      return jsonResult({
        number: i.number,
        title: i.title,
        body: String(i.body ?? "").slice(0, 2000),
        state: i.state,
        author: (i as { user?: { login?: string } }).user?.login,
        labels: ((i as { labels?: Array<{ name?: string }> }).labels ?? []).map((l) => l.name),
        url: i.html_url,
      });
    }),
  );

  server.registerTool(
    "github_list_commits",
    {
      title: "List GitHub commits",
      description: "Lists recent commits on a branch/ref.",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        sha: z.string().optional().describe("Branch, tag or SHA to start from"),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("github_list_commits", async ({ owner, repo, sha, limit }) => {
      const res = (await api(
        cfg,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits${qs({ sha, per_page: limit ?? 20 })}`,
      )) as Obj[];
      return jsonResult(
        res.map((c) => ({
          sha: typeof c.sha === "string" ? c.sha.slice(0, 10) : c.sha,
          message: String((c as { commit?: { message?: string } }).commit?.message ?? "").split("\n")[0],
          author: (c as { commit?: { author?: { name?: string; date?: string } } }).commit?.author?.name,
          date: (c as { commit?: { author?: { date?: string } } }).commit?.author?.date,
          url: c.html_url,
        })),
      );
    }),
  );

  if (config.allowWrites) {
    server.registerTool(
      "github_dispatch_workflow",
      {
        title: "Dispatch a GitHub Actions workflow (write)",
        description:
          "Triggers a workflow_dispatch run. `workflow` is the file name (e.g. ci.yml) or numeric ID. Enabled because MCP_ALLOW_WRITES=true.",
        inputSchema: {
          owner: z.string(),
          repo: z.string(),
          workflow: z.string().describe("Workflow file name or ID"),
          ref: z.string().describe("Branch/tag to run on"),
          inputs: z.record(z.string()).optional(),
        },
        annotations: { destructiveHint: true },
      },
      safe("github_dispatch_workflow", async ({ owner, repo, workflow, ref, inputs }) => {
        await api(
          cfg,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
          { method: "POST", body: { ref, inputs }, raw: true },
        );
        return textResult(`dispatched ${workflow} on ${ref}`);
      }),
    );

    server.registerTool(
      "github_rerun_workflow",
      {
        title: "Re-run a GitHub Actions run (write)",
        description: "Re-runs a completed workflow run. Enabled because MCP_ALLOW_WRITES=true.",
        inputSchema: { owner: z.string(), repo: z.string(), runId: z.number().int() },
        annotations: { destructiveHint: true },
      },
      safe("github_rerun_workflow", async ({ owner, repo, runId }) => {
        await api(
          cfg,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}/rerun`,
          { method: "POST", raw: true },
        );
        return textResult(`re-run requested for run ${runId}`);
      }),
    );
  }

  return true;
}
