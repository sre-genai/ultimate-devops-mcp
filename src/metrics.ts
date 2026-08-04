// ---------------------------------------------------------------------------
// Gateway self-observability: a tiny in-process metrics registry.
//
// Hand-rolled (no extra dependency) counters + a per-tool duration histogram,
// rendered in the Prometheus text exposition format (v0.0.4). Every tool
// handler funnels through `record()` via the `safe()` wrapper in util.ts, so
// this stays the single source of truth for tool-call telemetry.
// ---------------------------------------------------------------------------

// Histogram bucket upper bounds in seconds (cumulative). Covers sub-ms cache
// hits through slow multi-second backend queries.
const BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface ToolStat {
  calls: number;
  errors: number;
  sumSeconds: number;
  // bucketCounts[i] = number of observations <= BUCKETS_SECONDS[i]
  bucketCounts: number[];
}

const tools = new Map<string, ToolStat>();
let totalCalls = 0;
let totalErrors = 0;
const startedAt = Date.now();

function statFor(tool: string): ToolStat {
  let s = tools.get(tool);
  if (!s) {
    s = { calls: 0, errors: 0, sumSeconds: 0, bucketCounts: new Array(BUCKETS_SECONDS.length).fill(0) };
    tools.set(tool, s);
  }
  return s;
}

/** Records one tool invocation: its wall-clock duration (ms) and whether it errored. */
export function record(tool: string, ms: number, isError: boolean): void {
  const seconds = ms / 1000;
  const s = statFor(tool);
  s.calls += 1;
  s.sumSeconds += seconds;
  if (isError) s.errors += 1;
  for (let i = 0; i < BUCKETS_SECONDS.length; i++) {
    if (seconds <= BUCKETS_SECONDS[i]) s.bucketCounts[i] += 1;
  }
  totalCalls += 1;
  if (isError) totalErrors += 1;
}

// Prometheus label values must escape backslash, double-quote and newline.
function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** Renders all metrics in the Prometheus text exposition format (v0.0.4). */
export function renderPrometheus(): string {
  const lines: string[] = [];

  lines.push("# HELP mcp_uptime_seconds Seconds since this gateway process started.");
  lines.push("# TYPE mcp_uptime_seconds gauge");
  lines.push(`mcp_uptime_seconds ${((Date.now() - startedAt) / 1000).toFixed(3)}`);

  lines.push("# HELP mcp_tool_calls_total Total tool invocations.");
  lines.push("# TYPE mcp_tool_calls_total counter");
  lines.push(`mcp_tool_calls_total ${totalCalls}`);

  lines.push("# HELP mcp_tool_errors_total Total tool invocations that returned an error.");
  lines.push("# TYPE mcp_tool_errors_total counter");
  lines.push(`mcp_tool_errors_total ${totalErrors}`);

  lines.push("# HELP mcp_tool_calls Tool invocations, labelled per tool.");
  lines.push("# TYPE mcp_tool_calls counter");
  for (const [tool, s] of tools) {
    lines.push(`mcp_tool_calls{tool="${escapeLabel(tool)}"} ${s.calls}`);
  }

  lines.push("# HELP mcp_tool_errors Tool errors, labelled per tool.");
  lines.push("# TYPE mcp_tool_errors counter");
  for (const [tool, s] of tools) {
    lines.push(`mcp_tool_errors{tool="${escapeLabel(tool)}"} ${s.errors}`);
  }

  lines.push("# HELP mcp_tool_duration_seconds Tool call duration in seconds, per tool.");
  lines.push("# TYPE mcp_tool_duration_seconds histogram");
  for (const [tool, s] of tools) {
    const label = escapeLabel(tool);
    let cumulative = 0;
    for (let i = 0; i < BUCKETS_SECONDS.length; i++) {
      cumulative = s.bucketCounts[i];
      lines.push(`mcp_tool_duration_seconds_bucket{tool="${label}",le="${BUCKETS_SECONDS[i]}"} ${cumulative}`);
    }
    lines.push(`mcp_tool_duration_seconds_bucket{tool="${label}",le="+Inf"} ${s.calls}`);
    lines.push(`mcp_tool_duration_seconds_sum{tool="${label}"} ${s.sumSeconds.toFixed(6)}`);
    lines.push(`mcp_tool_duration_seconds_count{tool="${label}"} ${s.calls}`);
  }

  return lines.join("\n") + "\n";
}
