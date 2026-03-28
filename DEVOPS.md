# DevOps & SRE Practices — Complete Reference

Everything we built, why it exists, and how it works.

---

## 1. CI/CD Pipeline Flow

```
Developer pushes code
        │
        ▼
┌─────────────────────────────────────────────────┐
│  JOB 1: lint-build-test                          │
│                                                  │
│  npm ci                                          │
│    ▼                                             │
│  ESLint (code quality)                           │
│    ▼                                             │
│  TypeScript type check (tsc --noEmit)            │
│    ▼                                             │
│  Unit tests (35 tests — math, bucketing, BigInt) │
│    ▼                                             │
│  npm audit (dependency CVE check)                │
└──────────────────┬──────────────────────────────┘
                   │ (only on main/staging/feat branches)
                   ▼
┌─────────────────────────────────────────────────┐
│  JOB 2: docker-build-push                        │
│                                                  │
│  ECR login (IAM credentials via instance role)   │
│    ▼                                             │
│  Docker build (pinned node:20.18.1-alpine3.21)   │
│    ▼                                             │
│  Trivy image scan (HIGH + CRITICAL CVEs)         │
│    ▼                                             │
│  Push to ECR (tagged with git SHA + latest)      │
│    ▼                                             │
│  Update values.yaml with new image tag           │
│    ▼                                             │
│  git commit + push (with rebase retry for races) │
└──────────────────────────────────────────────────┘
                   │
                   ▼
         Argo CD detects git change
         → auto-syncs to cluster
```

### What we fixed in CI

- **Added ESLint** — config existed but never ran in pipeline
- **Added `npm audit`** — catches known CVEs in dependencies
- **Added Trivy image scan** — scans container image for HIGH/CRITICAL vulnerabilities before pushing to ECR
- **Fixed git push race condition** — concurrent CI runs would silently fail on `git push`. Now retries with `git pull --rebase`
- **Added unit tests** — 35 tests run on every push
- **Pinned Docker base image** — was floating `node:20-alpine`, now `node:20.18.1-alpine3.21` for reproducible builds

---

## 2. Kubernetes Network Policy (Internal Traffic Flow)

```
                    INTERNET
                       │
                       ▼
              ┌────────────────┐
              │   ALB (HTTPS)  │
              │   port 443     │
              └───────┬────────┘
                      │
        ──────────────┼──── EKS Cluster ──────────────
        │             │                               │
        │    ┌────────▼─────────┐                     │
        │    │  kube-system NS  │                     │
        │    │  (ALB controller)│                     │
        │    └────────┬─────────┘                     │
        │             │                               │
        │    ─────────┼──── token-analytics NS ─────  │
        │    │        │                            │  │
        │    │   ┌────▼──────┐                     │  │
        │    │   │ API Pods  │◄─── ONLY ingress    │  │
        │    │   │ port 3000 │     allowed from    │  │
        │    │   └─┬──┬──┬──┘     kube-system NS   │  │
        │    │     │  │  │        + same namespace  │  │
        │    │     │  │  │                          │  │
        │    │     │  │  └────────────────┐         │  │
        │    │     │  │                   │         │  │
        │    │   ┌─▼──▼───┐  ┌───────────▼──────┐  │  │
        │    │   │Indexer  │  │   Processors     │  │  │
        │    │   │         │  │ trade,candle,    │  │  │
        │    │   │ INGRESS │  │ token,fees,      │  │  │
        │    │   │ DENIED  │  │ position,price   │  │  │
        │    │   │         │  │                  │  │  │
        │    │   │         │  │ INGRESS DENIED   │  │  │
        │    │   └─┬──┬───┘  └──┬──┬────────────┘  │  │
        │    │     │  │         │  │                │  │
        │    ──────┼──┼─────────┼──┼────────────────  │
        │          │  │         │  │                   │
        │   ┌──────▼──▼─────────▼──▼───────────┐      │
        │   │      EGRESS RULES (all pods)     │      │
        │   │                                   │      │
        │   │  Allowed outbound only:           │      │
        │   │    port 53   → DNS (UDP+TCP)      │      │
        │   │    port 6379 → Redis              │      │
        │   │    port 5432 → Postgres           │      │
        │   │    port 443  → HTTPS (Alchemy,    │      │
        │   │               ECR, Secrets Mgr)   │      │
        │   │                                   │      │
        │   │  Everything else BLOCKED           │      │
        │   └──────┬──┬─────────┬──────────────┘      │
        │          │  │         │                      │
        ───────────┼──┼─────────┼──────────────────────
                   │  │         │
              ┌────▼──▼───┐  ┌─▼──────────┐
              │  Redis    │  │ PostgreSQL  │
              │  (6379)   │  │ (5432)      │
              │  private  │  │ private     │
              │  subnet   │  │ subnet      │
              └───────────┘  └────────────┘
```

