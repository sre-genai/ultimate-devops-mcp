import * as k8s from "@kubernetes/client-node";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig, KubernetesConfig } from "../config.js";
import { jsonResult, safe, textResult } from "../util.js";

interface K8sClients {
  core: k8s.CoreV1Api;
  apps: k8s.AppsV1Api;
}

let clients: K8sClients | undefined;

function getClients(cfg: KubernetesConfig): K8sClients {
  if (!clients) {
    const kc = new k8s.KubeConfig();
    if (cfg.kubeconfigPath) {
      kc.loadFromFile(cfg.kubeconfigPath);
    } else {
      kc.loadFromDefault();
    }
    clients = {
      core: kc.makeApiClient(k8s.CoreV1Api),
      apps: kc.makeApiClient(k8s.AppsV1Api),
    };
  }
  return clients;
}

function age(timestamp?: Date): string {
  if (!timestamp) return "unknown";
  const ms = Date.now() - new Date(timestamp).getTime();
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}

function stripManagedFields(obj: unknown): unknown {
  if (obj && typeof obj === "object" && "metadata" in obj) {
    const meta = (obj as { metadata?: { managedFields?: unknown } }).metadata;
    if (meta) delete meta.managedFields;
  }
  return obj;
}

const KIND = z.enum(["pods", "deployments", "services", "nodes", "namespaces"]);

