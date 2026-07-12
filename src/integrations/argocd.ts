import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig, ArgoCDConfig } from "../config.js";
import { httpRequest, jsonResult, qs, safe } from "../util.js";

function api(cfg: ArgoCDConfig, path: string, opts: Parameters<typeof httpRequest>[1] = {}) {
  return httpRequest(`${cfg.url}${path}`, {
    ...opts,
    headers: { authorization: `Bearer ${cfg.token}`, ...(opts.headers ?? {}) },
  });
}

interface ArgoApp {
  metadata?: { name?: string };
  spec?: { project?: string; source?: { repoURL?: string; targetRevision?: string; path?: string }; destination?: unknown };
  status?: {
    sync?: { status?: string; revision?: string };
    health?: { status?: string; message?: string };
    operationState?: { phase?: string; message?: string; finishedAt?: string };
    history?: unknown[];
  };
}

export function registerArgoCD(server: McpServer, config: AppConfig): boolean {
  const cfg = config.integrations.argocd;
  if (!cfg) return false;

  server.registerTool(
    "argocd_list_applications",
    {
      title: "List ArgoCD applications",
      description: "Lists applications with sync status, health, project and target revision.",
      inputSchema: {
        search: z.string().optional().describe("Name filter"),
        project: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("argocd_list_applications", async ({ search, project }) => {
      const res = (await api(cfg, `/api/v1/applications${qs({ search, projects: project })}`)) as {
        items?: ArgoApp[];
      };
      return jsonResult(
        (res.items ?? []).slice(0, 200).map((a) => ({
          name: a.metadata?.name,
          project: a.spec?.project,
          syncStatus: a.status?.sync?.status,
          health: a.status?.health?.status,
          revision: a.status?.sync?.revision?.slice(0, 10),
          repo: a.spec?.source?.repoURL,
          targetRevision: a.spec?.source?.targetRevision,
        })),
      );
    }),
  );

  server.registerTool(
    "argocd_get_application",
    {
      title: "Get ArgoCD application",
      description: "Full detail for one application: sync/health status, last operation, source and destination.",
      inputSchema: {
        name: z.string(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("argocd_get_application", async ({ name }) => {
      const a = (await api(cfg, `/api/v1/applications/${encodeURIComponent(name)}`)) as ArgoApp;
      return jsonResult({
        name: a.metadata?.name,
        project: a.spec?.project,
        source: a.spec?.source,
        destination: a.spec?.destination,
        sync: a.status?.sync,
        health: a.status?.health,
        lastOperation: a.status?.operationState
          ? {
              phase: a.status.operationState.phase,
              message: a.status.operationState.message,
              finishedAt: a.status.operationState.finishedAt,
            }
          : undefined,
      });
    }),
  );

  server.registerTool(
    "argocd_app_resources",
    {
      title: "ArgoCD application resource tree",
      description: "Lists the Kubernetes resources managed by an application with per-resource health.",
      inputSchema: {
        name: z.string(),
        onlyUnhealthy: z.boolean().optional().describe("Only resources that are not Healthy"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("argocd_app_resources", async ({ name, onlyUnhealthy }) => {
      const res = (await api(cfg, `/api/v1/applications/${encodeURIComponent(name)}/resource-tree`)) as {
        nodes?: Array<{
          kind?: string;
          name?: string;
          namespace?: string;
          health?: { status?: string; message?: string };
          version?: string;
        }>;
      };
      let nodes = res.nodes ?? [];
      if (onlyUnhealthy) {
        nodes = nodes.filter((n) => n.health && n.health.status !== "Healthy");
      }
      return jsonResult(
        nodes.slice(0, 300).map((n) => ({
          kind: n.kind,
          name: n.name,
          namespace: n.namespace,
          health: n.health?.status,
          message: n.health?.message,
        })),
      );
    }),
  );

  server.registerTool(
    "argocd_app_history",
    {
      title: "ArgoCD deployment history",
      description: "Lists recent deployment history (revisions) for an application.",
      inputSchema: {
        name: z.string(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("argocd_app_history", async ({ name }) => {
      const a = (await api(cfg, `/api/v1/applications/${encodeURIComponent(name)}`)) as ArgoApp;
      const history = (a.status?.history ?? []) as Array<Record<string, unknown>>;
      return jsonResult(
        history
          .slice(-20)
          .reverse()
          .map((h) => ({
            id: h.id,
            revision: typeof h.revision === "string" ? h.revision.slice(0, 10) : h.revision,
            deployedAt: h.deployedAt,
            deployStartedAt: h.deployStartedAt,
          })),
      );
    }),
  );

  if (config.allowWrites) {
    server.registerTool(
      "argocd_sync_application",
      {
        title: "Sync ArgoCD application (write)",
        description: "Triggers a sync (deploy) of an application. Supports dry-run. Enabled because MCP_ALLOW_WRITES=true.",
        inputSchema: {
          name: z.string(),
          revision: z.string().optional().describe("Git revision to sync to (default: configured target)"),
          prune: z.boolean().optional().describe("Prune resources no longer in git"),
          dryRun: z.boolean().optional(),
        },
        annotations: { destructiveHint: true },
      },
      safe("argocd_sync_application", async ({ name, revision, prune, dryRun }) =>
        jsonResult(
          await api(cfg, `/api/v1/applications/${encodeURIComponent(name)}/sync`, {
            method: "POST",
            body: { revision, prune: prune ?? false, dryRun: dryRun ?? false },
          }),
        ),
      ),
    );
  }

  return true;
}
