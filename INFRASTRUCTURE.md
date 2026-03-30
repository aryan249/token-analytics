# System Architecture — Technical Deep Dive

Complete reference for every component, chart, pipeline, and infrastructure resource.

---

## 1. Helm Charts

### 1a. token-analytics (Application Chart)

**Location:** `helm/token-analytics/`
**What it deploys:** The entire blockchain indexer + analytics platform

| Template | K8s Resource | What it does |
|---|---|---|
| `deployment-api.yaml` | Deployment (2-6 replicas) | REST API + WebSocket gateway. Serves `/tokens`, `/users`, `/stats`, `/health`, `/metrics`, `/ws`. HPA scales on CPU 70% / memory 80%. Rolling update with `maxSurge=0` (no extra pods during update). |
| `deployment-indexer.yaml` | StatefulSet (1 replica) | Connects to Alchemy WebSocket, fetches Base L2 blocks, decodes events, publishes to Redis streams. Singleton — two indexers would create checkpoint conflicts. |
| `deployment-processors.yaml` | 6 StatefulSets (1 replica each) | Trade, Candle, Token, Fees, Position, Price processors. Each reads from a Redis stream consumer group and writes to Postgres. StatefulSet gives stable pod names for consumer group identity. |
| `service-api.yaml` | ClusterIP Service | Exposes API on port 80 → 3000. Named port `http` for Prometheus service discovery. Also creates headless service for indexer. |
| `ingress.yaml` | ALB Ingress | Internet-facing load balancer with sticky sessions (app cookie) for WebSocket. HTTPS-ready — set `certificateArn` to enable TLS. |
| `hpa.yaml` | HorizontalPodAutoscaler | API only. Scales 2→6 pods. Scale-up: 1 pod/60s. Scale-down: 1 pod/120s (prevents flapping). |
| `pdb.yaml` | 8 PodDisruptionBudgets | API + indexer: `minAvailable: 1`. All 6 processors: `maxUnavailable: 1`. Prevents simultaneous eviction during node drain. |
| `network-policy.yaml` | 3 NetworkPolicies | API: ingress only from kube-system (ALB controller) + same namespace. Processors/indexer: zero ingress. All pods: egress restricted to DNS (53), Redis (6379), Postgres (5432), HTTPS (443). |
| `resource-quota.yaml` | ResourceQuota | Namespace cap: 4 CPU request, 8 CPU limit, 4Gi/8Gi memory, 30 pods max. |
| `configmap.yaml` | ConfigMap | Non-secret env vars: CHAIN_ID, BATCH_SIZE, LOG_LEVEL, NODE_ENV, API_PORT. |
| `secret.yaml` | ServiceAccount + SecretStore + ExternalSecret | ESO pulls POSTGRES_URL, REDIS_URL, ALCHEMY_WS_URL, JWT_SECRET from AWS Secrets Manager every 15 minutes via IRSA. |
| `_helpers.tpl` | Template helpers | Shared security context (non-root uid 1001, read-only FS, drop ALL caps, seccomp RuntimeDefault), anti-affinity, topology spread, graceful shutdown (preStop sleep 15s), image tag, env injection. |

**Pod Security (applied to every container):**
```yaml
runAsNonRoot: true
runAsUser: 1001
readOnlyRootFilesystem: true
allowPrivilegeEscalation: false
capabilities: { drop: ["ALL"] }
seccompProfile: { type: RuntimeDefault }
terminationGracePeriodSeconds: 60  # (90 for indexer)
preStop: sleep 15  # ALB drains connections before SIGTERM
```

**Probes:**
| Component | Startup | Readiness | Liveness |
|---|---|---|---|
| API | GET /health (50s max) | GET /health every 10s (checks Redis + PG) | GET /health every 20s |
| Indexer | exec node (120s max) | File /tmp/indexer-ready exists | File /tmp/indexer-alive < 2min old |
| Processors | exec node (60s max) | File /tmp/processor-ready exists | File /tmp/processor-alive < 2min old |

---

### 1b. observability (Umbrella Chart)

**Location:** `helm/observability/`
**What it deploys:** Monitoring stack — 4 sub-charts in one install

