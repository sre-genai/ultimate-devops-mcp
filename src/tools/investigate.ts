import * as k8s from "@kubernetes/client-node";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  AppConfig,
  ArgoCDInstance,
  DatadogInstance,
  GitHubInstance,
  GitlabInstance,
  KubernetesConfig,
  PrometheusInstance,
} from "../config.js";
import { httpRequest, jsonResult, qs, safe } from "../util.js";

// ---------------------------------------------------------------------------
// devops_investigate is the cross-integration meta-tool: given a service, it
// fans out to every ENABLED integration and correlates their signals in one
// call. Each source is gathered independently and its failure is captured in
// `errors` rather than aborting the whole investigation, so a partial picture
// is always returned. It re-uses the shared httpRequest/qs helpers so there is
// no duplicated HTTP transport logic.
// ---------------------------------------------------------------------------

const mentions = (haystack: unknown, needle: string): boolean =>
  JSON.stringify(haystack ?? "").toLowerCase().includes(needle.toLowerCase());

// --- Kubernetes ------------------------------------------------------------

let k8sClients: { core: k8s.CoreV1Api } | undefined;

function k8sCore(cfg: KubernetesConfig): { core: k8s.CoreV1Api } {
  if (!k8sClients) {
    const kc = new k8s.KubeConfig();
    if (cfg.kubeconfigPath) kc.loadFromFile(cfg.kubeconfigPath);
    else kc.loadFromDefault();
    k8sClients = { core: kc.makeApiClient(k8s.CoreV1Api) };
  }
  return k8sClients;
}

function podMatchesService(p: k8s.V1Pod, service: string): boolean {
  const s = service.toLowerCase();
  if (p.metadata?.name?.toLowerCase().includes(s)) return true;
  const labels = p.metadata?.labels ?? {};
  for (const key of ["app", "app.kubernetes.io/name", "app.kubernetes.io/instance", "service"]) {
    const v = labels[key];
    if (v && v.toLowerCase().includes(s)) return true;
  }
  return false;
}

async function gatherKubernetes(
  cfg: KubernetesConfig,
  service: string,
  namespace: string | undefined,
  sinceMinutes: number,
): Promise<unknown> {
  const { core } = k8sCore(cfg);
  const podList = namespace
    ? await core.listNamespacedPod({ namespace })
    : await core.listPodForAllNamespaces();
  const matched = podList.items.filter((p) => podMatchesService(p, service));

  const pods = matched.slice(0, 20).map((p) => ({
    namespace: p.metadata?.namespace,
    name: p.metadata?.name,
    phase: p.status?.phase,
    ready: `${p.status?.containerStatuses?.filter((c) => c.ready).length ?? 0}/${p.spec?.containers.length ?? 0}`,
    restarts: p.status?.containerStatuses?.reduce((n, c) => n + c.restartCount, 0) ?? 0,
    node: p.spec?.nodeName,
  }));

  // Recent warning events involving the matched pods (or the service name).
  const podNames = new Set(matched.map((p) => p.metadata?.name));
  const cutoff = Date.now() - sinceMinutes * 60_000;
  const eventList = namespace
    ? await core.listNamespacedEvent({ namespace, fieldSelector: "type=Warning" })
    : await core.listEventForAllNamespaces({ fieldSelector: "type=Warning" });
  const events = eventList.items
    .filter((e) => {
      const seen = new Date(e.lastTimestamp ?? e.eventTime ?? 0).getTime();
      if (seen < cutoff) return false;
      const name = e.involvedObject?.name;
      return (name && podNames.has(name)) || (name?.toLowerCase().includes(service.toLowerCase()) ?? false);
    })
    .sort(
      (a, b) =>
        new Date(b.lastTimestamp ?? b.eventTime ?? 0).getTime() -
        new Date(a.lastTimestamp ?? a.eventTime ?? 0).getTime(),
    )
    .slice(0, 25)
    .map((e) => ({
      namespace: e.metadata?.namespace,
      reason: e.reason,
      object: `${e.involvedObject?.kind}/${e.involvedObject?.name}`,
      message: e.message,
      count: e.count,
      lastSeen: e.lastTimestamp ?? e.eventTime,
    }));

  // Tail of logs from the first matched pod (previous instance if it crashed).
  let logs: { pod?: string; namespace?: string; tail?: string } | undefined;
  const first = matched[0];
  if (first?.metadata?.name && first.metadata.namespace) {
    const restarted =
      (first.status?.containerStatuses?.reduce((n, c) => n + c.restartCount, 0) ?? 0) > 0;
    const tail = await core.readNamespacedPodLog({
      name: first.metadata.name,
      namespace: first.metadata.namespace,
      tailLines: 100,
      previous: restarted,
      timestamps: true,
    });
    logs = {
      pod: first.metadata.name,
      namespace: first.metadata.namespace,
      tail: tail || "(no log output)",
    };
  }

  return { matchedPods: matched.length, pods, warningEvents: events, logs };
}

