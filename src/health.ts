import net from "node:net";
import type { AppConfig } from "./config.js";

// Best-effort reachability for the console's "systems health": a short TCP
// connect to each active integration's host:port, cached briefly. Generic (no
// per-integration probe code) — derives host:port from config. Backends without
// a network target (kubernetes/docker/helm/trivy/playwright) report "unknown".
export type Health = "up" | "down" | "unknown";

const TTL_MS = 15_000;
let cache: Record<string, Health> = {};
let cachedAt = 0;
let inflight: Promise<Record<string, Health>> | undefined;

function hostPort(url: string | undefined, defPort: number): { host: string; port: number } | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : u.protocol === "http:" ? 80 : defPort;
    return { host: u.hostname, port };
  } catch {
    return undefined;
  }
}

function target(name: string, cfg: AppConfig): { host: string; port: number } | undefined {
  const i = cfg.integrations;
  const primary = <T,>(o?: { instances: Record<string, T>; primary: string }): T | undefined =>
    o ? o.instances[o.primary] : undefined;
  switch (name) {
    case "postgres": return hostPort(i.postgres?.connectionString, 5432);
    case "mongodb": return hostPort(i.mongo?.uri, 27017);
    case "neo4j": return hostPort(i.neo4j?.url, 7687);
    case "redis": return hostPort(i.redis?.url, 6379);
    case "elasticsearch": return hostPort(primary(i.elastic)?.node, 9200);
    case "prometheus": return hostPort(primary(i.prometheus)?.url, 9090);
    case "grafana": return hostPort(primary(i.grafana)?.url, 443);
    case "argocd": return hostPort(primary(i.argocd)?.url, 443);
    case "gitlab": return hostPort(primary(i.gitlab)?.url, 443);
    case "github": return hostPort(primary(i.github)?.baseUrl, 443);
    case "bitbucket": return hostPort(primary(i.bitbucket)?.baseUrl, 443);
    case "jira": return hostPort(primary(i.jira)?.baseUrl, 443);
    case "sentry": return hostPort(i.sentry?.baseUrl, 443);
    case "jenkins": return hostPort(i.jenkins?.baseUrl, 443);
    case "vault": return hostPort(i.vault?.addr, 8200);
    case "sonarqube": return hostPort(i.sonarqube?.baseUrl, 443);
    case "kubecost": return hostPort(i.kubecost?.url, 9090);
    case "pagerduty": return hostPort(i.pagerduty?.baseUrl, 443);
    case "slack": return { host: "slack.com", port: 443 };
    case "pinecone": return { host: "api.pinecone.io", port: 443 };
    case "datadog": return { host: `api.${primary(i.datadog)?.site ?? "datadoghq.com"}`, port: 443 };
    case "kafka": {
      const b = i.kafka?.brokers[0];
      if (!b) return undefined;
      const [h, p] = b.split(":");
      return { host: h, port: Number(p ?? 9092) };
    }
    default: return undefined; // kubernetes / docker / helm / trivy / playwright
  }
}

function tcpProbe(host: string, port: number, timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** Reachability for each active integration (cached ~15s). */
export function healthStatus(cfg: AppConfig, active: string[]): Promise<Record<string, Health>> {
  if (inflight) return inflight;
  if (Date.now() - cachedAt < TTL_MS && Object.keys(cache).length > 0) return Promise.resolve(cache);
  inflight = (async () => {
    const out: Record<string, Health> = {};
    await Promise.all(
      active.map(async (name) => {
        const t = target(name, cfg);
        out[name] = t ? ((await tcpProbe(t.host, t.port)) ? "up" : "down") : "unknown";
      }),
    );
    cache = out;
    cachedAt = Date.now();
    inflight = undefined;
    return out;
  })();
  return inflight;
}