| Sub-chart | Version | Pods | Purpose |
|---|---|---|---|
| `prometheus` | 25.x | 1 (server + configmap-reload sidecar) | Scrapes `/metrics` from API pods every 15s. 3-day retention, no persistent storage. |
| `grafana` | 8.x | 1 | Dashboards + Loki log viewer. Pre-built "Token Analytics — Overview" dashboard with 8 panels. |
| `loki` | 6.x | 1 (single-binary mode) | Log aggregation. 72h retention, filesystem storage via emptyDir. TSDB v13 schema. |
| `promtail` | 6.x | 3 (DaemonSet, one per node) | Ships pod logs to Loki. Parses Pino JSON format. |

**Disabled components** (save resources on free-tier nodes):
- AlertManager, Pushgateway, kube-state-metrics, node-exporter
- Loki gateway, read/write/backend replicas, chunks-cache, results-cache, canary

**Alerting rules (in Prometheus):**
| Alert | Condition | Severity |
|---|---|---|
| HighErrorRate | `rate(errors_total[5m]) > 0.1` for 5min | warning |
| DeadLetterQueueGrowing | `increase(dead_letter_total[1h]) > 0` | critical |
| HighAPILatency | API P95 > 2 seconds for 5min | warning |
| HealthCheckDown | API target down for 2min | critical |

**Grafana Dashboard Panels:**
1. Events Processed / sec (by processor + status)
2. Event Processing Latency P95 (by processor)
3. HTTP Request Duration P95 (by route)
4. HTTP Requests / sec (by route + status code)
5. Cache Hit Rate (percentage)
6. WebSocket Clients (gauge)
7. Dead Letter Queue (count)
8. Errors / sec (by source + type)

**Access:**
```bash
# Grafana
kubectl port-forward svc/observability-grafana 3001:80 -n monitoring
# http://localhost:3001 — admin / token-analytics-grafana

# Prometheus
kubectl port-forward svc/observability-prometheus-server 9090:80 -n monitoring
# http://localhost:9090
```

---

## 2. Terraform Infrastructure

**Location:** `terraform/`
**State:** S3 bucket `token-analytics-tfstate` with DynamoDB lock table `terraform-locks`

| File | Resources | What it creates |
|---|---|---|
| `main.tf` | Providers | AWS (ap-south-1), Kubernetes, Helm providers. All authenticate via EKS endpoint. |
| `variables.tf` | Variables | Region, instance types, node counts, passwords. EKS: 3 nodes desired, 4 max. |
| `vpc.tf` | VPC, Subnets, NAT, IGW | 10.0.0.0/16 VPC. 2 public subnets (ALB, NAT, runner) + 2 private subnets (EKS, RDS, Redis). Single NAT gateway. |
| `eks.tf` | EKS cluster, Node group | Kubernetes v1.29. 3× t3.small worker nodes across 2 AZs. OIDC provider for IRSA. |
| `rds.tf` | RDS PostgreSQL | db.t3.micro, v16.6. Private subnet, SSL required. 7-day backup retention. Final snapshot required on destroy. |
| `elasticache.tf` | Redis cluster + Parameter group | cache.t3.micro, v7.1. AOF persistence (appendonly=yes, fsync=everysec). Max 1s data loss on crash. |
| `ecr.tf` | ECR repository | Private registry. Image scanning on push. Lifecycle: keep last 10 images. |
| `iam.tf` | 5 IAM roles | EKS cluster, EKS nodes, GitHub Actions (OIDC), ESO (IRSA), Runner (ECR + EKS + S3/DynamoDB for tfstate). |
| `secrets-manager.tf` | Secret + ESO IAM | Stores POSTGRES_URL, REDIS_URL, ALCHEMY_WS_URL, JWT_SECRET. 7-day recovery window. |
| `ec2-runner.tf` | EC2 instance + CloudWatch | t3.small self-hosted GitHub Actions runner. Watchdog cron (5min), docker cleanup cron (daily 3AM). CloudWatch alarms: status check (auto-recover), CPU idle, disk full. |
| `argocd.tf` | Argo CD Helm release | Installs Argo CD v7.7.8 in argocd namespace. 180s reconciliation. Notifications enabled. (NOT YET PUSHED) |
| `vpc-peering.tf` | VPC peering connections | Cross-region peering for multi-region Redis fan-out. Routes + SG rules for port 6379 only. Configurable via `var.peer_regions`. |
| `outputs.tf` | Outputs | EKS endpoint, RDS hostname, Redis endpoint, runner IP, peering IDs. |
| `runner-init.sh` | User data script | Installs Docker, Node 20, kubectl, Helm, AWS CLI, GitHub runner agent. Configures as systemd service. |
| `modules/vpc-peer-acceptor/` | Reusable module | Run in peer region to accept peering connection + add reverse routes + SG rules. |

