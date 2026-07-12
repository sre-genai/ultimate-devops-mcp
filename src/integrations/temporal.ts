import { readFileSync } from "node:fs";
import { Client, Connection, type ConnectionOptions } from "@temporalio/client";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig, TemporalConfig } from "../config.js";
import { jsonResult, registerCloser, safe } from "../util.js";

let client: Client | undefined;
let connecting: Promise<Client> | undefined;

async function getClient(cfg: TemporalConfig): Promise<Client> {
  if (client) return client;
  if (!connecting) {
    connecting = (async () => {
      const options: ConnectionOptions = { address: cfg.address };
      if (cfg.apiKey) {
        // Temporal Cloud: API-key auth over TLS.
        options.apiKey = cfg.apiKey;
        options.tls = true;
      } else if (cfg.tlsCert && cfg.tlsKey) {
        // Self-hosted mTLS.
        options.tls = {
          clientCertPair: {
            crt: readFileSync(cfg.tlsCert),
            key: readFileSync(cfg.tlsKey),
          },
          ...(cfg.tlsCA ? { serverRootCACertificate: readFileSync(cfg.tlsCA) } : {}),
          ...(cfg.serverName ? { serverNameOverride: cfg.serverName } : {}),
        };
      } else if (cfg.tls) {
        options.tls = true;
      }
      const connection = await Connection.connect(options);
      client = new Client({ connection, namespace: cfg.namespace });
      registerCloser("temporal", async () => {
        await connection.close();
        client = undefined;
        connecting = undefined;
      });
      return client;
    })().catch((err) => {
      connecting = undefined;
      throw err;
    });
  }
  return connecting;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

export function registerTemporal(server: McpServer, config: AppConfig): boolean {
  const cfg = config.integrations.temporal;
  if (!cfg) return false;

  server.registerTool(
    "temporal_list_workflows",
    {
      title: "List Temporal workflow executions",
      description:
        'Lists workflow executions, optionally filtered with a Temporal List Filter query, e.g. `WorkflowType=\'MyWorkflow\' AND ExecutionStatus=\'Failed\'` or `StartTime > \'2026-01-01T00:00:00Z\'`.',
      inputSchema: {
        query: z.string().optional().describe("Temporal List Filter (SQL-like)"),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Max executions (default ${DEFAULT_LIMIT})`),
      },
      annotations: { readOnlyHint: true },
    },
    safe("temporal_list_workflows", async ({ query, limit }) => {
      const c = await getClient(cfg);
      const max = limit ?? DEFAULT_LIMIT;
      const rows: Array<Record<string, unknown>> = [];
      for await (const wf of c.workflow.list({ query })) {
        rows.push({
          workflowId: wf.workflowId,
          runId: wf.runId,
          type: wf.type,
          status: wf.status.name,
          taskQueue: wf.taskQueue,
          startTime: wf.startTime,
          closeTime: wf.closeTime,
          historyLength: Number(wf.historyLength),
        });
        if (rows.length >= max) break;
      }
      return jsonResult({ namespace: cfg.namespace, count: rows.length, workflows: rows });
    }),
  );

  server.registerTool(
    "temporal_describe_workflow",
    {
      title: "Describe a Temporal workflow execution",
      description: "Full detail for one execution: status, task queue, timings, pending activities, parent, search attributes.",
      inputSchema: {
        workflowId: z.string(),
        runId: z.string().optional().describe("Specific run (default: latest)"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("temporal_describe_workflow", async ({ workflowId, runId }) => {
      const c = await getClient(cfg);
      const desc = await c.workflow.getHandle(workflowId, runId).describe();
      return jsonResult({
        workflowId: desc.workflowId,
        runId: desc.runId,
        type: desc.type,
        status: desc.status.name,
        taskQueue: desc.taskQueue,
        startTime: desc.startTime,
        closeTime: desc.closeTime,
        executionTime: desc.executionTime,
        historyLength: Number(desc.historyLength),
        parentExecution: desc.parentExecution,
        pendingActivities: desc.raw?.pendingActivities?.length ?? 0,
        searchAttributes: desc.searchAttributes,
        memo: desc.memo,
      });
    }),
  );

  server.registerTool(
    "temporal_workflow_history",
    {
      title: "Get Temporal workflow event history",
      description:
        "Returns the event history (type + time per event) for a workflow execution — use to see where a workflow is stuck or what failed.",
      inputSchema: {
        workflowId: z.string(),
        runId: z.string().optional(),
        limit: z.number().int().min(1).max(1000).optional().describe("Max events from the start (default 200)"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("temporal_workflow_history", async ({ workflowId, runId, limit }) => {
      const c = await getClient(cfg);
      const history = await c.workflow.getHandle(workflowId, runId).fetchHistory();
      const events = (history.events ?? []).slice(0, limit ?? 200).map((e) => ({
        eventId: Number(e.eventId),
        eventType: e.eventType,
        eventTime: e.eventTime,
      }));
      return jsonResult({ workflowId, returned: events.length, events });
    }),
  );

  server.registerTool(
    "temporal_count_workflows",
    {
      title: "Count Temporal workflow executions",
      description: "Counts executions matching a List Filter query (cheap — does not fetch them).",
      inputSchema: {
        query: z.string().optional().describe("Temporal List Filter"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("temporal_count_workflows", async ({ query }) => {
      const c = await getClient(cfg);
      const res = await c.workflowService.countWorkflowExecutions({
        namespace: cfg.namespace,
        query: query ?? "",
      });
      return jsonResult({ namespace: cfg.namespace, count: Number(res.count) });
    }),
  );

  server.registerTool(
    "temporal_list_namespaces",
    {
      title: "List Temporal namespaces",
      description: "Lists namespaces registered on the Temporal cluster.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safe("temporal_list_namespaces", async () => {
      const c = await getClient(cfg);
      const res = await c.workflowService.listNamespaces({});
      return jsonResult(
        (res.namespaces ?? []).map((n) => ({
          name: n.namespaceInfo?.name,
          state: n.namespaceInfo?.state,
          description: n.namespaceInfo?.description,
        })),
      );
    }),
  );

  if (config.allowWrites) {
    server.registerTool(
      "temporal_signal_workflow",
      {
        title: "Signal a Temporal workflow (write)",
        description: "Sends a signal to a running workflow. Enabled because MCP_ALLOW_WRITES=true.",
        inputSchema: {
          workflowId: z.string(),
          runId: z.string().optional(),
          signalName: z.string(),
          args: z.array(z.unknown()).optional().describe("Signal arguments"),
        },
        annotations: { destructiveHint: true },
      },
      safe("temporal_signal_workflow", async ({ workflowId, runId, signalName, args }) => {
        const c = await getClient(cfg);
        await c.workflow.getHandle(workflowId, runId).signal(signalName, ...(args ?? []));
        return jsonResult({ signaled: workflowId, signalName });
      }),
    );

    server.registerTool(
      "temporal_terminate_workflow",
      {
        title: "Terminate a Temporal workflow (write)",
        description: "Terminates a running workflow (no cleanup/compensation runs). Enabled because MCP_ALLOW_WRITES=true.",
        inputSchema: {
          workflowId: z.string(),
          runId: z.string().optional(),
          reason: z.string().optional(),
        },
        annotations: { destructiveHint: true },
      },
      safe("temporal_terminate_workflow", async ({ workflowId, runId, reason }) => {
        const c = await getClient(cfg);
        await c.workflow.getHandle(workflowId, runId).terminate(reason);
        return jsonResult({ terminated: workflowId, reason });
      }),
    );

    server.registerTool(
      "temporal_cancel_workflow",
      {
        title: "Cancel a Temporal workflow (write)",
        description: "Requests cancellation of a running workflow (cooperative; cleanup can run). Enabled because MCP_ALLOW_WRITES=true.",
        inputSchema: {
          workflowId: z.string(),
          runId: z.string().optional(),
        },
        annotations: { destructiveHint: true },
      },
      safe("temporal_cancel_workflow", async ({ workflowId, runId }) => {
        const c = await getClient(cfg);
        await c.workflow.getHandle(workflowId, runId).cancel();
        return jsonResult({ canceled: workflowId });
      }),
    );
  }

  return true;
}