export function registerKubernetes(server: McpServer, config: AppConfig): boolean {
  const cfg = config.integrations.kubernetes;
  if (!cfg) return false;

  server.registerTool(
    "k8s_list",
    {
      title: "List Kubernetes resources",
      description:
        "Lists pods, deployments, services, nodes or namespaces with a status summary. Omit namespace to list across all namespaces.",
      inputSchema: {
        kind: KIND,
        namespace: z.string().optional(),
        labelSelector: z.string().optional().describe('e.g. "app=api,env=prod"'),
      },
      annotations: { readOnlyHint: true },
    },
    safe("k8s_list", async ({ kind, namespace, labelSelector }) => {
      const { core, apps } = getClients(cfg);
      switch (kind) {
        case "pods": {
          const list = namespace
            ? await core.listNamespacedPod({ namespace, labelSelector })
            : await core.listPodForAllNamespaces({ labelSelector });
          return jsonResult(
            list.items.slice(0, 200).map((p) => ({
              namespace: p.metadata?.namespace,
              name: p.metadata?.name,
              phase: p.status?.phase,
              ready: `${p.status?.containerStatuses?.filter((c) => c.ready).length ?? 0}/${p.spec?.containers.length ?? 0}`,
              restarts: p.status?.containerStatuses?.reduce((n, c) => n + c.restartCount, 0) ?? 0,
              node: p.spec?.nodeName,
              age: age(p.metadata?.creationTimestamp),
            })),
          );
        }
        case "deployments": {
          const list = namespace
            ? await apps.listNamespacedDeployment({ namespace, labelSelector })
            : await apps.listDeploymentForAllNamespaces({ labelSelector });
          return jsonResult(
            list.items.slice(0, 200).map((d) => ({
              namespace: d.metadata?.namespace,
              name: d.metadata?.name,
              ready: `${d.status?.readyReplicas ?? 0}/${d.spec?.replicas ?? 0}`,
              upToDate: d.status?.updatedReplicas ?? 0,
              available: d.status?.availableReplicas ?? 0,
              age: age(d.metadata?.creationTimestamp),
            })),
          );
        }
        case "services": {
          const list = namespace
            ? await core.listNamespacedService({ namespace, labelSelector })
            : await core.listServiceForAllNamespaces({ labelSelector });
          return jsonResult(
            list.items.slice(0, 200).map((s) => ({
              namespace: s.metadata?.namespace,
              name: s.metadata?.name,
              type: s.spec?.type,
              clusterIP: s.spec?.clusterIP,
              ports: s.spec?.ports?.map((p) => `${p.port}${p.nodePort ? `:${p.nodePort}` : ""}/${p.protocol}`),
              age: age(s.metadata?.creationTimestamp),
            })),
          );
        }
        case "nodes": {
          const list = await core.listNode({ labelSelector });
          return jsonResult(
            list.items.map((n) => ({
              name: n.metadata?.name,
              ready: n.status?.conditions?.find((c) => c.type === "Ready")?.status,
              version: n.status?.nodeInfo?.kubeletVersion,
              cpu: n.status?.capacity?.cpu,
              memory: n.status?.capacity?.memory,
              age: age(n.metadata?.creationTimestamp),
            })),
          );
        }
        case "namespaces": {
          const list = await core.listNamespace({ labelSelector });
          return jsonResult(
            list.items.map((ns) => ({
              name: ns.metadata?.name,
              status: ns.status?.phase,
              age: age(ns.metadata?.creationTimestamp),
            })),
          );
        }
      }
    }),
  );

  server.registerTool(
    "k8s_get",
    {
      title: "Get Kubernetes resource",
      description: "Returns the full manifest of a single resource (managedFields stripped).",
      inputSchema: {
        kind: KIND,
        name: z.string(),
        namespace: z.string().optional().describe("Required for namespaced kinds"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("k8s_get", async ({ kind, name, namespace }) => {
      const { core, apps } = getClients(cfg);
      const ns = namespace ?? "default";
      let obj: unknown;
      switch (kind) {
        case "pods":
          obj = await core.readNamespacedPod({ name, namespace: ns });
          break;
        case "deployments":
          obj = await apps.readNamespacedDeployment({ name, namespace: ns });
          break;
        case "services":
          obj = await core.readNamespacedService({ name, namespace: ns });
          break;
        case "nodes":
          obj = await core.readNode({ name });
          break;
        case "namespaces":
          obj = await core.readNamespace({ name });
          break;
      }
      return jsonResult(stripManagedFields(obj));
    }),
  );

  server.registerTool(
    "k8s_pod_logs",
    {
      title: "Get pod logs",
      description: "Fetches container logs from a pod (tail).",
      inputSchema: {
        name: z.string().describe("Pod name"),
        namespace: z.string().optional(),
        container: z.string().optional().describe("Container name (needed for multi-container pods)"),
        tailLines: z.number().int().min(1).max(2000).optional().describe("Lines from the end (default 200)"),
        previous: z.boolean().optional().describe("Logs from the previous (crashed) container instance"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("k8s_pod_logs", async ({ name, namespace, container, tailLines, previous }) => {
      const { core } = getClients(cfg);
      const log = await core.readNamespacedPodLog({
        name,
        namespace: namespace ?? "default",
        container,
        tailLines: tailLines ?? 200,
        previous,
        timestamps: true,
      });
      return textResult(log || "(no log output)");
    }),
  );

  server.registerTool(
    "k8s_events",
    {
      title: "List Kubernetes events",
      description: "Recent cluster events (warnings first), useful for debugging scheduling/crash issues.",
      inputSchema: {
        namespace: z.string().optional(),
        onlyWarnings: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("k8s_events", async ({ namespace, onlyWarnings }) => {
      const { core } = getClients(cfg);
      const fieldSelector = onlyWarnings ? "type=Warning" : undefined;
      const list = namespace
        ? await core.listNamespacedEvent({ namespace, fieldSelector })
        : await core.listEventForAllNamespaces({ fieldSelector });
      const events = list.items
        .sort(
          (a, b) =>
            new Date(b.lastTimestamp ?? b.eventTime ?? 0).getTime() -
            new Date(a.lastTimestamp ?? a.eventTime ?? 0).getTime(),
        )
        .slice(0, 50)
        .map((e) => ({
          namespace: e.metadata?.namespace,
          type: e.type,
          reason: e.reason,
          object: `${e.involvedObject?.kind}/${e.involvedObject?.name}`,
          message: e.message,
          count: e.count,
          lastSeen: e.lastTimestamp ?? e.eventTime,
        }));
      return jsonResult(events);
    }),
  );

  if (config.allowWrites) {
    server.registerTool(
      "k8s_scale",
      {
        title: "Scale deployment (write)",
        description: "Sets replica count on a deployment. Enabled because MCP_ALLOW_WRITES=true.",
        inputSchema: {
          deployment: z.string(),
          namespace: z.string().optional(),
          replicas: z.number().int().min(0).max(500),
        },
        annotations: { destructiveHint: true },
      },
      safe("k8s_scale", async ({ deployment, namespace, replicas }) => {
        const { apps } = getClients(cfg);
        const ns = namespace ?? "default";
        const scale = await apps.readNamespacedDeploymentScale({ name: deployment, namespace: ns });
        const previous = scale.spec?.replicas;
        scale.spec = { ...scale.spec, replicas };
        await apps.replaceNamespacedDeploymentScale({ name: deployment, namespace: ns, body: scale });
        return jsonResult({ deployment, namespace: ns, previousReplicas: previous, replicas });
      }),
    );

    server.registerTool(
      "k8s_rollout_restart",
      {
        title: "Rollout restart deployment (write)",
        description:
          "Triggers a rolling restart by stamping the pod template annotation (same as `kubectl rollout restart`). Enabled because MCP_ALLOW_WRITES=true.",
        inputSchema: {
          deployment: z.string(),
          namespace: z.string().optional(),
        },
        annotations: { destructiveHint: true },
      },
      safe("k8s_rollout_restart", async ({ deployment, namespace }) => {
        const { apps } = getClients(cfg);
        const ns = namespace ?? "default";
        const dep = await apps.readNamespacedDeployment({ name: deployment, namespace: ns });
        if (!dep.spec) throw new Error(`Deployment ${ns}/${deployment} has no spec`);
        dep.spec.template.metadata = dep.spec.template.metadata ?? {};
        dep.spec.template.metadata.annotations = {
          ...dep.spec.template.metadata.annotations,
          "kubectl.kubernetes.io/restartedAt": new Date().toISOString(),
        };
        await apps.replaceNamespacedDeployment({ name: deployment, namespace: ns, body: dep });
        return jsonResult({ deployment, namespace: ns, restartedAt: dep.spec.template.metadata.annotations["kubectl.kubernetes.io/restartedAt"] });
      }),
    );

    server.registerTool(
      "k8s_delete_pod",
      {
        title: "Delete pod (write)",
        description: "Deletes a pod (its controller will recreate it). Enabled because MCP_ALLOW_WRITES=true.",
        inputSchema: {
          name: z.string(),
          namespace: z.string().optional(),
        },
        annotations: { destructiveHint: true },
      },
      safe("k8s_delete_pod", async ({ name, namespace }) => {
        const { core } = getClients(cfg);
        const ns = namespace ?? "default";
        await core.deleteNamespacedPod({ name, namespace: ns });
        return jsonResult({ deleted: `${ns}/${name}` });
      }),
    );
  }

  return true;
}