---

## 3. CI/CD Pipeline

**Location:** `.github/workflows/`

### ci.yml — Application Pipeline

```
Trigger: push to main, staging, feat/*, fix/*

┌─────────────────────────────────────────────────┐
│  Job 1: lint-build-test                          │
│                                                  │
│  1. Checkout                                     │
│  2. Setup Node 20 + npm cache                    │
│  3. npm ci                                       │
│  4. ESLint (soft fail)                           │
│  5. TypeScript check (--skipLibCheck, hard fail) │
│  6. Unit tests — 35 tests (hard fail)            │
│  7. npm audit — dependency CVEs (soft fail)      │
└──────────────────┬──────────────────────────────┘
                   │ (only on main/staging/feat/*/fix/*)
                   ▼
┌─────────────────────────────────────────────────┐
│  Job 2: docker-build-push                        │
│                                                  │
│  1. Checkout                                     │
│  2. ECR login (3 retries, 15s delay)             │
│  3. Docker build (pinned node:20.18.1-alpine3.21)│
│  4. Trivy image scan — HIGH/CRITICAL (soft fail) │
│  5. Push to ECR (commit SHA tag + latest)        │
│  6. Update values.yaml with new tag              │
│  7. Git commit + push (rebase retry on conflict) │
└──────────────────┬──────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────┐
│  Job 3: deploy                                   │
│                                                  │
│  1. Checkout + git pull latest                   │
│  2. Configure kubectl for EKS                    │
│  3. Install ESO (if not present)                 │
│  4. Install observability umbrella chart         │
│  5. Auto-cleanup stuck Helm releases             │
│  6. helm upgrade --install token-analytics       │
│  7. Wait for API rollout (300s, soft fail)       │
│  8. Verify: pods, HPA, PDBs, network policies   │
└─────────────────────────────────────────────────┘
```

### infra.yml — Infrastructure Pipeline

```
Trigger: terraform/ path changes on main, or manual dispatch

1. Terraform init
2. Format check (hard fail)
3. Validate
4. Fetch secrets from AWS Secrets Manager → TF_VAR_*
5. Terraform plan
6. Comment plan on PR (if PR)
7. Terraform apply (on merge to main or manual)
8. Terraform destroy (manual dispatch only)
```

---

## 4. Argo CD (Ready, Not Yet Deployed)

**Files:** `helm/token-analytics/argocd/application.yaml`, `terraform/argocd.tf` (local only)

### What it will do:

```
Current (push-based):
  CI builds → CI runs helm upgrade → pods updated

With Argo CD (pull-based):
  CI builds → CI updates image tag in git → Argo CD detects → Argo CD syncs
```

### ApplicationSet (defines 2 environments):

| Environment | Namespace | Watches Branch | Values File |
|---|---|---|---|
| Staging | token-analytics-staging | `staging` | values-staging.yaml |
| Production | token-analytics | `main` | values-production.yaml |

### Features:
- **Auto-sync:** Detects git changes every 3 minutes
- **Self-heal:** Reverts manual `kubectl edit` changes automatically
- **Drift detection:** Compares live state vs git state
- **Audit trail:** Every sync recorded with git SHA + diff
- **Rollback:** `argocd app rollback token-analytics-production <revision>`

### Promotion workflow:
```
Developer pushes to staging branch
  → CI builds image, updates values.yaml
  → Argo CD syncs staging namespace

QA verifies staging

Developer creates PR: staging → main
  → Code review, approval, merge
  → Argo CD syncs production namespace
```

---

## 5. Docker Image

**File:** `Dockerfile`

```
Stage 1 (builder):
  FROM node:20.18.1-alpine3.21    ← pinned version
  npm ci                           ← all deps (dev included)
  tsc → dist/                      ← compile TypeScript
  npm prune --omit=dev             ← remove dev deps

Stage 2 (production):
  FROM node:20.18.1-alpine3.21
  COPY node_modules from builder   ← no second npm install (no network)
  COPY dist/ from builder
  USER appuser (uid 1001)          ← non-root
  HEALTHCHECK                      ← container-level health check
  CMD ["node", "dist/indexer/main.js"]
```