### Network policies explained

**API ingress policy:**
- Only accepts traffic from `kube-system` namespace (where ALB ingress controller lives)
- Also allows traffic from same namespace (inter-pod health checks)
- Everything else is denied — no other namespace, no external IP can reach API pods directly

**Processor + indexer ingress policy:**
- Zero ingress allowed. They only make outbound connections to Redis and Postgres.
- Even pods in the same namespace can't reach them.

**Egress policy (all pods):**
- Port 53 (DNS) — required for service discovery
- Port 6379 (Redis) — event streams, cache, pub/sub
- Port 5432 (Postgres) — database reads/writes
- Port 443 (HTTPS) — Alchemy RPC, ECR image pulls, Secrets Manager
- Everything else blocked — pods can't reach arbitrary internet services

---

## 3. Security Practices — Defense in Depth

### Layer 1: Container Level

```yaml
# Every container runs with:
securityContext:
  runAsNonRoot: true              # Can't run as root
  runAsUser: 1001                 # Explicit non-root UID
  runAsGroup: 1001
  allowPrivilegeEscalation: false # Can't sudo/setuid
  readOnlyRootFilesystem: true    # Can't write to disk (except /tmp)
  capabilities:
    drop: ["ALL"]                 # No Linux capabilities
  seccompProfile:
    type: RuntimeDefault          # Restrict syscalls to safe set
```

**What this prevents:**
- Container escape via privilege escalation
- Malicious binary execution (read-only filesystem)
- Kernel exploitation via dangerous syscalls (seccomp)
- Writing to sensitive paths (only /tmp writable via emptyDir)

### Layer 2: Pod Level

```yaml
terminationGracePeriodSeconds: 60  # Clean shutdown window
lifecycle:
  preStop:
    exec:
      command: ["/bin/sh", "-c", "sleep 15"]  # ALB drains connections
```

**What this prevents:**
- In-flight HTTP requests killed during rolling updates
- WebSocket connections dropped without cleanup
- Processors losing mid-processing events

**How it works:**
1. K8s sends preStop → pod sleeps 15s
2. During sleep, ALB stops sending new traffic (readiness probe fails)
3. Existing connections drain naturally
4. After 15s, K8s sends SIGTERM → application graceful shutdown
5. Application closes Redis, Postgres, HTTP server
6. If still running after 60s total → SIGKILL

### Layer 3: Network Level

- Private subnets for RDS + Redis (no internet-facing routes)
- Security groups: EKS → RDS (5432), EKS → Redis (6379), ALB → EKS (3000)
- Network policies restrict pod-to-pod and pod-to-external (see section 2)
- NAT gateway for outbound-only internet from private subnets

### Layer 4: Authentication & Authorization