// --- Alerts (Prometheus + Datadog) ----------------------------------------

async function gatherPrometheusAlerts(cfg: PrometheusInstance, service: string): Promise<unknown> {
  const res = (await httpRequest(`${cfg.url}/api/v1/alerts`, {
    headers: cfg.bearerToken ? { authorization: `Bearer ${cfg.bearerToken}` } : {},
  })) as { data?: { alerts?: Array<Record<string, unknown>> } };
  return (res.data?.alerts ?? [])
    .filter((a) => a.state === "firing")
    .filter((a) => mentions(a.labels, service) || mentions(a.annotations, service))
    .slice(0, 50)
    .map((a) => ({
      state: a.state,
      labels: a.labels,
      annotations: a.annotations,
      activeAt: a.activeAt,
    }));
}

async function gatherDatadogAlerts(cfg: DatadogInstance, service: string): Promise<unknown> {
  const res = (await httpRequest(
    `https://api.${cfg.site}/api/v1/monitor/search${qs({ query: `status:alert ${service}`, per_page: 50 })}`,
    { headers: { "dd-api-key": cfg.apiKey, "dd-application-key": cfg.appKey } },
  )) as { monitors?: Array<Record<string, unknown>> };
  return (res.monitors ?? []).map((m) => ({
    id: m.id,
    name: m.name,
    status: (m as { status?: string }).status,
    tags: m.tags,
  }));
}

// --- ArgoCD ----------------------------------------------------------------

interface ArgoApp {
  metadata?: { name?: string };
  spec?: { project?: string; source?: unknown };
  status?: {
    sync?: { status?: string; revision?: string };
    health?: { status?: string; message?: string };
    operationState?: { phase?: string; message?: string; finishedAt?: string };
  };
}

function argo(cfg: ArgoCDInstance, path: string): Promise<unknown> {
  return httpRequest(`${cfg.url}${path}`, { headers: { authorization: `Bearer ${cfg.token}` } });
}

async function gatherArgoCD(cfg: ArgoCDInstance, service: string): Promise<unknown> {
  // Prefer an exact-name match; fall back to a name search and take the first.
  let app: ArgoApp | undefined;
  try {
    app = (await argo(cfg, `/api/v1/applications/${encodeURIComponent(service)}`)) as ArgoApp;
  } catch {
    const res = (await argo(cfg, `/api/v1/applications${qs({ search: service })}`)) as {
      items?: ArgoApp[];
    };
    app = res.items?.[0];
  }
  if (!app) return { matched: false };
  return {
    matched: true,
    name: app.metadata?.name,
    project: app.spec?.project,
    syncStatus: app.status?.sync?.status,
    health: app.status?.health?.status,
    healthMessage: app.status?.health?.message,
    revision: app.status?.sync?.revision?.slice(0, 10),
    lastOperation: app.status?.operationState
      ? {
          phase: app.status.operationState.phase,
          message: app.status.operationState.message,
          finishedAt: app.status.operationState.finishedAt,
        }
      : undefined,
  };
}

// --- CI (GitLab + GitHub) --------------------------------------------------

async function gatherGitlabCI(cfg: GitlabInstance, service: string): Promise<unknown> {
  const headers = { "private-token": cfg.token };
  const projects = (await httpRequest(
    `${cfg.url}/api/v4/projects${qs({ search: service, membership: true, per_page: 1, order_by: "last_activity_at", simple: true })}`,
    { headers },
  )) as Array<Record<string, unknown>>;
  const project = projects[0];
  if (!project) return { matched: false };
  const pipelines = (await httpRequest(
    `${cfg.url}/api/v4/projects/${project.id}/pipelines${qs({ per_page: 1 })}`,
    { headers },
  )) as Array<Record<string, unknown>>;
  const p = pipelines[0];
  return {
    project: (project as { path_with_namespace?: string }).path_with_namespace,
    latestPipeline: p
      ? {
          id: p.id,
          status: p.status,
          ref: p.ref,
          sha: typeof p.sha === "string" ? p.sha.slice(0, 10) : p.sha,
          createdAt: (p as { created_at?: string }).created_at,
          webUrl: (p as { web_url?: string }).web_url,
        }
      : undefined,
  };
}

