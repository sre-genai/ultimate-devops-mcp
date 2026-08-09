# Ultimate DevOps MCP

**One MCP server for your entire DevOps stack.** Give Claude, Cursor, or any MCP client operational access to Postgres, MongoDB, Neo4j, Elasticsearch, Kafka, Redis, Kubernetes, Grafana, Datadog, Prometheus, ArgoCD, GitLab, GitHub, Bitbucket and a headless browser — through a single production-ready endpoint.

- **Latest MCP transport** — Streamable HTTP (spec `2025-03-26`+), stateful sessions, SSE streaming
- **28 integrations, 150+ tools** — each activates automatically when its env vars are set
- **Safe by default** — read-only unless `MCP_ALLOW_WRITES=true`; SQL/Cypher run in read-only transactions
- **Production hardening** — bearer-token auth, rate limiting, output truncation, idle-session reaping, graceful shutdown, health probes, structured JSON logs
- **MIT licensed**

```
┌──────────────┐   Streamable HTTP    ┌─────────────────────┐
│ Claude Code   │ ───────────────────▶ │                     │──▶ Postgres · MongoDB · Neo4j
│ Cursor        │   POST/GET /mcp      │  Ultimate DevOps    │──▶ Elasticsearch · Kafka · Redis
│ any MCP client│   Bearer token       │  MCP Server         │──▶ Kubernetes · ArgoCD · GitLab
└──────────────┘                      │                     │──▶ Grafana · Datadog · Prometheus
                                      └─────────────────────┘──▶ Headless browser (Playwright)
```

## Quick start

```bash
git clone <repo> && cd ultimate-mcp
cp .env.example .env          # fill in the systems you use + MCP_AUTH_TOKEN
npm install
npm run build
npm start
# MCP endpoint: http://localhost:8080/mcp
```

Or with Docker:

```bash
docker compose up -d
# with browser tools:
docker build --build-arg WITH_BROWSER=true -t ultimate-devops-mcp .
```

## Connect a client

**Claude Code**

```bash
claude mcp add devops --transport http http://localhost:8080/mcp \
  --header "Authorization: Bearer $MCP_AUTH_TOKEN"
```

**Cursor / other clients** (`mcp.json`):

```json
{
  "mcpServers": {
    "devops": {
      "url": "http://localhost:8080/mcp",
      "headers": { "Authorization": "Bearer <your token>" }
    }
  }
}
```

Then ask: *"Call devops_status"* — it lists which integrations this server has enabled.

### Local / stdio

For a purely local setup, run it over **stdio** — the client launches the process directly, no HTTP server, port, or auth needed (a stdio server is a single trusted local client). Logs go to stderr so they never corrupt the protocol on stdout.

```bash
# Claude Code — launch the built server over stdio, passing integration env:
claude mcp add devops-local \
  -e POSTGRES_URL=postgres://... -e REDIS_URL=redis://... \
  -- node /path/to/ultimate-mcp/dist/stdio.js
```

Same tools and write-gating as HTTP mode; `npm run start:stdio` runs it directly. Use HTTP for a shared/remote deployment, stdio for a local single-user launch.

## Configuration

Everything is env-var driven; an integration is enabled **only** when its variables are present. See [.env.example](.env.example) for the full annotated reference.

