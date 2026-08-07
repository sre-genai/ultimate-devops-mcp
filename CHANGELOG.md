# Changelog

## 1.2.0 — Six new integrations

Adds six integrations (22 → 28), extending coverage into vector databases,
Kubernetes cost, the local Docker daemon, Helm release state, and security
scanning. All are read-only by default; write tools appear only when
`MCP_ALLOW_WRITES=true`, and each enables automatically when its env vars are set.

### Added
- **Pinecone** — vector database. `pinecone_list_indexes`, `pinecone_describe_index`,
  `pinecone_index_stats`, `pinecone_query`, plus `pinecone_upsert` / `pinecone_delete`
  (writes). Config: `PINECONE_API_KEY`.
- **Kubecost** — Kubernetes cost, read-only. `kubecost_allocation` (workload cost by
  namespace/controller/label) and `kubecost_assets` (cloud infra cost). Config: `KUBECOST_URL`.
- **Docker engine** — talks to the local daemon over its unix socket (or a plain-HTTP
  `tcp://` `DOCKER_HOST`). `docker_list_containers`, `docker_inspect_container`,
  `docker_container_logs` (stream demuxed), `docker_list_images`, `docker_info`, plus
  `docker_restart_container` / `docker_stop_container` (writes). Config: `DOCKER_ENABLED` / `DOCKER_HOST`.
- **Helm releases** — read-only, decoded straight from the Helm 3 release Secrets via the
  Kubernetes API (no `helm` binary needed). `helm_list_releases`, `helm_get_release`
  (summary/values/manifest/notes), `helm_history`. Config: `HELM_ENABLED`.
- **Trivy** — vulnerability scanning via the local `trivy` binary. `trivy_scan_image`,
  `trivy_scan_filesystem`, `trivy_version`; targets are passed as non-shell args and
  bounded by a timeout. Config: `TRIVY_ENABLED` (+ optional `TRIVY_BIN`).
- **SonarQube** — code quality & security, read-only. `sonarqube_list_projects`,
  `sonarqube_project_measures`, `sonarqube_quality_gate`, `sonarqube_issues`.
  Config: `SONARQUBE_URL` + `SONARQUBE_TOKEN`.

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
