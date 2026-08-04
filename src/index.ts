import { randomUUID, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { setGlobalDispatcher, EnvHttpProxyAgent } from "undici";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, enabledIntegrationNames } from "./config.js";
import { logger } from "./logger.js";
import { closeAll, setMaxResultChars } from "./util.js";
import { createMcpServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { type KeyIdentity, LOCAL_IDENTITY, withRequestContext } from "./audit.js";

// Outbound egress proxy: when HTTP_PROXY/HTTPS_PROXY is set (any case), route all
// fetch()/undici traffic through it. Done at boot, before any integration makes a
// request. EnvHttpProxyAgent reads the proxy URLs and NO_PROXY from the
// environment itself. This covers the HTTP/REST integrations (Grafana, Datadog,
// Prometheus, ArgoCD, GitLab, GitHub, Bitbucket, Jira) only — the DB drivers,
// Elasticsearch, Kubernetes and Playwright use their own transports and are NOT
// proxied here. The proxy URL is never logged (it can contain credentials).
if (["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"].some((k) => process.env[k])) {
  setGlobalDispatcher(new EnvHttpProxyAgent());
  logger.info("outbound HTTP proxy enabled (HTTP_PROXY/HTTPS_PROXY)");
}

const config = loadConfig();
setMaxResultChars(config.maxResultChars);

if (!config.authToken && !config.apiKeys) {
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(config.host);
  if (!loopback && process.env.MCP_INSECURE !== "1") {
    logger.fatal(
      `Refusing to start: MCP_HTTP_HOST=${config.host} exposes the server on the network, but ` +
        `MCP_AUTH_TOKEN is not set — that would leave every integration's production credentials ` +
        `open to any reachable client. Set MCP_AUTH_TOKEN, bind loopback, or set MCP_INSECURE=1 to override.`,
    );
    process.exit(1);
  }
  logger.warn(
    "Neither MCP_AUTH_TOKEN nor MCP_API_KEYS is set — the /mcp endpoint is UNAUTHENTICATED " +
      "(bound to a local interface). Set one before exposing it.",
  );
}

// ---------------------------------------------------------------------------
// Session registry
// ---------------------------------------------------------------------------

interface Session {
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
}

const sessions = new Map<string, Session>();

function touch(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (s) s.lastActivity = Date.now();
}

// Idle sweep: close sessions with no activity for sessionIdleTimeoutMs.
const sweeper = setInterval(() => {
  const cutoff = Date.now() - config.sessionIdleTimeoutMs;
  for (const [id, session] of sessions) {
    if (session.lastActivity < cutoff) {
      logger.info({ sessionId: id }, "closing idle session");
      session.transport.close().catch(() => {});
      sessions.delete(id);
    }
  }
}, 60_000);
sweeper.unref();

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.disable("x-powered-by");
if (config.trustProxy) app.set("trust proxy", 1);
app.use(express.json({ limit: "4mb" }));

// Health probes (unauthenticated, for k8s liveness/readiness)
app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok" });
});
app.get("/readyz", (_req, res) => {
  res.status(200).json({
    status: "ok",
    server: SERVER_NAME,
    version: SERVER_VERSION,
    sessions: sessions.size,
    // Count only — don't enumerate which backends are wired to unauth callers.
    integrations: enabledIntegrationNames(config).length,
  });
});

// Resolve a presented bearer to a key identity (constant-time compare). The bare
// MCP_AUTH_TOKEN is a full-access key; MCP_API_KEYS entries carry their own scope.
// Every candidate is compared so a match doesn't short-circuit before the others.
function resolveKey(token: string): KeyIdentity | undefined {
  let match: KeyIdentity | undefined;
  if (config.authToken && safeEqual(token, config.authToken)) {
    match = { name: "root", allowWrites: config.allowWrites };
  }
  if (config.apiKeys) {
    for (const [secret, scope] of Object.entries(config.apiKeys)) {
      if (safeEqual(token, secret)) match = scope;
    }
  }
  return match;
}

// Bearer-token auth (constant-time compare). Resolves the token to a key
// identity and stashes it on res.locals for the dispatch layer (see the POST
// handler, which carries it into request-scoped context for governance/audit).
function authenticate(req: Request, res: Response, next: NextFunction): void {
  if (!config.authToken && !config.apiKeys) {
    next();
    return;
  }
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  const identity = token ? resolveKey(token) : undefined;
  if (identity) {
    res.locals.identity = identity;
    next();
    return;
  }
  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Unauthorized: missing or invalid bearer token" },
    id: null,
  });
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

