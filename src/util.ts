import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "./logger.js";
import { record as recordMetric } from "./metrics.js";

let maxResultChars = 50_000;

export function setMaxResultChars(n: number): void {
  maxResultChars = n;
}

export function truncate(text: string): string {
  if (text.length <= maxResultChars) return text;
  return `${text.slice(0, maxResultChars)}\n\n[... output truncated at ${maxResultChars} characters ...]`;
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text: truncate(text) }] };
}

/** Cap any single string field before serialization so one giant value (e.g. a
 * hostile `SELECT repeat('x', 5e8)` or a huge `redis_get`) can't balloon memory
 * during JSON.stringify. Bounds per-field to maxResultChars; the whole payload is
 * still truncated by `truncate()` afterwards. NOTE: the backend still materializes
 * the value at fetch — bound queries with row/size limits for true safety. */
function capFields(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > maxResultChars
      ? `${value.slice(0, maxResultChars)}…[field truncated]`
      : value;
  }
  if (Array.isArray(value)) return value.map(capFields);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = capFields(v);
    return out;
  }
  return value;
}

export function jsonResult(value: unknown): CallToolResult {
  return textResult(JSON.stringify(capFields(value), jsonReplacer, 2));
}

export function imageResult(base64: string, mimeType: string, caption?: string): CallToolResult {
  const content: CallToolResult["content"] = [{ type: "image", data: base64, mimeType }];
  if (caption) content.unshift({ type: "text", text: caption });
  return { content };
}

export function errorResult(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text", text: `Error: ${truncate(message)}` }],
    isError: true,
  };
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  return value;
}

/** Wraps a tool handler so any thrown error becomes an isError tool result instead of a protocol failure. */
export function safe<Args>(
  name: string,
  fn: (args: Args) => Promise<CallToolResult>,
): (args: Args) => Promise<CallToolResult> {
  return async (args: Args) => {
    // --- metrics: record duration + error for every tool dispatch ---
    const startedAt = Date.now();
    let isError = false;
    try {
      const result = await fn(args);
      isError = result.isError === true;
      return result;
    } catch (err) {
      isError = true;
      logger.warn({ tool: name, err: err instanceof Error ? err.message : String(err) }, "tool call failed");
      return errorResult(err);
    } finally {
      recordMetric(name, Date.now() - startedAt, isError);
    }
  };
}

// ---------------------------------------------------------------------------
// Shutdown registry: integrations register their lazily-created clients here
// so graceful shutdown can close pools/drivers/browsers in one place.
// ---------------------------------------------------------------------------

interface Closer {
  name: string;
  close: () => Promise<void>;
}

const closers: Closer[] = [];

export function registerCloser(name: string, close: () => Promise<void>): void {
  closers.push({ name, close });
}

export async function closeAll(): Promise<void> {
  while (closers.length > 0) {
    const { name, close } = closers.pop()!;
    try {
      await Promise.race([
        close(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("close timeout")), 5000)),
      ]);
      logger.info({ client: name }, "closed integration client");
    } catch (err) {
      logger.warn({ client: name, err: err instanceof Error ? err.message : String(err) }, "failed to close client");
    }
  }
}

// ---------------------------------------------------------------------------
// fetch helper for REST-based integrations (Grafana, Datadog, Prometheus,
// ArgoCD, GitLab)
// ---------------------------------------------------------------------------

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  /** Return raw text instead of parsed JSON */
  raw?: boolean;
}

export async function httpRequest(url: string, opts: HttpOptions = {}): Promise<unknown> {
  const { method = "GET", headers = {}, body, timeoutMs = 30_000, raw = false } = opts;
  const init: RequestInit = {
    method,
    headers: body !== undefined ? { "content-type": "application/json", ...headers } : headers,
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} from ${method} ${url}: ${text.slice(0, 2000)}`);
  }
  if (raw) return text;
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function qs(params: Record<string, string | number | boolean | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined) as [string, string | number | boolean][];
  if (entries.length === 0) return "";
  const search = new URLSearchParams();
  for (const [k, v] of entries) search.set(k, String(v));
  return `?${search.toString()}`;
}