| Integration | Required env vars |
|---|---|
| Postgres | `POSTGRES_URL` (or `DATABASE_URL`) |
| MongoDB | `MONGODB_URI` |
| Neo4j | `NEO4J_URL`, `NEO4J_USERNAME`, `NEO4J_PASSWORD` |
| Elasticsearch | `ELASTICSEARCH_NODE` (+ `ELASTICSEARCH_API_KEY` or user/pass) |
| Kafka | `KAFKA_BROKERS` (+ optional SSL/SASL vars) |
| Redis | `REDIS_URL` |
| Kubernetes | `K8S_ENABLED=true` or `KUBECONFIG` |
| Grafana | `GRAFANA_URL`, `GRAFANA_TOKEN` |
| Datadog | `DATADOG_API_KEY`, `DATADOG_APP_KEY` (+ `DATADOG_SITE`) |
| Prometheus | `PROMETHEUS_URL` |
| ArgoCD | `ARGOCD_URL`, `ARGOCD_TOKEN` |
| GitLab | `GITLAB_TOKEN` (+ `GITLAB_URL` for self-hosted) |
| GitHub | `GITHUB_TOKEN` (+ `GITHUB_API_URL` for GitHub Enterprise) |
| Bitbucket | `BITBUCKET_TOKEN` **or** `BITBUCKET_USERNAME`+`BITBUCKET_APP_PASSWORD` (+ `BITBUCKET_WORKSPACE`) |
| Playwright | `PLAYWRIGHT_ENABLED=true` (+ `npx playwright install chromium`) |
| Pinecone | `PINECONE_API_KEY` (+ optional `PINECONE_API_VERSION`) |
| Kubecost | `KUBECOST_URL` (+ optional `KUBECOST_TOKEN`) |
| Docker | `DOCKER_ENABLED=true` (unix socket) or `DOCKER_HOST=tcp://…` |
| Helm | `HELM_ENABLED=true` (reads release Secrets via the k8s API; honors `KUBECONFIG`) |
| Trivy | `TRIVY_ENABLED=true` (+ optional `TRIVY_BIN`) — requires the `trivy` binary on PATH |
| SonarQube | `SONARQUBE_URL`, `SONARQUBE_TOKEN` |

**Server settings:** `MCP_AUTH_TOKEN` (bearer auth — set it in production), `MCP_API_KEYS` (scoped keys, see below), `MCP_ALLOW_WRITES` (default `false`), `MCP_WRITE_DRYRUN` (default `false`), `MCP_HTTP_PORT` (8080), `MCP_RATE_LIMIT_PER_MINUTE` (300), `MCP_SESSION_IDLE_TIMEOUT_MINUTES` (30), `MCP_MAX_RESULT_CHARS` (50000), `MCP_TRUST_PROXY`, `LOG_LEVEL`.

## Auth & governance

Three layers let you expose one server to multiple callers with different privileges, keep a tamper-evident record of every call, and rehearse writes safely.

**Scoped API keys** — `MCP_AUTH_TOKEN` remains a single full-access bearer key (unchanged). For finer control, set `MCP_API_KEYS` to a JSON object mapping each token secret to a scope:

```bash
MCP_API_KEYS='{
  "tok_ci_readonly":  { "name": "ci",       "tools": ["postgres_query", "prometheus_query"], "allowWrites": false },
  "tok_oncall_write": { "name": "oncall",                                                     "allowWrites": true }
}'
```

- `name` — label used in audit logs (never the secret).
- `tools` — optional allowlist of tool names this key may call; omit for all tools.
- `allowWrites` — whether the key may call write/mutating tools (in addition to the server-wide `MCP_ALLOW_WRITES`, which must also be on for write tools to exist).

The presented bearer is matched constant-time against `MCP_AUTH_TOKEN` and every `MCP_API_KEYS` entry; an unknown token is rejected with `401`. A call to a tool outside the key's scope, or a write from a key without `allowWrites`, is rejected and audited as `denied`. When either `MCP_AUTH_TOKEN` or `MCP_API_KEYS` is set the endpoint is authenticated.

**Native SSO (OIDC/JWT)** — validate IdP-issued bearer tokens directly in the gateway, no proxy required. Set `AUTH_OIDC_ISSUER` (+ recommended `AUTH_OIDC_AUDIENCE`) and the gateway becomes an OAuth2 Resource Server: it verifies each JWT against the issuer's JWKS (signature, issuer, audience, expiry, algorithm allowlist via `jose`) and maps the claims to the same scope model as static keys — `AUTH_OIDC_ADMIN_GROUPS` grants writes, and an optional `AUTH_OIDC_GROUP_TOOLS` map restricts each group to an allowlist. The audit `name` becomes the real user (`email`/`sub`). Works with **AWS Cognito, Auth0, Azure Entra ID, Google, and Keycloak** — only the issuer and claim names differ (see [.env.example](.env.example) for per-IdP presets). Static `MCP_AUTH_TOKEN`/`MCP_API_KEYS` are tried first, so the two models coexist. For machine callers, use your IdP's client-credentials tokens, or the self-service console below.