function gh(cfg: GitHubInstance, path: string): Promise<unknown> {
  return httpRequest(`${cfg.baseUrl}${path}`, {
    headers: {
      authorization: `Bearer ${cfg.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
  });
}

async function gatherGithubCI(cfg: GitHubInstance, service: string): Promise<unknown> {
  // Accept "owner/repo" directly, otherwise search for the best-matching repo.
  let fullName: string | undefined;
  if (service.includes("/")) {
    fullName = service;
  } else {
    const res = (await gh(cfg, `/search/repositories${qs({ q: service, per_page: 1 })}`)) as {
      items?: Array<{ full_name?: string }>;
    };
    fullName = res.items?.[0]?.full_name;
  }
  if (!fullName) return { matched: false };
  const [owner, repo] = fullName.split("/");
  const runs = (await gh(
    cfg,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs${qs({ per_page: 1 })}`,
  )) as { workflow_runs?: Array<Record<string, unknown>> };
  const r = runs.workflow_runs?.[0];
  return {
    repo: fullName,
    latestRun: r
      ? {
          id: r.id,
          name: r.name,
          status: r.status,
          conclusion: r.conclusion,
          branch: (r as { head_branch?: string }).head_branch,
          event: r.event,
          createdAt: r.created_at,
          url: r.html_url,
        }
      : undefined,
  };
}

// ---------------------------------------------------------------------------

export function registerInvestigate(server: McpServer, config: AppConfig): boolean {
  const { integrations } = config;

  server.registerTool(
    "devops_investigate",
    {
      title: "Investigate a service across integrations",
      description:
        "Cross-integration triage for one service: correlates signals from every ENABLED integration in a single call — Kubernetes pods/events/logs, firing Prometheus/Datadog alerts, the ArgoCD app's sync & health, and the most recent GitLab/GitHub CI run. Each source is gathered independently; a source that errors is reported under `errors` instead of failing the whole call. Only integrations that are configured are queried.",
      inputSchema: {
        service: z
          .string()
          .describe("Service name to investigate (matches pod names/labels, alert labels, ArgoCD app, CI project/repo)"),
        namespace: z.string().optional().describe("Kubernetes namespace to scope the search to"),
        sinceMinutes: z
          .number()
          .int()
          .min(1)
          .max(10080)
          .optional()
          .describe("How far back to look for events/alerts (default 60)"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("devops_investigate", async ({ service, namespace, sinceMinutes }) => {
      const since = sinceMinutes ?? 60;
      const gathered: Record<string, unknown> = {};
      const errors: Array<{ source: string; error: string }> = [];
      const fail = (source: string, err: unknown) =>
        errors.push({ source, error: err instanceof Error ? err.message : String(err) });

      if (integrations.kubernetes) {
        try {
          gathered.kubernetes = await gatherKubernetes(integrations.kubernetes, service, namespace, since);
        } catch (err) {
          fail("kubernetes", err);
        }
      }

      // Firing alerts from any enabled alerting backend.
      const alerts: Record<string, unknown> = {};
      if (integrations.prometheus) {
        try {
          alerts.prometheus = await gatherPrometheusAlerts(integrations.prometheus.instances[integrations.prometheus.primary], service);
        } catch (err) {
          fail("prometheus", err);
        }
      }
      if (integrations.datadog) {
        try {
          alerts.datadog = await gatherDatadogAlerts(integrations.datadog.instances[integrations.datadog.primary], service);
        } catch (err) {
          fail("datadog", err);
        }
      }
      if (Object.keys(alerts).length > 0) gathered.alerts = alerts;

      if (integrations.argocd) {
        try {
          gathered.argocd = await gatherArgoCD(integrations.argocd.instances[integrations.argocd.primary], service);
        } catch (err) {
          fail("argocd", err);
        }
      }

      // Most recent CI run from any enabled CI backend.
      const ci: Record<string, unknown> = {};
      if (integrations.gitlab) {
        try {
          ci.gitlab = await gatherGitlabCI(integrations.gitlab.instances[integrations.gitlab.primary], service);
        } catch (err) {
          fail("gitlab", err);
        }
      }
      if (integrations.github) {
        try {
          ci.github = await gatherGithubCI(integrations.github.instances[integrations.github.primary], service);
        } catch (err) {
          fail("github", err);
        }
      }
      if (Object.keys(ci).length > 0) gathered.ci = ci;

      return jsonResult({
        service,
        namespace,
        sinceMinutes: since,
        queried: Object.keys(integrations).filter((k) =>
          ["kubernetes", "prometheus", "datadog", "argocd", "gitlab", "github"].includes(k),
        ),
        gathered,
        errors,
      });
    }),
  );

  return true;
}
