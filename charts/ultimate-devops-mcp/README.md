# ultimate-devops-mcp Helm chart

Deploys the [Ultimate DevOps MCP server](https://github.com/sre-genai/ultimate-devops-mcp)
to Kubernetes: one authenticated Streamable-HTTP `/mcp` endpoint that gives AI
clients (Claude Code, Cursor, …) read-only-by-default operational access to your
DevOps stack.

## Quick start

```bash
# 1. Create the auth token secret (recommended over putting it in values)
kubectl create secret generic udm-secrets \
  --from-literal=MCP_AUTH_TOKEN="$(openssl rand -hex 32)" \
  --from-literal=POSTGRES_URL="postgres://user:pass@pg:5432/app" \
  --from-literal=DATADOG_API_KEY="..." -n devops

# 2. Install
helm install udm ./charts/ultimate-devops-mcp -n devops --create-namespace \
  --set existingSecret=udm-secrets \
  --set image.tag=1.0.0 \
  --set-string config.PROMETHEUS_URL=http://prometheus:9090
```

Then connect Claude Code (see `helm status udm` output / NOTES):

```bash
claude mcp add --transport http ultimate-devops https://<host>/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

## Creating the Secret (step by step)

Each Secret **key must be exactly the env-var name** the app expects
(`MCP_AUTH_TOKEN`, `POSTGRES_URL`, …). The chart injects the whole Secret via
`envFrom`, so anything you add appears as a container env var.

### Easiest: from an env file (`--from-env-file`)

```bash
# 1. Copy the template and fill in real values (only the integrations you use)
cp charts/ultimate-devops-mcp/udm.env.example udm.env
$EDITOR udm.env

# 2. Generate a strong auth token and put it in MCP_AUTH_TOKEN
openssl rand -hex 32          # paste into MCP_AUTH_TOKEN= in udm.env

# 3. Create the Secret (same namespace you install the chart into)
kubectl create namespace devops --dry-run=client -o yaml | kubectl apply -f -
kubectl create secret generic udm-secrets -n devops --from-env-file=udm.env

# 4. Install the chart pointed at it
helm install udm ./charts/ultimate-devops-mcp -n devops \
  --set existingSecret=udm-secrets

# 5. Clean up the plaintext file — never commit it
shred -u udm.env    # or: rm udm.env
```

> `udm.env.example` in this chart lists every supported variable, grouped by
> integration.

### Alternative: from literals (a few values)

```bash
kubectl create secret generic udm-secrets -n devops \
  --from-literal=MCP_AUTH_TOKEN="$(openssl rand -hex 32)" \
  --from-literal=POSTGRES_URL="postgres://user:pass@pg:5432/app" \
  --from-literal=DATADOG_API_KEY="..."
```

### Alternative: let the chart create it

Put the values in `secrets:` in your Helm values and the chart creates the
Secret for you (fine if that file is SOPS/sealed):

```yaml
secrets:
  MCP_AUTH_TOKEN: "…"
  POSTGRES_URL: "postgres://user:pass@pg:5432/app"
```

### GitOps (encrypted in git)

Don't commit plaintext. Seal it and commit the sealed form:

```bash
kubectl create secret generic udm-secrets -n devops --from-env-file=udm.env \
  --dry-run=client -o yaml | kubeseal -o yaml > udm-sealed.yaml   # commit this
```

(Or use SOPS / External Secrets Operator / Vault — all pair with
`existingSecret`.)

### Verify / rotate

```bash
# list keys (not values)
kubectl get secret udm-secrets -n devops -o jsonpath='{.data}' | jq 'keys'
# rotate a value, then restart to pick it up
kubectl create secret generic udm-secrets -n devops --from-env-file=udm.env \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl rollout restart deploy/udm-ultimate-devops-mcp -n devops
```

## How config is split

| Kind | Where | Rendered into |
|---|---|---|
| Non-secret (URLs, flags, hosts) | `config.*` | ConfigMap → env |
| Secret (tokens, passwords) | `secrets.*` **or** `existingSecret` | Secret → env |

An integration's tools are registered only when its env vars are present, so you
enable an integration simply by supplying its config/secret values.

## Security defaults (baked in)

- **Auth is mandatory** — the chart refuses to render without an `MCP_AUTH_TOKEN`
  source (set `insecureAllowNoAuth=true` to override; not recommended). The app
  itself also refuses to boot exposed without one.
- `MCP_TRUST_PROXY=true` by default so rate-limiting keys on the real client IP
  behind the Istio gateway / ingress.
- Read-only by default (`MCP_ALLOW_WRITES=false`).
- Non-root (uid 1000), `readOnlyRootFilesystem`, all caps dropped, seccomp
  `RuntimeDefault`, writable `/tmp` emptyDir only.
- Optional `NetworkPolicy` (default-deny ingress except from the mesh namespace).

## Exposure

Pick **one**:

- **Istio** (`istio.enabled=true`) → creates a `VirtualService` routing
  `/mcp`, `/healthz`, `/readyz` to the service. Note: the DNS-rebinding guard
  checks the `Origin` header, **not** the VirtualService host — non-browser MCP
  clients send no Origin and pass. For browser clients set
  `config.MCP_ALLOWED_ORIGINS`.
- **Ingress** (`ingress.enabled=true`) → a plain `networking.k8s.io/v1` Ingress.
- **Neither** → ClusterIP only; reach it via `kubectl port-forward`.

## Kubernetes integration (in-cluster)

To use the `k8s_*` tools against the cluster the server runs in:

```yaml
config:
  K8S_ENABLED: "true"
rbac:
  create: true          # read-only ClusterRole + binding
  allowWrites: false     # set true (with MCP_ALLOW_WRITES=true) for scale/restart/delete
```

## Key values

| Key | Default | Notes |
|---|---|---|
| `image.repository` / `image.tag` | `ghcr.io/sre-genai/ultimate-devops-mcp` / appVersion | Use the `WITH_BROWSER` image variant for Playwright tools |
| `existingSecret` | `""` | Name of a pre-created Secret (keys = env var names) |
| `secrets` | `{}` | Chart-managed Secret (alternative to existingSecret) |
| `config.MCP_ALLOW_WRITES` | `"false"` | Enable mutating tools |
| `config.MCP_TRUST_PROXY` | `"true"` | Trust X-Forwarded-For behind a proxy |
| `istio.enabled` / `ingress.enabled` | `false` | External routing |
| `rbac.create` | `false` | RBAC for in-cluster k8s integration |
| `autoscaling.enabled` | `false` | HPA v2 |
| `podDisruptionBudget.enabled` | `false` | PDB |
| `networkPolicy.enabled` | `false` | Default-deny ingress |

See [`values.yaml`](./values.yaml) for the full list and the complete set of
supported integration env vars.