**Self-service API-key console** — set `AUTH_CONSOLE_ENABLED=true` to mount a small web console (default `/console`) where a human signs in via SSO (OIDC authorization-code + PKCE) and mints or revokes their *own* scoped API keys. The generated secret is shown exactly once, stored only as a SHA-256 hash, and is then accepted on the `/mcp` bearer path like any other key. The flow is *SSO login → generate a scoped key → use it as `Authorization: Bearer`*. Only members of `AUTH_OIDC_ADMIN_GROUPS` may mint write-capable keys (the server re-derives admin membership from the verified id_token, never from the form). The console reuses your OIDC issuer and needs a confidential client (`AUTH_OIDC_CLIENT_ID`/`_CLIENT_SECRET`), an `AUTH_OIDC_REDIRECT_URI`, and an `AUTH_SESSION_SECRET`; it has its own session cookie and is *not* behind the `/mcp` bearer middleware. Keys persist in a pluggable store — SQLite by default (zero-config), or Postgres/Redis via `AUTH_KEY_STORE` (see [.env.example](.env.example)).

**Audit logging** — every tool invocation emits one structured pino log line under the `audit` key: `{ tool, write, key, sessionId, outcome, reason?, durationMs, ts }` where `outcome` is `allowed` / `denied` / `dry-run` / `error`. Records carry no tool arguments and no secrets — only who called what, when, and how it resolved. Ship stdout to your log pipeline to retain the trail.

**Write dry-run** — set `MCP_WRITE_DRYRUN=true` and every write/mutating tool returns a preview object (`{ dryRun: true, tool, note, args }`) describing what *would* happen, without touching any backend. Read tools are unaffected. Use it to rehearse a change set or to run an agent against production with writes armed but disarmed.

Enforcement happens once, centrally, at tool dispatch (`installGovernance` in `src/server.ts` wraps `registerTool`), so it applies uniformly to every current and future integration over both HTTP and stdio.

**Multiple instances of one system.** The HTTP integrations — Grafana, Datadog, Prometheus, ArgoCD, GitLab, GitHub, Bitbucket, Jira — can each target several backends (e.g. prod + non-prod). Declare `<NAME>_INSTANCES=a,b` and give each name its own vars (`GRAFANA_PROD_URL`/`GRAFANA_PROD_TOKEN`, …); every tool then accepts an optional `instance` argument. `<NAME>_PRIMARY` (or the first listed name) is the default when a call omits it. The single-instance vars keep working unchanged and register as the `default` instance. See [.env.example](.env.example) for per-integration examples.

**Outbound egress proxy.** Set `HTTP_PROXY`/`HTTPS_PROXY` (with optional `NO_PROXY`) and the server routes all outbound HTTP/REST calls — Grafana, Datadog, Prometheus, ArgoCD, GitLab, GitHub, Bitbucket, Jira — through the proxy. The proxy URL is never logged. **Not covered:** the database drivers (Postgres/MongoDB/Neo4j/Redis), Elasticsearch, Kubernetes and Playwright use their own transports and bypass this proxy.

## Tool catalog

Write tools (⚡) are registered **only** when `MCP_ALLOW_WRITES=true`.

