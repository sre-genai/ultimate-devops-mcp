import { pino } from "pino";

export const logger = pino({
  name: "ultimate-devops-mcp",
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: ["*.password", "*.token", "*.apiKey", "*.appKey", "req.headers.authorization"],
    censor: "[redacted]",
  },
});
