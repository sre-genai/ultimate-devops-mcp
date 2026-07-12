import { pino } from "pino";

// In stdio mode, stdout is the MCP protocol channel — logs MUST go to stderr or
// they corrupt the JSON-RPC stream. Detect it from argv (the `--stdio` flag or
// the stdio entrypoint) and route accordingly; HTTP mode keeps logging to
// stdout so container runtimes capture it.
const stdioMode =
  process.argv.includes("--stdio") ||
  process.env.MCP_STDIO === "1" ||
  (process.argv[1]?.endsWith("stdio.js") ?? false);

export const logger = pino(
  {
    name: "ultimate-devops-mcp",
    level: process.env.LOG_LEVEL ?? "info",
    redact: {
      paths: ["*.password", "*.token", "*.apiKey", "*.appKey", "req.headers.authorization"],
      censor: "[redacted]",
    },
  },
  stdioMode ? process.stderr : process.stdout,
);
