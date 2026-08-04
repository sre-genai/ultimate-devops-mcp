import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig, JenkinsConfig } from "../config.js";
import { httpRequest, jsonResult, qs, safe } from "../util.js";

function api(cfg: JenkinsConfig, path: string, opts: Parameters<typeof httpRequest>[1] = {}) {
  return httpRequest(`${cfg.baseUrl}${path}`, {
    ...opts,
    headers: { authorization: cfg.authHeader, ...(opts.headers ?? {}) },
  });
}

/** Build the /job/<a>/job/<b> path for a possibly-nested job (folders). */
function jobPath(job: string): string {
  return job
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => `/job/${encodeURIComponent(s)}`)
    .join("");
}

type Obj = Record<string, unknown>;

export function registerJenkins(server: McpServer, config: AppConfig): boolean {
  const cfg = config.integrations.jenkins;
  if (!cfg) return false;

  server.registerTool(
    "jenkins_list_jobs",
    {
      title: "List Jenkins jobs",
      description: "Lists jobs (name, URL, last-build status color) at the root or inside a folder.",
      inputSchema: {
        folder: z.string().optional().describe("Folder path to list within, e.g. 'team/services'"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("jenkins_list_jobs", async ({ folder }) => {
      const base = folder ? jobPath(folder) : "";
      const res = (await api(cfg, `${base}/api/json?tree=jobs[name,url,color]`)) as { jobs?: Obj[] };
      return jsonResult(
        (res.jobs ?? []).map((j) => ({
          name: j.name,
          color: j.color,
          url: j.url,
        })),
      );
    }),
  );

  server.registerTool(
    "jenkins_get_job",
    {
      title: "Get Jenkins job",
      description: "Job detail: buildability, health, and recent builds.",
      inputSchema: {
        job: z.string().describe("Job path, e.g. 'my-job' or 'folder/my-job'"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("jenkins_get_job", async ({ job }) => {
      const j = (await api(
        cfg,
        `${jobPath(job)}/api/json?tree=name,url,buildable,color,healthReport[description,score],lastBuild[number,result,timestamp],builds[number,result,timestamp,url]{0,20}`,
      )) as Obj;
      return jsonResult(j);
    }),
  );

  server.registerTool(
    "jenkins_get_build",
    {
      title: "Get Jenkins build",
      description: "Detail of one build (result, duration, cause, triggering commit).",
      inputSchema: {
        job: z.string().describe("Job path, e.g. 'folder/my-job'"),
        number: z.number().int().describe("Build number (or use lastBuild via jenkins_get_job)"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("jenkins_get_build", async ({ job, number }) => {
      const b = (await api(
        cfg,
        `${jobPath(job)}/${number}/api/json?tree=number,result,building,duration,timestamp,url,displayName,actions[causes[shortDescription]]`,
      )) as Obj;
      return jsonResult(b);
    }),
  );

  server.registerTool(
    "jenkins_build_log",
    {
      title: "Get Jenkins build console log (tail)",
      description: "Returns the console output of a build, tailed to the last N characters.",
      inputSchema: {
        job: z.string().describe("Job path"),
        number: z.number().int().describe("Build number"),
        tailChars: z.number().int().min(500).max(200_000).optional().describe("Last N chars (default 20000)"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("jenkins_build_log", async ({ job, number, tailChars }) => {
      const text = (await api(cfg, `${jobPath(job)}/${number}/consoleText`, { raw: true })) as string;
      const n = tailChars ?? 20_000;
      const tail = text.length > n ? text.slice(-n) : text;
      return jsonResult({ job, number, truncated: text.length > n, log: tail });
    }),
  );

  if (config.allowWrites) {
    server.registerTool(
      "jenkins_trigger_build",
      {
        title: "Trigger a Jenkins build (write)",
        description:
          "Queues a build for a job, with optional string parameters. Enabled because MCP_ALLOW_WRITES=true.",
        inputSchema: {
          job: z.string().describe("Job path"),
          parameters: z.record(z.string()).optional().describe("Build parameters (string values)"),
        },
        annotations: { destructiveHint: true },
      },
      safe("jenkins_trigger_build", async ({ job, parameters }) => {
        const hasParams = parameters && Object.keys(parameters).length > 0;
        const endpoint = hasParams
          ? `${jobPath(job)}/buildWithParameters${qs(parameters as Record<string, string>)}`
          : `${jobPath(job)}/build`;
        await api(cfg, endpoint, { method: "POST", raw: true });
        return jsonResult({ job, queued: true });
      }),
    );
  }

  return true;
}
