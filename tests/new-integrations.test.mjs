import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";

const { loadConfig } = await import("../dist/config.js");
const { demuxLogs } = await import("../dist/integrations/docker.js");
const { decodeRelease } = await import("../dist/integrations/helm.js");

const PREFIXES = ["DOCKER", "PINECONE", "KUBECOST", "HELM", "TRIVY", "SONARQUBE", "KUBECONFIG", "MCP_"];
/** Run loadConfig with a clean, controlled env (only the given keys set). */
function withEnv(vars, fn) {
  const saved = process.env;
  const base = { ...process.env };
  for (const k of Object.keys(base)) {
    if (PREFIXES.some((p) => k.startsWith(p))) delete base[k];
  }
  process.env = { ...base, MCP_INSECURE: "1", ...vars };
  try {
    return fn();
  } finally {
    process.env = saved;
  }
}

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

test("pinecone: api key enables it with a default api version", () => {
  const cfg = withEnv({ PINECONE_API_KEY: "pc-1" }, () => loadConfig());
  assert.equal(cfg.integrations.pinecone?.apiKey, "pc-1");
  assert.equal(cfg.integrations.pinecone?.apiVersion, "2024-07");
});

test("pinecone: PINECONE_API_VERSION overrides the default", () => {
  const cfg = withEnv({ PINECONE_API_KEY: "pc-1", PINECONE_API_VERSION: "2025-01" }, () => loadConfig());
  assert.equal(cfg.integrations.pinecone?.apiVersion, "2025-01");
});

test("kubecost: url enables it and trailing slash is trimmed; token optional", () => {
  const cfg = withEnv({ KUBECOST_URL: "http://kubecost:9090/", KUBECOST_TOKEN: "t" }, () => loadConfig());
  assert.equal(cfg.integrations.kubecost?.url, "http://kubecost:9090");
  assert.equal(cfg.integrations.kubecost?.token, "t");
});

test("docker: DOCKER_ENABLED uses the default unix socket", () => {
  const cfg = withEnv({ DOCKER_ENABLED: "true" }, () => loadConfig());
  assert.equal(cfg.integrations.docker?.socketPath, "/var/run/docker.sock");
  assert.equal(cfg.integrations.docker?.host, undefined);
});

test("docker: DOCKER_HOST tcp:// resolves to host + port", () => {
  const cfg = withEnv({ DOCKER_HOST: "tcp://10.0.0.5:2375" }, () => loadConfig());
  assert.equal(cfg.integrations.docker?.host, "10.0.0.5");
  assert.equal(cfg.integrations.docker?.port, 2375);
  assert.equal(cfg.integrations.docker?.socketPath, undefined);
});

test("docker: DOCKER_HOST unix:// resolves to a socket path", () => {
  const cfg = withEnv({ DOCKER_HOST: "unix:///Users/x/.docker/run/docker.sock" }, () => loadConfig());
  assert.equal(cfg.integrations.docker?.socketPath, "/Users/x/.docker/run/docker.sock");
});

test("docker: DOCKER_SOCKET overrides the default socket path", () => {
  const cfg = withEnv({ DOCKER_ENABLED: "true", DOCKER_SOCKET: "/tmp/d.sock" }, () => loadConfig());
  assert.equal(cfg.integrations.docker?.socketPath, "/tmp/d.sock");
});

test("helm: HELM_ENABLED enables it and honors KUBECONFIG", () => {
  const cfg = withEnv({ HELM_ENABLED: "true", KUBECONFIG: "/k/config" }, () => loadConfig());
  assert.ok(cfg.integrations.helm);
  assert.equal(cfg.integrations.helm?.kubeconfigPath, "/k/config");
});

test("trivy: TRIVY_ENABLED enables it with defaults; timeout is seconds→ms", () => {
  const cfg = withEnv({ TRIVY_ENABLED: "true", TRIVY_TIMEOUT_SECONDS: "30" }, () => loadConfig());
  assert.equal(cfg.integrations.trivy?.bin, "trivy");
  assert.equal(cfg.integrations.trivy?.timeoutMs, 30_000);
});

test("sonarqube: token becomes a basic-auth header (token as username, empty password)", () => {
  const cfg = withEnv({ SONARQUBE_URL: "https://sonar:9000/", SONARQUBE_TOKEN: "sqp_abc" }, () => loadConfig());
  assert.equal(cfg.integrations.sonarqube?.baseUrl, "https://sonar:9000");
  const expected = `Basic ${Buffer.from("sqp_abc:").toString("base64")}`;
  assert.equal(cfg.integrations.sonarqube?.authHeader, expected);
});

test("sonarqube: url without token is a fatal config error", () => {
  assert.throws(() => withEnv({ SONARQUBE_URL: "https://sonar:9000" }, () => loadConfig()), /SONARQUBE_TOKEN is missing/);
});

// ---------------------------------------------------------------------------
// Docker log-stream demultiplexing
// ---------------------------------------------------------------------------

function frame(stream, text) {
  const payload = Buffer.from(text, "utf8");
  const header = Buffer.alloc(8);
  header[0] = stream; // 1=stdout, 2=stderr
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

test("docker demux: concatenates multiple framed chunks (stdout+stderr)", () => {
  const buf = Buffer.concat([frame(1, "hello\n"), frame(2, "warn\n"), frame(1, "world\n")]);
  assert.equal(demuxLogs(buf), "hello\nwarn\nworld\n");
});

test("docker demux: TTY (unframed) stream is returned raw", () => {
  const raw = "just plain tty output\nwith no frame header\n";
  assert.equal(demuxLogs(Buffer.from(raw, "utf8")), raw);
});

// ---------------------------------------------------------------------------
// Helm release Secret decoding
// ---------------------------------------------------------------------------

const RELEASE = { name: "web", version: 3, info: { status: "deployed" }, chart: { metadata: { name: "web", version: "1.2.3" } } };

test("helm decode: double base64 + gzip (as stored in a k8s Secret)", () => {
  const gz = gzipSync(Buffer.from(JSON.stringify(RELEASE), "utf8"));
  const helmLayer = gz.toString("base64"); // Helm stores base64(gzip(json))
  const secretData = Buffer.from(helmLayer, "utf8").toString("base64"); // k8s base64s it again
  const out = decodeRelease(secretData);
  assert.equal(out.name, "web");
  assert.equal(out.version, 3);
  assert.equal(out.chart.metadata.version, "1.2.3");
});

test("helm decode: single-encoded gzip payload still decodes", () => {
  const gz = gzipSync(Buffer.from(JSON.stringify(RELEASE), "utf8"));
  const out = decodeRelease(gz.toString("base64"));
  assert.equal(out.name, "web");
  assert.equal(out.info.status, "deployed");
});