| Integration | Tools |
|---|---|
| **Meta** | `devops_status`, `devops_investigate` |
| **Postgres** | `postgres_list_databases`, `postgres_query` (read-only tx), `postgres_list_tables`, `postgres_describe_table`, ⚡`postgres_execute` — all but `list_databases` take an optional `database` to target any DB on the instance |
| **MongoDB** | `mongo_list_databases`, `mongo_list_collections`, `mongo_find`, `mongo_aggregate`, `mongo_count`, ⚡`mongo_insert`, ⚡`mongo_update` |
| **Neo4j** | `neo4j_read_cypher`, `neo4j_schema`, ⚡`neo4j_write_cypher` |
| **Elasticsearch** | `es_search`, `es_list_indices`, `es_cluster_health`, `es_get_document` |
| **Kafka** | `kafka_list_topics`, `kafka_describe_topic`, `kafka_consumer_groups`, `kafka_consumer_lag`, `kafka_tail`, ⚡`kafka_produce` |
| **Redis** | `redis_get` (type-aware), `redis_keys` (SCAN), `redis_info`, `redis_ttl`, ⚡`redis_set`, ⚡`redis_delete` |
| **Kubernetes** | `k8s_list`, `k8s_get`, `k8s_pod_logs`, `k8s_events`, ⚡`k8s_scale`, ⚡`k8s_rollout_restart`, ⚡`k8s_delete_pod` |
| **Grafana** | `grafana_search_dashboards`, `grafana_get_dashboard`, `grafana_list_datasources`, `grafana_list_alert_rules`, ⚡`grafana_create_annotation` |
| **Datadog** | `datadog_query_metrics`, `datadog_search_logs`, `datadog_list_monitors`, `datadog_get_monitor`, `datadog_list_events`, ⚡`datadog_post_event` |
| **Prometheus** | `prom_query`, `prom_query_range`, `prom_alerts`, `prom_targets` |
| **ArgoCD** | `argocd_list_applications`, `argocd_get_application`, `argocd_app_resources`, `argocd_app_history`, ⚡`argocd_sync_application` |
| **GitLab** | `gitlab_list_projects`, `gitlab_list_pipelines`, `gitlab_pipeline_jobs`, `gitlab_job_log`, `gitlab_list_merge_requests`, `gitlab_get_merge_request`, ⚡`gitlab_trigger_pipeline`, ⚡`gitlab_retry_job` |
| **GitHub** | `github_list_repos`, `github_list_pull_requests`, `github_get_pull_request`, `github_list_workflow_runs`, `github_workflow_run_jobs`, `github_list_issues`, `github_get_issue`, `github_list_commits`, ⚡`github_dispatch_workflow`, ⚡`github_rerun_workflow` |
| **Bitbucket** | `bitbucket_list_repositories`, `bitbucket_list_pull_requests`, `bitbucket_get_pull_request`, `bitbucket_list_pipelines`, `bitbucket_get_pipeline`, ⚡`bitbucket_trigger_pipeline` |
| **Browser** | `browser_navigate`, `browser_screenshot`, `browser_extract` |
| **Pinecone** | `pinecone_list_indexes`, `pinecone_describe_index`, `pinecone_index_stats`, `pinecone_query`, ⚡`pinecone_upsert`, ⚡`pinecone_delete` |
| **Kubecost** | `kubecost_allocation`, `kubecost_assets` |
| **Docker** | `docker_list_containers`, `docker_inspect_container`, `docker_container_logs`, `docker_list_images`, `docker_info`, ⚡`docker_restart_container`, ⚡`docker_stop_container` |
| **Helm** | `helm_list_releases`, `helm_get_release`, `helm_history` |
| **Trivy** | `trivy_scan_image`, `trivy_scan_filesystem`, `trivy_version` |
| **SonarQube** | `sonarqube_list_projects`, `sonarqube_project_measures`, `sonarqube_quality_gate`, `sonarqube_issues` |
| **Federation** | `<name>__<remoteTool>` — every tool of each federated MCP server, namespaced (see below) |

## MCP federation (gateway)

This server can front **other** MCP servers and re-expose their tools through its own
single `/mcp` endpoint, so one client connection reaches your in-house MCP servers
alongside the built-in integrations. Each remote tool is registered locally as
`<name>__<remoteTool>` (e.g. `payments__refund_charge`), preserving its input schema.

Declare the servers with `MCP_FEDERATE`, then a URL (required) and optional bearer
token per name:

```bash
MCP_FEDERATE=payments,search
MCP_FEDERATE_PAYMENTS_URL=https://payments-mcp.internal/mcp
MCP_FEDERATE_PAYMENTS_TOKEN=…                       # sent as Authorization: Bearer …
MCP_FEDERATE_SEARCH_URL=https://search-mcp.internal/mcp
```

Remote servers are contacted over Streamable HTTP the first time a session needs them;
the connections and tool lists are cached and shared across sessions. A remote that is
unreachable is logged and skipped — it never blocks startup. `devops_status` lists the
connected servers as `federation:<name>`.

## Cross-integration investigation

`devops_investigate` is the meta-tool that makes this a gateway rather than 17 separate wrappers. Give it a service name and it correlates signals across **every enabled integration in a single call** — instead of you chaining a dozen tool calls by hand:

- **Kubernetes** — pods matching the service (by name or `app`/`app.kubernetes.io/name` labels), recent warning events involving them, and a tail of the first pod's logs (previous instance if it has restarts)
- **Prometheus / Datadog** — currently firing alerts (or alerting monitors) that mention the service
- **ArgoCD** — the matching application's sync status, health, and last operation
- **GitLab / GitHub** — the most recent pipeline / workflow run for the matching project/repo

```jsonc
{ "service": "checkout", "namespace": "prod", "sinceMinutes": 30 }
```

