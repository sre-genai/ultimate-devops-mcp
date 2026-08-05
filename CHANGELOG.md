# Changelog

## 1.1.0 — Gateway v2

Turns the server from an integration aggregator into a full gateway. All changes
are additive and backward-compatible: existing single-instance env vars and the
`MCP_AUTH_TOKEN` keep working unchanged.

### Added
- **MCP federation** — front other Streamable-HTTP MCP servers and re-expose their
  tools through this server's `/mcp` endpoint, namespaced as `<name>__<tool>`.
  Unreachable servers are skipped at startup and never block boot.
  Config: `MCP_FEDERATE` + per-name `_URL`/`_TOKEN`.
- **`devops_investigate`** — a cross-integration meta-tool that correlates a single
  service's signals across every enabled integration in one call (Kubernetes pods/
  events/logs, Prometheus + Datadog alerts, ArgoCD status, GitLab/GitHub CI). Each
  source is gathered independently, so a partial picture is always returned.
- **Scoped API keys & governance** — `MCP_API_KEYS` maps token secrets to scopes
  (per-key tool allowlist + write permission). Every tool call is audit-logged
  (tool, key, outcome, duration — no arguments or secrets). `MCP_WRITE_DRYRUN`
  makes write tools return a preview instead of executing.
- **Outbound egress proxy** — set `HTTP_PROXY`/`HTTPS_PROXY` (with `NO_PROXY`) to
  route the HTTP/REST integrations through a corporate proxy. Database drivers,
  Elasticsearch, Kubernetes and Playwright use their own transports.
- **Multi-instance for all HTTP integrations** — Datadog, Prometheus, ArgoCD,
  GitLab, GitHub, Bitbucket and Elasticsearch now support the same `instance`
  parameter as Grafana and Jira (`<NAME>_INSTANCES` + per-name env, optional
  `<NAME>_PRIMARY`; bare vars register as `default`).
- **New integrations** — PagerDuty, Sentry, Jenkins, Slack, and Vault (22 total).
- **Prometheus `/metrics`** — per-tool call counts, error counts, and a duration
  histogram, in Prometheus text format. Unauthenticated for scrapers; keep it
  behind your network policy.

### Changed
- `/readyz` reports an integration **count**, not names, so an unauthenticated
  caller can't enumerate the configured attack surface. The authenticated
  `devops_status` tool still lists names.

## 1.0.0

Initial release: one authenticated Streamable-HTTP MCP endpoint fronting 17
DevOps integrations (Postgres, MongoDB, Neo4j, Elasticsearch, Kafka, Redis,
Kubernetes, Grafana, Datadog, Prometheus, ArgoCD, GitLab, GitHub, Bitbucket,
Jira, Temporal, Playwright), read-only by default with write tools gated behind
`MCP_ALLOW_WRITES`.
