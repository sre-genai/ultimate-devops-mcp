import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Enterprise auth & governance primitives
//
// A "key identity" is the resolved scope of the bearer token a caller presented
// (see the authenticate middleware in index.ts). It is carried to the tool
// dispatch layer via AsyncLocalStorage so the per-tool governance guard (see
// server.ts) can enforce the key's scope and emit an audit record — all without
// threading a request object through the MCP SDK.
// ---------------------------------------------------------------------------

export interface KeyIdentity {
  /** Human-readable key name for audit logs — NEVER the secret itself. */
  name: string;
  /** Optional allowlist of tool names this key may call. Undefined = all tools. */
  tools?: string[];
  /** Whether this key may invoke write/mutating tools. */
  allowWrites: boolean;
}

export interface RequestContext {
  key: KeyIdentity;
  sessionId?: string;
}

/** Identity used when no HTTP auth context is present (stdio, or an
 * unauthenticated loopback HTTP server). A local/stdio server is inherently a
 * single trusted client, so it gets full access; writes are still gated by the
 * server-level MCP_ALLOW_WRITES (write tools aren't registered without it). */
export const LOCAL_IDENTITY: KeyIdentity = { name: "local", allowWrites: true };

const store = new AsyncLocalStorage<RequestContext>();

export function withRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return store.run(ctx, fn);
}

export function currentContext(): RequestContext | undefined {
  return store.getStore();
}

/** A key may call a tool when it has no allowlist, or the tool is on it. */
export function keyAllowsTool(key: KeyIdentity, tool: string): boolean {
  return key.tools === undefined || key.tools.includes(tool);
}

export type AuditOutcome = "allowed" | "denied" | "dry-run" | "error";

export interface AuditEvent {
  tool: string;
  /** Whether the tool mutates state (not readOnlyHint). */
  write: boolean;
  /** Key name — never the token. */
  key: string;
  sessionId?: string;
  outcome: AuditOutcome;
  /** Short human reason for denied/error/dry-run. */
  reason?: string;
  durationMs: number;
}

/**
 * Emit one structured audit record per tool invocation. Deliberately logs no
 * tool arguments and no secrets — only who called what, when, and the outcome.
 */
export function audit(event: AuditEvent): void {
  logger.info(
    { audit: { ...event, ts: new Date().toISOString() } },
    `tool ${event.tool} ${event.outcome}`,
  );
}