It returns a single structured object — `{ service, gathered: { kubernetes?, alerts?, argocd?, ci? }, errors: [...] }`. It **only surfaces signals for the integrations that are enabled** on this server (the `queried` field lists which were reached), and each source is gathered independently: if one backend errors it is recorded under `errors` rather than failing the whole investigation, so you always get a partial picture. Output is capped by the same truncation limits as every other tool.

## Example prompts

> "Investigate the `checkout` service — pull together its pods, alerts, ArgoCD sync state and latest CI run."

> "Which ArgoCD apps are out of sync, and what does the resource tree say is unhealthy?"

> "Check consumer lag for group `payments-processor`, and tail the last 10 messages of `payments.events`."

> "Find pods restarting in the `prod` namespace, show their logs, and search Datadog logs for the same service in the last 30 minutes."

> "The checkout dashboard looks wrong — list its panels, run the PromQL behind the error-rate panel, and compare to last hour."

## Smoke test with curl

```bash
TOKEN=your-token

# 1. Initialize (capture the session id from the response headers)
curl -isS -X POST http://localhost:8080/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

SID=<mcp-session-id header value>

# 2. Complete the handshake
curl -sS -X POST http://localhost:8080/mcp \
  -H "Authorization: Bearer $TOKEN" -H "mcp-session-id: $SID" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

# 3. List tools
curl -sS -X POST http://localhost:8080/mcp \
  -H "Authorization: Bearer $TOKEN" -H "mcp-session-id: $SID" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

## Security notes

- **Set `MCP_AUTH_TOKEN` (or `MCP_API_KEYS`).** Without either, the endpoint is open (the server logs a loud warning). See [Auth & governance](#auth--governance) for scoped keys, audit logging, and write dry-run.
- **Run behind TLS** (ingress/reverse proxy). Set `MCP_TRUST_PROXY=true` behind a load balancer.
- **Leave `MCP_ALLOW_WRITES=false`** unless you explicitly need mutations; read tools are designed to be safe (read-only transactions, SCAN instead of KEYS, bounded results).
- **Scope credentials minimally** — e.g. a read-only Postgres role, a Grafana service account with Viewer, a GitLab token with `read_api` when writes are off.
- The LLM client decides which tools to call; treat this server's credentials as the blast radius.

## Observability

The gateway exposes its own health and telemetry on unauthenticated probe endpoints (like `/healthz`) so Kubernetes and Prometheus can reach them without a bearer token:

- `GET /healthz` — liveness. `{ "status": "ok" }`.
- `GET /readyz` — readiness. Reports the server version, active session count, whether writes are allowed, and the count **and names** of configured integrations. This is configured state only — it does **not** perform live network pings to backends.
- `GET /metrics` — Prometheus text exposition (`Content-Type: text/plain; version=0.0.4`). Per-tool call counts, error counts, and a duration histogram (`mcp_tool_duration_seconds`), plus process-wide `mcp_tool_calls_total`, `mcp_tool_errors_total`, and `mcp_uptime_seconds`.

Example scrape config:

```yaml
scrape_configs:
  - job_name: ultimate-devops-mcp
    static_configs:
      - targets: ["ultimate-devops-mcp:8080"]
```

**`/metrics` is intentionally unauthenticated** so a scraper needs no credentials. It exposes only aggregate tool-call counters — never integration credentials or tool payloads. Keep it reachable only from your monitoring network (ingress rule / NetworkPolicy); do not expose it to the public internet.

## Architecture

- `src/index.ts` — Express app, Streamable HTTP session management, auth (bearer + scoped keys), rate limit, health, shutdown
- `src/server.ts` — builds the `McpServer`, registers enabled integrations, and installs the governance guard (scope enforcement, audit, write dry-run)
- `src/audit.ts` — key-identity types, request-scoped context (AsyncLocalStorage), and the structured audit logger
- `src/integrations/*.ts` — one file per system; lazy singleton clients shared across sessions
- `src/federation.ts` — connects to other MCP servers and registers namespaced proxy tools
- Adding an integration = one new file exporting `register<Name>(server, config)` + a config block. PRs welcome.

## Roadmap

GitHub, Jenkins, AWS CloudWatch, Sentry, PagerDuty, RabbitMQ, ClickHouse, Vault — the registry pattern makes each one a single new file.

## License

[MIT](LICENSE)
