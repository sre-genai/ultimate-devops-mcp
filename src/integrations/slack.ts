import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig, SlackConfig } from "../config.js";
import { httpRequest, jsonResult, qs, safe } from "../util.js";

type Obj = Record<string, unknown>;

/** Slack Web API returns HTTP 200 with `{ ok: false, error }` on failure. */
async function api(cfg: SlackConfig, path: string, opts: Parameters<typeof httpRequest>[1] = {}) {
  const res = (await httpRequest(`https://slack.com/api${path}`, {
    ...opts,
    headers: { authorization: `Bearer ${cfg.botToken}`, ...(opts.headers ?? {}) },
  })) as Obj;
  if (res && res.ok === false) {
    throw new Error(`Slack API error: ${String(res.error ?? "unknown")}`);
  }
  return res;
}

export function registerSlack(server: McpServer, config: AppConfig): boolean {
  const cfg = config.integrations.slack;
  if (!cfg) return false;

  server.registerTool(
    "slack_list_channels",
    {
      title: "List Slack channels",
      description: "Lists channels the workspace exposes (public by default).",
      inputSchema: {
        types: z
          .string()
          .optional()
          .describe('Comma-separated channel types (default "public_channel")'),
        limit: z.number().int().min(1).max(1000).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("slack_list_channels", async ({ types, limit }) => {
      const res = (await api(
        cfg,
        `/conversations.list${qs({ types: types ?? "public_channel", limit: limit ?? 100 })}`,
      )) as { channels?: Obj[] };
      return jsonResult(
        (res.channels ?? []).map((c) => ({
          id: c.id,
          name: c.name,
          isPrivate: (c as { is_private?: boolean }).is_private,
          isArchived: (c as { is_archived?: boolean }).is_archived,
          numMembers: (c as { num_members?: number }).num_members,
          topic: (c as { topic?: { value?: string } }).topic?.value,
        })),
      );
    }),
  );

  server.registerTool(
    "slack_get_channel_history",
    {
      title: "Get Slack channel history",
      description: "Returns recent messages in a channel (most recent first).",
      inputSchema: {
        channel: z.string().describe("Channel ID (from slack_list_channels)"),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("slack_get_channel_history", async ({ channel, limit }) => {
      const res = (await api(cfg, `/conversations.history${qs({ channel, limit: limit ?? 50 })}`)) as {
        messages?: Obj[];
      };
      return jsonResult(
        (res.messages ?? []).map((m) => ({
          ts: m.ts,
          user: m.user,
          type: m.type,
          subtype: m.subtype,
          text: String(m.text ?? "").slice(0, 2000),
          threadTs: (m as { thread_ts?: string }).thread_ts,
          replyCount: (m as { reply_count?: number }).reply_count,
        })),
      );
    }),
  );

  server.registerTool(
    "slack_search",
    {
      title: "Search Slack messages",
      description:
        "Searches messages with Slack search syntax. Requires a user token with search:read (bot tokens cannot search).",
      inputSchema: {
        query: z.string().describe('Search query, e.g. "in:#incidents deploy failed"'),
        count: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("slack_search", async ({ query, count }) => {
      const res = (await api(cfg, `/search.messages${qs({ query, count: count ?? 20 })}`)) as {
        messages?: { total?: number; matches?: Obj[] };
      };
      return jsonResult({
        total: res.messages?.total,
        matches: (res.messages?.matches ?? []).map((m) => ({
          ts: m.ts,
          channel: (m as { channel?: { id?: string; name?: string } }).channel,
          username: m.username,
          text: String(m.text ?? "").slice(0, 2000),
          permalink: m.permalink,
        })),
      });
    }),
  );

  if (config.allowWrites) {
    server.registerTool(
      "slack_post_message",
      {
        title: "Post a Slack message (write)",
        description:
          "Posts a message to a channel. Enabled because MCP_ALLOW_WRITES=true.",
        inputSchema: {
          channel: z.string().describe("Channel ID or name"),
          text: z.string().describe("Message text"),
          threadTs: z.string().optional().describe("Reply in this thread (parent ts)"),
        },
        annotations: { destructiveHint: false },
      },
      safe("slack_post_message", async ({ channel, text, threadTs }) => {
        const res = (await api(cfg, "/chat.postMessage", {
          method: "POST",
          body: { channel, text, thread_ts: threadTs },
        })) as Obj;
        return jsonResult({ ok: res.ok, channel: res.channel, ts: res.ts });
      }),
    );
  }

  return true;
}