const limiter = rateLimit({
  windowMs: 60_000,
  limit: config.rateLimitPerMinute,
  standardHeaders: true,
  legacyHeaders: false,
  message: { jsonrpc: "2.0", error: { code: -32000, message: "Rate limit exceeded" }, id: null },
});

// DNS-rebinding protection: a browser fetch always sends an Origin header, so a
// malicious page that rebinds DNS to this server's IP would carry its own
// origin. Reject any present, non-loopback Origin (unless explicitly allowed
// via MCP_ALLOWED_ORIGINS). A missing Origin = a non-browser MCP client, allowed.
const extraOrigins = (process.env.MCP_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  if (extraOrigins.includes(origin)) return true;
  try {
    return ["localhost", "127.0.0.1", "::1"].includes(new URL(origin).hostname);
  } catch {
    return false;
  }
}
function checkOrigin(req: Request, res: Response, next: NextFunction): void {
  if (originAllowed(req.headers.origin)) {
    next();
    return;
  }
  res.status(403).json({
    jsonrpc: "2.0",
    error: { code: -32003, message: "Forbidden: cross-origin request rejected (DNS-rebinding protection)" },
    id: null,
  });
}

app.use("/mcp", checkOrigin, limiter, authenticate);

// ---------------------------------------------------------------------------
// Streamable HTTP transport (MCP spec 2025-03-26+)
//   POST /mcp   — JSON-RPC messages (initialize creates a session)
//   GET  /mcp   — SSE stream for server -> client notifications
//   DELETE /mcp — session termination
// ---------------------------------------------------------------------------

app.post("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const identity = (res.locals.identity as KeyIdentity | undefined) ?? LOCAL_IDENTITY;

  // Carry the resolved key + session into request-scoped context so the tool
  // dispatch governance guard (server.ts) can enforce scope and emit audit logs.
  await withRequestContext({ key: identity, sessionId }, async () => {
  try {
    if (sessionId && sessions.has(sessionId)) {
      touch(sessionId);
      await sessions.get(sessionId)!.transport.handleRequest(req, res, req.body);
      return;
    }

    if (!sessionId && isInitializeRequest(req.body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          sessions.set(sid, { transport, lastActivity: Date.now() });
          logger.info({ sessionId: sid, activeSessions: sessions.size }, "session initialized");
        },
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && sessions.delete(sid)) {
          logger.info({ sessionId: sid, activeSessions: sessions.size }, "session closed");
        }
      };
      const { server } = await createMcpServer(config);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res.status(400).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: sessionId
          ? "Unknown or expired session ID — send a new initialize request"
          : "Bad request: no session ID and not an initialize request",
      },
      id: null,
    });
  } catch (err) {
    logger.error({ err }, "error handling POST /mcp");
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
  });
});

async function handleSessionRequest(req: Request, res: Response): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).send("Invalid or missing mcp-session-id header");
    return;
  }
  touch(sessionId);
  await sessions.get(sessionId)!.transport.handleRequest(req, res);
}

app.get("/mcp", (req, res) => {
  handleSessionRequest(req, res).catch((err) => {
    logger.error({ err }, "error handling GET /mcp");
    if (!res.headersSent) res.status(500).end();
  });
});

app.delete("/mcp", (req, res) => {
  handleSessionRequest(req, res).catch((err) => {
    logger.error({ err }, "error handling DELETE /mcp");
    if (!res.headersSent) res.status(500).end();
  });
});

// ---------------------------------------------------------------------------
// Startup / graceful shutdown
// ---------------------------------------------------------------------------

const httpServer = app.listen(config.port, config.host, () => {
  logger.info(
    {
      host: config.host,
      port: config.port,
      auth: config.authToken || config.apiKeys ? "bearer" : "DISABLED",
      scopedKeys: config.apiKeys ? Object.keys(config.apiKeys).length : 0,
      writesAllowed: config.allowWrites,
      writeDryRun: config.writeDryRun,
      integrations: enabledIntegrationNames(config),
    },
    `${SERVER_NAME} v${SERVER_VERSION} listening — MCP endpoint at http://${config.host}:${config.port}/mcp`,
  );
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");

  const force = setTimeout(() => {
    logger.error("forced shutdown after timeout");
    process.exit(1);
  }, 15_000);
  force.unref();

  clearInterval(sweeper);
  await Promise.allSettled([...sessions.values()].map((s) => s.transport.close()));
  sessions.clear();
  await closeAll();
  httpServer.close(() => {
    logger.info("shutdown complete");
    process.exit(0);
  });
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "unhandled promise rejection");
});
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaught exception — exiting");
  process.exit(1);
});
