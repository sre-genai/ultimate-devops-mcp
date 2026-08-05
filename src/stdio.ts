// stdio entrypoint: run the same MCP server over stdio so a local client
// (Claude Desktop/Code, Cursor) can launch it directly as a subprocess — no
// HTTP server, no port, no auth needed (a stdio server is inherently a single
// trusted local client). Logs go to stderr (see logger.ts) so they never
// corrupt the JSON-RPC channel on stdout.
//
// Run:  node dist/stdio.js   (or the `ultimate-devops-mcp-stdio` bin)
import { setGlobalDispatcher, EnvHttpProxyAgent } from "undici";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, enabledIntegrationNames } from "./config.js";
import { logger } from "./logger.js";
import { closeAll, setMaxResultChars } from "./util.js";
import { createMcpServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

async function main(): Promise<void> {
  // Route outbound fetch()/undici traffic through HTTP_PROXY/HTTPS_PROXY when set
  // (never logging the proxy URL). Covers the HTTP/REST integrations only — DB
  // drivers, Elasticsearch, Kubernetes and Playwright use their own transports.
  if (["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"].some((k) => process.env[k])) {
    setGlobalDispatcher(new EnvHttpProxyAgent());
    logger.info("outbound HTTP proxy enabled (HTTP_PROXY/HTTPS_PROXY)");
  }

  const config = loadConfig();
  setMaxResultChars(config.maxResultChars);

  const { server, enabled } = await createMcpServer(config);
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    await transport.close().catch(() => {});
    await closeAll();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  // The client closing the pipe ends the session — exit cleanly.
  transport.onclose = () => void shutdown("transport-close");

  await server.connect(transport);
  logger.info(
    {
      transport: "stdio",
      writesAllowed: config.allowWrites,
      integrations: enabledIntegrationNames(config),
      enabled,
    },
    `${SERVER_NAME} v${SERVER_VERSION} serving over stdio`,
  );
}

main().catch((err) => {
  logger.fatal({ err }, "stdio startup failed");
  process.exit(1);
});
