import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig, VaultConfig } from "../config.js";
import { httpRequest, jsonResult, qs, safe } from "../util.js";

function api(cfg: VaultConfig, path: string, opts: Parameters<typeof httpRequest>[1] = {}) {
  return httpRequest(`${cfg.addr}${path}`, {
    ...opts,
    headers: { "x-vault-token": cfg.token, ...(opts.headers ?? {}) },
  });
}

type Obj = Record<string, unknown>;

/** Trim leading/trailing slashes from a KV path segment. */
const clean = (p: string) => p.replace(/^\/+|\/+$/g, "");

export function registerVault(server: McpServer, config: AppConfig): boolean {
  const cfg = config.integrations.vault;
  if (!cfg) return false;

  server.registerTool(
    "vault_list_mounts",
    {
      title: "List Vault secret mounts",
      description: "Lists enabled secrets engines (mount path, type, description). No secret values.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safe("vault_list_mounts", async () => {
      const res = (await api(cfg, "/v1/sys/mounts")) as { data?: Record<string, Obj> };
      const data = res.data ?? (res as Record<string, Obj>);
      return jsonResult(
        Object.entries(data)
          .filter(([k]) => k.endsWith("/"))
          .map(([mount, m]) => ({
            mount,
            type: (m as { type?: string }).type,
            description: (m as { description?: string }).description,
            version: (m as { options?: { version?: string } }).options?.version,
          })),
      );
    }),
  );

  server.registerTool(
    "vault_list_secrets",
    {
      title: "List Vault secret paths (KV v2)",
      description:
        "Lists the secret paths/keys under a KV v2 mount path. Returns key names only — never secret values.",
      inputSchema: {
        mount: z.string().optional().describe("KV v2 mount (default: VAULT_KV_MOUNT or 'secret')"),
        path: z.string().optional().describe("Path within the mount to list (default: root)"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("vault_list_secrets", async ({ mount, path }) => {
      const m = clean(mount ?? cfg.kvMount);
      const p = clean(path ?? "");
      const res = (await api(cfg, `/v1/${m}/metadata/${p}${qs({ list: true })}`)) as {
        data?: { keys?: string[] };
      };
      return jsonResult({ mount: m, path: p, keys: res.data?.keys ?? [] });
    }),
  );

  server.registerTool(
    "vault_read_secret",
    {
      title: "Read Vault secret metadata (KV v2)",
      description:
        "Returns metadata for a KV v2 secret (versions, timestamps, custom_metadata). Does NOT return secret values.",
      inputSchema: {
        mount: z.string().optional().describe("KV v2 mount (default: VAULT_KV_MOUNT or 'secret')"),
        path: z.string().describe("Secret path within the mount"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("vault_read_secret", async ({ mount, path }) => {
      const m = clean(mount ?? cfg.kvMount);
      const p = clean(path);
      // Deliberately reads the metadata endpoint (not /data) so secret values are
      // never fetched or logged by this server.
      const res = (await api(cfg, `/v1/${m}/metadata/${p}`)) as { data?: Obj };
      const d = res.data ?? {};
      return jsonResult({
        mount: m,
        path: p,
        currentVersion: (d as { current_version?: number }).current_version,
        createdTime: (d as { created_time?: string }).created_time,
        updatedTime: (d as { updated_time?: string }).updated_time,
        maxVersions: (d as { max_versions?: number }).max_versions,
        customMetadata: (d as { custom_metadata?: Obj }).custom_metadata,
        versions: (d as { versions?: Obj }).versions,
      });
    }),
  );

  if (config.allowWrites) {
    server.registerTool(
      "vault_write_secret",
      {
        title: "Write a Vault secret (KV v2, write)",
        description:
          "Writes key/value pairs to a KV v2 path (creates a new version). Enabled because MCP_ALLOW_WRITES=true.",
        inputSchema: {
          mount: z.string().optional().describe("KV v2 mount (default: VAULT_KV_MOUNT or 'secret')"),
          path: z.string().describe("Secret path within the mount"),
          data: z.record(z.string()).describe("Key/value pairs to store"),
        },
        annotations: { destructiveHint: true },
      },
      safe("vault_write_secret", async ({ mount, path, data }) => {
        const m = clean(mount ?? cfg.kvMount);
        const p = clean(path);
        const res = (await api(cfg, `/v1/${m}/data/${p}`, {
          method: "POST",
          body: { data },
        })) as { data?: Obj };
        // Response carries only version metadata, not the values written.
        return jsonResult({ mount: m, path: p, metadata: res.data });
      }),
    );
  }

  return true;
}
