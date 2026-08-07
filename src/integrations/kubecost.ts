import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig, KubecostConfig } from "../config.js";
import { httpRequest, jsonResult, qs, safe } from "../util.js";

function api(cfg: KubecostConfig, path: string) {
  return httpRequest(`${cfg.url}${path}`, {
    headers: cfg.token ? { authorization: `Bearer ${cfg.token}` } : {},
  });
}

// Kubecost is read-only here: it reports cost, it doesn't change anything.
export function registerKubecost(server: McpServer, config: AppConfig): boolean {
  const cfg = config.integrations.kubecost;
  if (!cfg) return false;

  server.registerTool(
    "kubecost_allocation",
    {
      title: "Kubecost allocation (workload cost)",
      description:
        "Kubernetes cost broken down by an aggregation (namespace, controller, pod, node, or a label like `label:app`). " +
        "Returns CPU/RAM/PV/network/total cost per group over the window.",
      inputSchema: {
        window: z
          .string()
          .optional()
          .describe('Time window, e.g. "today", "24h", "7d", "month" (default "7d")'),
        aggregate: z
          .string()
          .optional()
          .describe('Grouping: namespace | controller | pod | node | cluster | label:<key> (default "namespace")'),
        accumulate: z.boolean().optional().describe("Sum the window into one set instead of per-day (default true)"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("kubecost_allocation", async ({ window, aggregate, accumulate }) => {
      const res = (await api(
        cfg,
        `/model/allocation${qs({
          window: window ?? "7d",
          aggregate: aggregate ?? "namespace",
          accumulate: accumulate ?? true,
        })}`,
      )) as { data?: unknown };
      return jsonResult({ window: window ?? "7d", aggregate: aggregate ?? "namespace", data: res?.data ?? res });
    }),
  );

  server.registerTool(
    "kubecost_assets",
    {
      title: "Kubecost assets (cloud cost)",
      description:
        "Cloud infrastructure cost (nodes, disks, load balancers, …) aggregated by type or provider over the window.",
      inputSchema: {
        window: z.string().optional().describe('Time window (default "7d")'),
        aggregate: z.string().optional().describe('Grouping: type | provider | service | cluster (default "type")'),
      },
      annotations: { readOnlyHint: true },
    },
    safe("kubecost_assets", async ({ window, aggregate }) => {
      const res = (await api(
        cfg,
        `/model/assets${qs({ window: window ?? "7d", aggregate: aggregate ?? "type", accumulate: true })}`,
      )) as { data?: unknown };
      return jsonResult({ window: window ?? "7d", aggregate: aggregate ?? "type", data: res?.data ?? res });
    }),
  );

  return true;
}