- JWT with Ethereum wallet signature verification (viem `verifyMessage`)
- Single-use nonce with 5-minute TTL (prevents replay attacks)
- `/users/*` routes verify JWT wallet matches requested `:wallet` param
- `PATCH /tokens/:address/metadata` reads wallet from JWT, not request body
- Rate limiting: 1000 req/min per IP (shared via Redis across all pods)
- Public read-only access to `/tokens/*` and `/stats/*` (analytics dashboard)

### Layer 5: Secrets Management

- AWS Secrets Manager (encrypted at rest with KMS, audit trail in CloudTrail)
- External Secrets Operator syncs every 15 minutes via IRSA
- No hardcoded secrets in code, docker-compose, or Helm values
- Recovery window: 7 days (accidental delete is recoverable)
- OIDC for GitHub Actions (no stored AWS access keys anywhere)
- IRSA for ESO (K8s service account → IAM role, no credentials in pods)

### Layer 6: HTTP Security Headers

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline';
  style-src 'self' 'unsafe-inline'; img-src 'self' https://i.flaunch.gg data:;
  connect-src 'self' wss: ws:; font-src 'self';
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 1; mode=block
```

### Layer 7: Infrastructure

- HTTPS ready (set `certificateArn` in values.yaml to enable TLS at ALB)
- RDS: skip_final_snapshot disabled (database preserved on destroy)
- RDS: 7-day backup retention with point-in-time recovery
- Redis: AOF persistence (max 1 second data loss on crash)
- Docker: pinned base image, HEALTHCHECK instruction
- ECR: image scanning on push

---

## 4. Pod Lifecycle & Probes

### API Pods

```
Pod scheduled on node
  │
  ├─ startupProbe: GET /health (10 attempts × 5s = 50s max)
  │   Purpose: Gives the app time to start without liveness killing it
  │
  ├─ readinessProbe: GET /health (every 10s, 3s timeout)
  │   Purpose: ALB only routes traffic to Ready pods
  │   Health check verifies:
  │     - Redis PING succeeds
  │     - Postgres SELECT 1 succeeds
  │   Returns 503 if either is down
  │
  └─ livenessProbe: GET /health (every 20s, 3 failures to restart)
      Purpose: Restarts pod if stuck
