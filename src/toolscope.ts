import type { KeyIdentity } from "./audit.js";

// Tool-name prefix per integration (most are `<name>_`, a few differ). Used to
// scope a key or a request to whole integrations, e.g. postgres → "postgres_*".
export const TOOL_PREFIX: Record<string, string> = {
  mongodb: "mongo", kubernetes: "k8s", elasticsearch: "es", prometheus: "prom", playwright: "browser",
};

/** The wildcard that matches every tool of an integration, e.g. "postgres_*". */
export const toolWildcard = (name: string): string => `${TOOL_PREFIX[name] ?? name}_*`;

/**
 * Narrow an identity to a single integration for a path-scoped request
 * (`/mcp/<system>`). The result is the INTERSECTION of the path and the key's
 * own scope — so a Redis-scoped key hitting `/mcp/postgres` gets nothing. Path
 * scoping can only ever narrow access, never widen it.
 */
export function scopeIdentityToSystem(identity: KeyIdentity, system: string): KeyIdentity {
  const wild = toolWildcard(system);
  const base = identity.tools; // undefined = key allows all tools
  const tools = base === undefined || base.includes(wild) ? [wild] : [];
  return { ...identity, tools };
}
