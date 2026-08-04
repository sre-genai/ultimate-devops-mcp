# Ultimate DevOps MCP

**One MCP server for your entire DevOps stack.** Give Claude, Cursor, or any MCP client operational access to Postgres, MongoDB, Neo4j, Elasticsearch, Kafka, Redis, Kubernetes, Grafana, Datadog, Prometheus, ArgoCD, GitLab, GitHub, Bitbucket and a headless browser — through a single production-ready endpoint.

- **Latest MCP transport** — Streamable HTTP (spec `2025-03-26`+), stateful sessions, SSE streaming
- **13 integrations, ~60 tools** — each activates automatically when its env vars are set
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

**Audit logging** — every tool invocation emits one structured pino log line under the `audit` key: `{ tool, write, key, sessionId, outcome, reason?, durationMs, ts }` where `outcome` is `allowed` / `denied` / `dry-run` / `error`. Records carry no tool arguments and no secrets — only who called what, when, and how it resolved. Ship stdout to your log pipeline to retain the trail.

**Write dry-run** — set `MCP_WRITE_DRYRUN=true` and every write/mutating tool returns a preview object (`{ dryRun: true, tool, note, args }`) describing what *would* happen, without touching any backend. Read tools are unaffected. Use it to rehearse a change set or to run an agent against production with writes armed but disarmed.

Enforcement happens once, centrally, at tool dispatch (`installGovernance` in `src/server.ts` wraps `registerTool`), so it applies uniformly to every current and future integration over both HTTP and stdio.

**Multiple instances of one system.** The HTTP integrations — Grafana, Datadog, Prometheus, ArgoCD, GitLab, GitHub, Bitbucket, Jira — can each target several backends (e.g. prod + non-prod). Declare `<NAME>_INSTANCES=a,b` and give each name its own vars (`GRAFANA_PROD_URL`/`GRAFANA_PROD_TOKEN`, …); every tool then accepts an optional `instance` argument. `<NAME>_PRIMARY` (or the first listed name) is the default when a call omits it. The single-instance vars keep working unchanged and register as the `default` instance. See [.env.example](.env.example) for per-integration examples.

**Outbound egress proxy.** Set `HTTP_PROXY`/`HTTPS_PROXY` (with optional `NO_PROXY`) and the server routes all outbound HTTP/REST calls — Grafana, Datadog, Prometheus, ArgoCD, GitLab, GitHub, Bitbucket, Jira — through the proxy. The proxy URL is never logged. **Not covered:** the database drivers (Postgres/MongoDB/Neo4j/Redis), Elasticsearch, Kubernetes and Playwright use their own transports and bypass this proxy.

## Tool catalog

Write tools (⚡) are registered **only** when `MCP_ALLOW_WRITES=true`.

| Integration | Tools |
|---|---|
| **Meta** | `devops_status` |
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

## Example prompts

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