```

### Indexer + Processors

```
Pod scheduled on node
  │
  ├─ startupProbe: exec node (12 attempts × 5-10s = 60-120s max)
  │
  ├─ readinessProbe: checks /tmp/*-ready file exists
  │   Written AFTER Redis + Postgres connected and event loop started
  │   Pod not Ready until actually processing events
  │
  └─ livenessProbe: checks /tmp/*-alive file freshness
      Touched every 30s by running process
      If file is >2 minutes stale → event loop stuck → restart

      Replaces old /proc/1/status check (which only verified PID exists,
      not whether the process is actually healthy)
```

### Rolling Update Sequence

```
1. New pod created → starts up
2. startupProbe passes → K8s moves to readiness checks
3. readinessProbe passes → ALB adds pod to target group
4. Old pod: preStop hook fires → sleeps 15 seconds
5. During 15s: ALB drains existing connections from old pod
6. After 15s: SIGTERM sent → application shutdown handler runs
7. App closes: HTTP server → Redis clients → Postgres pools
8. Pod terminates (or SIGKILL after 60s grace period)
```

---

## 5. Pod Disruption Budgets

| Component | PDB Rule | Effect During Node Drain |
|---|---|---|
| API | minAvailable: 1 | Always at least 1 pod serving traffic |
| Indexer | minAvailable: 1 | Never voluntarily evicted (singleton) |
| processor-trade | maxUnavailable: 1 | At most 1 down at a time |
| processor-candle | maxUnavailable: 1 | Same |
| processor-token | maxUnavailable: 1 | Same |
| processor-fees | maxUnavailable: 1 | Same |
| processor-position | maxUnavailable: 1 | Same |
| processor-price | maxUnavailable: 1 | Same |

**Before:** Only 4 of 8 components had PDBs. Now all 8 are protected.

---

## 6. Topology & Scheduling

### Anti-Affinity

Applied to: API, indexer (new), all processors.
Spreads pods across nodes. With 2 nodes, each gets roughly half the pods.

**Before:** Indexer had no anti-affinity — could land on same node as all API pods.

### Topology Spread (API)

```yaml
topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: kubernetes.io/hostname
    whenUnsatisfiable: ScheduleAnyway
```

Ensures API pods distribute evenly across nodes even during scale-up.

---

## 7. Backup & Recovery

| Resource | Before | After |
|---|---|---|
| RDS backup retention | 1 day | **7 days** |
| RDS final snapshot | Skipped | **Required** |
| Secrets Manager recovery | 0 days | **7 days** |
| Redis persistence | Snapshots only | **AOF** (max 1s data loss) |
| Event replay | None | **Publish ledger** + gap verification |

---

## 8. Dockerfile Best Practices

- **Pinned base image**: `node:20.18.1-alpine3.21` (not floating `node:20-alpine`)
- **Multi-stage build**: dev deps excluded from production image
- **Non-root user**: uid 1001
- **HEALTHCHECK instruction**: works standalone, not just in K8s
- **Removed `npm cache clean --force`**: unnecessary after `npm ci`
- **Exec form CMD**: proper signal handling

---

## 9. Ingress — HTTPS Ready

```yaml
# One value to enable HTTPS:
ingress:
  certificateArn: "arn:aws:acm:ap-south-1:...:certificate/..."
```

Auto-enables: HTTPS on 443, HTTP→HTTPS redirect, TLS at ALB. Free cert via ACM.

---

## 10. Observability

### Prometheus Metrics (GET /metrics)

| Metric | Type | Purpose |
|---|---|---|
| `events_processed_total` | Counter | Throughput + error rate per processor |
| `event_processing_duration_seconds` | Histogram | P50/P95/P99 latency |
| `http_request_duration_seconds` | Histogram | API latency per endpoint |
| `http_requests_total` | Counter | Request volume |
| `cache_hits_total` / `cache_misses_total` | Counter | Cache effectiveness |
| `ws_clients_connected` | Gauge | Current WebSocket connections |
| `ws_messages_broadcast_total` | Counter | WS volume by type |
| `dead_letter_total` | Counter | Failed events (alert if > 0) |
| `errors_total` | Counter | Error rate by component |

### Structured Logging

- Pino JSON output with request ID, stream name, block number
- All silent catches replaced with warn-level logs + error counters
- Health endpoint returns 503 when Redis or Postgres is down

---

## 11. Resource Quota

```yaml
pods: "30"  # was 20, increased for HPA burst + rolling updates
```

---

## 12. All 16 Commits

| # | Type | What |
|---|---|---|
| 1 | feat | Pipelined batch Redis publishing + multi-region fan-out |
| 2 | feat | Pub/Sub for gateway (broadcast, not split) |
| 3 | perf | Token list: 9×N subqueries → 8 CTEs + JOINs |
| 4 | perf | Pre-sorted cache + cache hit/miss metrics |
| 5 | feat | Dead-letter queue in Postgres |
| 6 | feat | Persist makerCache + pendingPoolState to Redis |
| 7 | fix | JWT auth hardening — wallet ownership |
| 8 | feat | Prometheus metrics + CSP headers + real health check |
| 9 | perf | Redis Lua OHLCV candle + batch PG write |
| 10 | fix | Position processor transaction |
| 11 | fix | Postgres pool 10→20 + 30s statement timeout |
| 12 | infra | Redis AOF + runner IAM for Terraform state |
| 13 | test | 35 unit tests |
| 14 | docs | INFRASTRUCTURE.md with flow diagrams |
| 15 | fix | Remove CONFIRMATION_DEPTH + multi-region diagrams |
| 16 | ops | SRE hardening — probes, shutdown, seccomp, PDBs, network, CI, Trivy, backups |
