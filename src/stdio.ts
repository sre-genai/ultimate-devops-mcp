// stdio entrypoint: run the same MCP server over stdio so a local client
// (Claude Desktop/Code, Cursor) can launch it directly as a subprocess — no
// HTTP server, no port, no auth needed (a stdio server is inherently a single
// trusted local client). Logs go to stderr (see logger.ts) so they never
// corrupt the JSON-RPC channel on stdout.
//
// Run:  node dist/stdio.js   (or the `ultimate-devops-mcp-stdio` bin)
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, enabledIntegrationNames } from "./config.js";
import { logger } from "./logger.js";
import { closeAll, setMaxResultChars } from "./util.js";
import { createMcpServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  setMaxResultChars(config.maxResultChars);

  const { server, enabled } = createMcpServer(config);
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
