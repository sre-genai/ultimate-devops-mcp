import { gunzipSync } from "node:zlib";
import * as k8s from "@kubernetes/client-node";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig, HelmConfig } from "../config.js";
import { jsonResult, safe, textResult } from "../util.js";

let core: k8s.CoreV1Api | undefined;
function getCore(cfg: HelmConfig): k8s.CoreV1Api {
  if (!core) {
    const kc = new k8s.KubeConfig();
    if (cfg.kubeconfigPath) kc.loadFromFile(cfg.kubeconfigPath);
    else kc.loadFromDefault();
    core = kc.makeApiClient(k8s.CoreV1Api);
  }
  return core;
}

// Helm 3 stores each release revision as a Secret (type helm.sh/release.v1) whose
// `release` field is base64(gzip(JSON)); the k8s API base64-encodes it once more.
// Decode both layers, then gunzip. Falls back gracefully if only single-encoded.
export function decodeRelease(raw: string): Record<string, unknown> {
  let buf = Buffer.from(raw, "base64");
  if (!(buf[0] === 0x1f && buf[1] === 0x8b)) {
    buf = Buffer.from(buf.toString("utf8"), "base64");
  }
  const gz = buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf;
  return JSON.parse(gz.toString("utf8"));
}

const HELM_SELECTOR = "owner=helm";

interface RevMeta {
  release: string;
  namespace?: string;
  revision: number;
  status?: string;
  updated?: string | Date;
  secret: string;
}
function metaOf(s: k8s.V1Secret): RevMeta {
  const l = s.metadata?.labels ?? {};
  return {
    release: l.name ?? "",
    namespace: s.metadata?.namespace,
    revision: Number(l.version ?? 0),
    status: l.status,
    updated: s.metadata?.creationTimestamp,
    secret: s.metadata?.name ?? "",
  };
}

export function registerHelm(server: McpServer, config: AppConfig): boolean {
  const cfg = config.integrations.helm;
  if (!cfg) return false;

  server.registerTool(
    "helm_list_releases",
    {
      title: "List Helm releases",
      description:
        "Lists Helm 3 releases (latest revision each) across the cluster or one namespace, read from their release Secrets.",
      inputSchema: { namespace: z.string().optional().describe("Limit to one namespace (default: all)") },
      annotations: { readOnlyHint: true },
    },
    safe("helm_list_releases", async ({ namespace }) => {
      const c = getCore(cfg);
      const list = namespace
        ? await c.listNamespacedSecret({ namespace, labelSelector: HELM_SELECTOR })
        : await c.listSecretForAllNamespaces({ labelSelector: HELM_SELECTOR });
      // Keep only the highest revision per (namespace, release).
      const latest = new Map<string, RevMeta>();
      for (const s of list.items) {
        const m = metaOf(s);
        const key = `${m.namespace}/${m.release}`;
        const prev = latest.get(key);
        if (!prev || m.revision > prev.revision) latest.set(key, m);
      }
      return jsonResult(
        [...latest.values()]
          .sort((a, b) => `${a.namespace}/${a.release}`.localeCompare(`${b.namespace}/${b.release}`))
          .map(({ release, namespace: ns, revision, status, updated }) => ({ release, namespace: ns, revision, status, updated })),
      );
    }),
  );

  server.registerTool(
    "helm_get_release",
    {
      title: "Get Helm release detail",
      description:
        "Detail of one release: summary (chart, status, dates), user-supplied values, rendered manifest, or release notes.",
      inputSchema: {
        name: z.string().describe("Release name"),
        namespace: z.string().optional().describe("Release namespace (default: default)"),
        revision: z.number().int().min(1).optional().describe("Specific revision (default: latest)"),
        include: z.enum(["summary", "values", "manifest", "notes"]).optional().describe('What to return (default "summary")'),
      },
      annotations: { readOnlyHint: true },
    },
    safe("helm_get_release", async ({ name, namespace, revision, include }) => {
      const c = getCore(cfg);
      const ns = namespace ?? "default";
      let secretName: string;
      if (revision) {
        secretName = `sh.helm.release.v1.${name}.v${revision}`;
      } else {
        const list = await c.listNamespacedSecret({ namespace: ns, labelSelector: `${HELM_SELECTOR},name=${name}` });
        if (list.items.length === 0) throw new Error(`No Helm release "${name}" in namespace "${ns}"`);
        secretName = list.items.map(metaOf).sort((a, b) => b.revision - a.revision)[0].secret;
      }
      const secret = await c.readNamespacedSecret({ name: secretName, namespace: ns });
      const raw = secret.data?.release;
      if (!raw) throw new Error(`Secret ${ns}/${secretName} has no release data`);
      const rel = decodeRelease(raw) as {
        name?: string;
        version?: number;
        info?: { status?: string; first_deployed?: string; last_deployed?: string; description?: string; notes?: string };
        chart?: { metadata?: { name?: string; version?: string; appVersion?: string } };
        config?: unknown;
        manifest?: string;
      };
      const what = include ?? "summary";
      if (what === "values") return jsonResult({ release: name, namespace: ns, revision: rel.version, values: rel.config ?? {} });
      if (what === "manifest") return textResult(rel.manifest ?? "(no manifest)");
      if (what === "notes") return textResult(rel.info?.notes ?? "(no notes)");
      return jsonResult({
        release: rel.name ?? name,
        namespace: ns,
        revision: rel.version,
        status: rel.info?.status,
        chart: rel.chart?.metadata?.name,
        chartVersion: rel.chart?.metadata?.version,
        appVersion: rel.chart?.metadata?.appVersion,
        firstDeployed: rel.info?.first_deployed,
        lastDeployed: rel.info?.last_deployed,
        description: rel.info?.description,
      });
    }),
  );

  server.registerTool(
    "helm_history",
    {
      title: "Helm release history",
      description: "Revision history of a release: revision, status, chart, app version and description.",
      inputSchema: {
        name: z.string().describe("Release name"),
        namespace: z.string().optional().describe("Release namespace (default: default)"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("helm_history", async ({ name, namespace }) => {
      const c = getCore(cfg);
      const ns = namespace ?? "default";
      const list = await c.listNamespacedSecret({ namespace: ns, labelSelector: `${HELM_SELECTOR},name=${name}` });
      if (list.items.length === 0) throw new Error(`No Helm release "${name}" in namespace "${ns}"`);
      const rows = list.items
        .sort((a, b) => metaOf(b).revision - metaOf(a).revision)
        .map((s) => {
          const m = metaOf(s);
          let chart: string | undefined;
          let appVersion: string | undefined;
          let description: string | undefined;
          try {
            const rel = decodeRelease(s.data?.release ?? "") as {
              chart?: { metadata?: { name?: string; version?: string; appVersion?: string } };
              info?: { description?: string };
            };
            chart = rel.chart?.metadata ? `${rel.chart.metadata.name}-${rel.chart.metadata.version}` : undefined;
            appVersion = rel.chart?.metadata?.appVersion;
            description = rel.info?.description;
          } catch {
            /* label-only fallback below */
          }
          return { revision: m.revision, status: m.status, updated: m.updated, chart, appVersion, description };
        });
      return jsonResult(rows);
    }),
  );

  return true;
}
