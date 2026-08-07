import http from "node:http";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig, DockerConfig } from "../config.js";
import { jsonResult, safe, textResult } from "../util.js";

// Talk to the Docker Engine API over its unix socket (default) or a plain-HTTP
// tcp:// DOCKER_HOST. TLS-protected daemons (2376) are out of scope here.
function request(cfg: DockerConfig, path: string, method = "GET"): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = { method, path, headers: { host: "docker" } };
    if (cfg.socketPath) options.socketPath = cfg.socketPath;
    else {
      options.host = cfg.host;
      options.port = cfg.port;
    }
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.setTimeout(30_000, () => req.destroy(new Error("Docker API request timed out")));
    req.end();
  });
}

async function json(cfg: DockerConfig, path: string, method = "GET"): Promise<unknown> {
  const { status, body } = await request(cfg, path, method);
  const text = body.toString("utf8");
  if (status < 200 || status >= 300) {
    throw new Error(`Docker API ${status} for ${method} ${path}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : null;
}

// Non-TTY container logs are a multiplexed stream: 8-byte frame header
// [stream, 0,0,0, size(4 BE)] + payload. TTY containers stream raw. Demux both.
function demuxLogs(buf: Buffer): string {
  const out: string[] = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const type = buf[i];
    if (type > 2 || buf[i + 1] !== 0 || buf[i + 2] !== 0 || buf[i + 3] !== 0) {
      return buf.toString("utf8"); // not framed (TTY) → raw
    }
    const size = buf.readUInt32BE(i + 4);
    const start = i + 8;
    const end = start + size;
    out.push(buf.slice(start, Math.min(end, buf.length)).toString("utf8"));
    if (end > buf.length) break;
    i = end;
  }
  return out.length ? out.join("") : buf.toString("utf8");
}

type Obj = Record<string, unknown>;

export function registerDocker(server: McpServer, config: AppConfig): boolean {
  const cfg = config.integrations.docker;
  if (!cfg) return false;

  server.registerTool(
    "docker_list_containers",
    {
      title: "List Docker containers",
      description: "Lists containers (running only by default).",
      inputSchema: { all: z.boolean().optional().describe("Include stopped containers") },
      annotations: { readOnlyHint: true },
    },
    safe("docker_list_containers", async ({ all }) => {
      const res = (await json(cfg, `/containers/json?all=${all ? "true" : "false"}`)) as Obj[];
      return jsonResult(
        (res ?? []).map((c) => ({
          id: String(c.Id).slice(0, 12),
          names: (c.Names as string[] | undefined)?.map((n) => n.replace(/^\//, "")),
          image: c.Image,
          state: c.State,
          status: c.Status,
          ports: (c.Ports as Obj[] | undefined)?.map((p) => `${p.PublicPort ? `${p.PublicPort}:` : ""}${p.PrivatePort}/${p.Type}`),
        })),
      );
    }),
  );

  server.registerTool(
    "docker_inspect_container",
    {
      title: "Inspect Docker container",
      description: "Full low-level details of one container.",
      inputSchema: { id: z.string().describe("Container id or name") },
      annotations: { readOnlyHint: true },
    },
    safe("docker_inspect_container", async ({ id }) =>
      jsonResult(await json(cfg, `/containers/${encodeURIComponent(id)}/json`)),
    ),
  );

  server.registerTool(
    "docker_container_logs",
    {
      title: "Get Docker container logs",
      description: "Fetches stdout/stderr from a container (tail).",
      inputSchema: {
        id: z.string().describe("Container id or name"),
        tail: z.number().int().min(1).max(5000).optional().describe("Lines from the end (default 200)"),
        timestamps: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("docker_container_logs", async ({ id, tail, timestamps }) => {
      const { status, body } = await request(
        cfg,
        `/containers/${encodeURIComponent(id)}/logs?stdout=true&stderr=true&tail=${tail ?? 200}&timestamps=${timestamps ? "true" : "false"}`,
      );
      if (status < 200 || status >= 300) {
        throw new Error(`Docker API ${status} fetching logs for ${id}: ${body.toString("utf8").slice(0, 500)}`);
      }
      return textResult(demuxLogs(body) || "(no log output)");
    }),
  );

  server.registerTool(
    "docker_list_images",
    {
      title: "List Docker images",
      description: "Lists images present on the daemon.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safe("docker_list_images", async () => {
      const res = (await json(cfg, "/images/json")) as Obj[];
      return jsonResult(
        (res ?? []).map((im) => ({
          id: String(im.Id).replace(/^sha256:/, "").slice(0, 12),
          repoTags: im.RepoTags,
          sizeMB: Math.round(Number(im.Size ?? 0) / 1e6),
          created: im.Created,
        })),
      );
    }),
  );

  server.registerTool(
    "docker_info",
    {
      title: "Docker engine info",
      description: "Daemon summary: version, container/image counts, OS, and resources.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safe("docker_info", async () => {
      const info = (await json(cfg, "/info")) as Obj;
      return jsonResult({
        serverVersion: info.ServerVersion,
        containers: info.Containers,
        containersRunning: info.ContainersRunning,
        containersStopped: info.ContainersStopped,
        images: info.Images,
        os: info.OperatingSystem,
        arch: info.Architecture,
        kernel: info.KernelVersion,
        cpus: info.NCPU,
        memTotalMB: Math.round(Number(info.MemTotal ?? 0) / 1e6),
        name: info.Name,
      });
    }),
  );

  if (config.allowWrites) {
    server.registerTool(
      "docker_restart_container",
      {
        title: "Restart Docker container (write)",
        description: "Restarts a container. Enabled because MCP_ALLOW_WRITES=true.",
        inputSchema: {
          id: z.string(),
          timeout: z.number().int().min(0).max(300).optional().describe("Seconds to wait before killing (default 10)"),
        },
        annotations: { destructiveHint: true },
      },
      safe("docker_restart_container", async ({ id, timeout }) => {
        await json(cfg, `/containers/${encodeURIComponent(id)}/restart?t=${timeout ?? 10}`, "POST");
        return jsonResult({ restarted: id });
      }),
    );

    server.registerTool(
      "docker_stop_container",
      {
        title: "Stop Docker container (write)",
        description: "Stops a running container. Enabled because MCP_ALLOW_WRITES=true.",
        inputSchema: {
          id: z.string(),
          timeout: z.number().int().min(0).max(300).optional().describe("Seconds to wait before killing (default 10)"),
        },
        annotations: { destructiveHint: true },
      },
      safe("docker_stop_container", async ({ id, timeout }) => {
        await json(cfg, `/containers/${encodeURIComponent(id)}/stop?t=${timeout ?? 10}`, "POST");
        return jsonResult({ stopped: id });
      }),
    );
  }

  return true;
}
