import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig, TrivyConfig } from "../config.js";
import { jsonResult, safe, textResult } from "../util.js";

const run = promisify(execFile);

// A scan target is a positional arg (image ref or path). Reject anything that
// looks like an option flag so it can't inject extra trivy arguments.
function assertTarget(target: string): void {
  if (target.startsWith("-")) throw new Error(`Invalid target "${target}" (must not start with '-')`);
}

async function trivy(cfg: TrivyConfig, args: string[]): Promise<string> {
  // execFile (no shell) + arg array → no shell injection.
  const { stdout } = await run(cfg.bin, args, { timeout: cfg.timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

interface TrivyVuln {
  VulnerabilityID?: string;
  PkgName?: string;
  InstalledVersion?: string;
  FixedVersion?: string;
  Severity?: string;
  Title?: string;
  PrimaryURL?: string;
}
interface TrivyResult {
  Target?: string;
  Class?: string;
  Type?: string;
  Vulnerabilities?: TrivyVuln[];
}

function summarize(stdout: string) {
  let parsed: { Results?: TrivyResult[] };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { raw: stdout.slice(0, 20_000) };
  }
  const counts: Record<string, number> = {};
  const results = (parsed.Results ?? []).map((r) => ({
    target: r.Target,
    class: r.Class,
    type: r.Type,
    vulnerabilities: (r.Vulnerabilities ?? []).map((v) => {
      const sev = v.Severity ?? "UNKNOWN";
      counts[sev] = (counts[sev] ?? 0) + 1;
      return {
        id: v.VulnerabilityID,
        pkg: v.PkgName,
        installed: v.InstalledVersion,
        fixed: v.FixedVersion,
        severity: sev,
        title: v.Title,
        url: v.PrimaryURL,
      };
    }),
  }));
  return { summary: counts, results };
}

export function registerTrivy(server: McpServer, config: AppConfig): boolean {
  const cfg = config.integrations.trivy;
  if (!cfg) return false;

  server.registerTool(
    "trivy_scan_image",
    {
      title: "Scan a container image for vulnerabilities",
      description:
        "Runs the local `trivy` binary against a container image and returns CVEs grouped by target, plus a severity count.",
      inputSchema: {
        image: z.string().describe("Image reference, e.g. nginx:1.27 or registry/app@sha256:…"),
        severity: z.string().optional().describe('Comma-separated severities (default "HIGH,CRITICAL")'),
        ignoreUnfixed: z.boolean().optional().describe("Only report vulnerabilities that have a fix"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("trivy_scan_image", async ({ image, severity, ignoreUnfixed }) => {
      assertTarget(image);
      const args = ["image", "--format", "json", "--quiet", "--severity", severity ?? "HIGH,CRITICAL"];
      if (ignoreUnfixed) args.push("--ignore-unfixed");
      args.push(image);
      return jsonResult({ image, ...summarize(await trivy(cfg, args)) });
    }),
  );

  server.registerTool(
    "trivy_scan_filesystem",
    {
      title: "Scan a filesystem path for vulnerabilities",
      description:
        "Runs `trivy fs` against a directory (lockfiles, OS packages) reachable by the server and returns findings.",
      inputSchema: {
        path: z.string().describe("Filesystem path the server can read"),
        severity: z.string().optional().describe('Comma-separated severities (default "HIGH,CRITICAL")'),
        ignoreUnfixed: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("trivy_scan_filesystem", async ({ path, severity, ignoreUnfixed }) => {
      assertTarget(path);
      const args = ["fs", "--format", "json", "--quiet", "--severity", severity ?? "HIGH,CRITICAL"];
      if (ignoreUnfixed) args.push("--ignore-unfixed");
      args.push(path);
      return jsonResult({ path, ...summarize(await trivy(cfg, args)) });
    }),
  );

  server.registerTool(
    "trivy_version",
    {
      title: "Trivy version",
      description: "Version of the local trivy binary and its vulnerability DB.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safe("trivy_version", async () => textResult(await trivy(cfg, ["--version"]))),
  );

  return true;
}