**Image size:** ~65MB
**No network calls in production stage** — avoids npm registry timeouts on slow runners.

---

## 6. Kubernetes Cluster Layout

### Nodes (3× t3.small, 2 AZs)

```
Node-1 (ap-south-1a):           Node-2 (ap-south-1b):           Node-3 (ap-south-1b):
  System:                         System:                         System:
    aws-node                       aws-node                        aws-node
    kube-proxy                     kube-proxy                      kube-proxy
    coredns ×2                     alb-controller
    alb-controller
    metrics-server
  ESO:                            ESO:
    webhook                        main + cert-controller
  App:                            App:                            Monitoring:
    indexer                         api ×2                          prometheus-server
    processor-position              processor-candle                grafana
    processor-token                 processor-fees                  loki
                                    processor-price                 promtail ×3 (DaemonSet)
                                    processor-trade
```

### Namespaces

| Namespace | Pods | Purpose |
|---|---|---|
| `token-analytics` | 10 | Application workloads |
| `monitoring` | 6 | Prometheus + Grafana + Loki + Promtail |
| `kube-system` | 7 | EKS system (DNS, proxy, CNI, ALB, metrics) |
| `external-secrets` | 3 | ESO operator |
| `argocd` | 0 (not yet deployed) | GitOps controller |

---

## 7. Data Flow

```
Base Blockchain → Alchemy WSS → Indexer
  │
  ├─ Redis Streams (pipelined batch, 1 round trip per block)
  │    stream:swap     → Trade processor → trades table + UI Pub/Sub
  │    stream:swap     → Candle processor → Redis Lua OHLCV + PG batch
  │    stream:meta     → Token processor → token_registry + RPC metadata
  │    stream:fees     → Fee processor → fee_distributions
  │    stream:transfer → Position processor → holder_balances (transaction)
  │    stream:price    → Price processor → ETH/USD in Redis
  │
  ├─ Fast-path (scanner → UI directly, no processor)
  │    pubsub:ui:candles → Gateway → WebSocket → Browser charts
  │
  └─ Publish ledger (Postgres) → gap detection on restart

Gateway (Pub/Sub fan-out to all API pods):
  pubsub:ui:trades   → activity + priceUpdate
  pubsub:ui:candles  → candle tips
  pubsub:ui:fees     → fee updates
  pubsub:ui:rate     → ETH/USD changes
  pubsub:ui:meta     → new token events
```

---

## 8. Security Layers

| Layer | What | How |
|---|---|---|
| Container | Non-root, read-only FS, no capabilities, seccomp | Helm _helpers.tpl |
| Pod | Graceful shutdown, preStop drain | terminationGracePeriodSeconds + lifecycle |
| Network | Ingress restricted to ALB, egress to 4 ports only | NetworkPolicy |
| Auth | JWT + wallet signature, wallet ownership check | API auth middleware |
| Headers | CSP, X-Frame-Options, nosniff, XSS-Protection | API onSend hook |
| Secrets | AWS Secrets Manager, IRSA, 7-day recovery | ESO + ExternalSecret |
| CI | OIDC (no stored AWS keys), Trivy scan, npm audit | GitHub Actions |
| Infra | Private subnets, security groups, encrypted RDS | Terraform |
| Docker | Pinned image, multi-stage, HEALTHCHECK | Dockerfile |

---

## 9. Resilience

| Mechanism | What it does |
|---|---|
| Dead-letter queue | Failed events (5+ retries) persisted to Postgres with full payload |
| Publish ledger | Tracks every event published to Redis. On startup, verifies last 100 blocks exist, replays gaps. |
| Redis AOF | Append-only file, fsync every second. Max 1s data loss on Redis crash. |
| Idempotent writes | All DB writes use ON CONFLICT. Safe to replay events. |
| Transactions | Position + trade processors wrap related writes in BEGIN/COMMIT. |
| Cache persistence | makerCache, pendingPoolState, tokenMetaMap stored in Redis HASH, restored on startup. |
| Reorg detection | Parent hash comparison. Cascade delete + checkpoint reset + re-process. |
| Claim loop | Reclaims stuck messages after 30s idle. Auto-restarts on crash. |
| PDBs | Prevents simultaneous eviction during node drain. |
| HPA | API auto-scales 2→6 pods on CPU/memory pressure. |
