import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig, SonarQubeConfig } from "../config.js";
import { httpRequest, jsonResult, qs, safe } from "../util.js";

function api(cfg: SonarQubeConfig, path: string) {
  return httpRequest(`${cfg.baseUrl}${path}`, { headers: { authorization: cfg.authHeader } });
}

type Obj = Record<string, unknown>;

const DEFAULT_METRICS =
  "bugs,vulnerabilities,code_smells,coverage,duplicated_lines_density,ncloc,reliability_rating,security_rating,sqale_rating,alert_status";

// SonarQube is read-only here (analysis is pushed by scanners; we report on it).
export function registerSonarQube(server: McpServer, config: AppConfig): boolean {
  const cfg = config.integrations.sonarqube;
  if (!cfg) return false;

  server.registerTool(
    "sonarqube_list_projects",
    {
      title: "List SonarQube projects",
      description: "Lists analyzed projects (components of type project), optionally filtered by a search term.",
      inputSchema: {
        query: z.string().optional().describe("Filter by name/key substring"),
        pageSize: z.number().int().min(1).max(500).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("sonarqube_list_projects", async ({ query, pageSize }) => {
      const res = (await api(
        cfg,
        `/api/components/search${qs({ qualifiers: "TRK", ps: pageSize ?? 100, q: query })}`,
      )) as { components?: Obj[]; paging?: Obj };
      return jsonResult({
        total: res?.paging?.total,
        projects: (res?.components ?? []).map((c) => ({ key: c.key, name: c.name, qualifier: c.qualifier })),
      });
    }),
  );

  server.registerTool(
    "sonarqube_project_measures",
    {
      title: "SonarQube project measures",
      description:
        "Metric values for a project: bugs, vulnerabilities, code smells, coverage, duplication, ratings, and quality-gate status.",
      inputSchema: {
        component: z.string().describe("Project key"),
        metricKeys: z.string().optional().describe(`Comma-separated metric keys (default: ${DEFAULT_METRICS})`),
        branch: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("sonarqube_project_measures", async ({ component, metricKeys, branch }) => {
      const res = (await api(
        cfg,
        `/api/measures/component${qs({ component, metricKeys: metricKeys ?? DEFAULT_METRICS, branch })}`,
      )) as { component?: { name?: string; measures?: Obj[] } };
      return jsonResult({
        component,
        name: res?.component?.name,
        measures: (res?.component?.measures ?? []).map((m) => ({ metric: m.metric, value: m.value ?? m.period })),
      });
    }),
  );

  server.registerTool(
    "sonarqube_quality_gate",
    {
      title: "SonarQube quality gate status",
      description: "The project's quality-gate status (OK/ERROR) and each failing condition.",
      inputSchema: {
        projectKey: z.string().describe("Project key"),
        branch: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("sonarqube_quality_gate", async ({ projectKey, branch }) => {
      const res = (await api(cfg, `/api/qualitygates/project_status${qs({ projectKey, branch })}`)) as {
        projectStatus?: Obj;
      };
      return jsonResult(res?.projectStatus ?? res);
    }),
  );

  server.registerTool(
    "sonarqube_issues",
    {
      title: "Search SonarQube issues",
      description: "Lists issues for a project, filterable by type, severity and status.",
      inputSchema: {
        componentKeys: z.string().describe("Project key (or comma-separated keys)"),
        types: z.string().optional().describe("CODE_SMELL,BUG,VULNERABILITY"),
        severities: z.string().optional().describe("INFO,MINOR,MAJOR,CRITICAL,BLOCKER"),
        statuses: z.string().optional().describe("OPEN,CONFIRMED,REOPENED,RESOLVED,CLOSED"),
        pageSize: z.number().int().min(1).max(500).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("sonarqube_issues", async ({ componentKeys, types, severities, statuses, pageSize }) => {
      const res = (await api(
        cfg,
        `/api/issues/search${qs({ componentKeys, types, severities, statuses, ps: pageSize ?? 50 })}`,
      )) as { total?: number; issues?: Obj[] };
      return jsonResult({
        total: res?.total,
        issues: (res?.issues ?? []).map((i) => ({
          key: i.key,
          rule: i.rule,
          type: i.type,
          severity: i.severity,
          component: i.component,
          line: i.line,
          status: i.status,
          message: i.message,
          effort: i.effort,
        })),
      });
    }),
  );

  return true;
}
