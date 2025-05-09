# Infrastructure & Deployment — Complete Guide

This document explains every component, why it exists, and how they connect.

---

## 1. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         INTERNET                                    │
└───────────────────────────┬─────────────────────────────────────────┘
                            │
                     ┌──────▼──────┐
                     │     ALB     │  Application Load Balancer
                     │ (port 80)   │  internet-facing, sticky sessions
                     └──────┬──────┘
                            │
┌───────────────────────────┼─────────────────────────────────────────┐
│  EKS Cluster              │                    namespace:           │
│  (2x t3.small)            │                    token-analytics      │
│                    ┌──────▼──────┐                                  │
│                    │  API Pods   │  Deployment (2→6 via HPA)        │
│                    │  (Fastify)  │  REST + WebSocket + static UI    │
│                    └──────┬──────┘                                  │
│                           │                                         │
│    ┌──────────────────────┼──────────────────────┐                  │
│    │                      │                      │                  │
│    ▼                      ▼                      ▼                  │
│ ┌────────┐         ┌────────────┐         ┌───────────┐            │
│ │Indexer │         │ Processors │         │    ESO    │            │
│ │(1 pod) │         │ (8 pods)   │         │ Operator  │            │
│ │Scanner │         │ trade (2)  │         │           │            │
│ │        │         │ candle (2) │         │ Syncs     │            │
│ │Fetches │         │ token (1)  │         │ secrets   │            │
│ │on-chain│         │ fees (1)   │         │ from AWS  │            │
│ │events  │         │ position(1)│         │           │            │
│ │        │         │ price (1)  │         └─────┬─────┘            │
│ └───┬────┘         └─────┬──────┘               │                  │
│     │                    │                      │                  │
│     │     XADD           │  SQL writes          │ IRSA/OIDC       │
│     ▼                    ▼                      ▼                  │
│ ┌────────────────────────────────────────────────────────────────┐  │
│ │                     SHARED INFRASTRUCTURE                      │  │
│ │                                                                │  │
│ │  ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐    │  │
│ │  │ ElastiCache │  │     RDS      │  │ Secrets Manager   │    │  │
│ │  │   Redis     │  │  PostgreSQL  │  │                   │    │  │
│ │  │             │  │              │  │ POSTGRES_URL      │    │  │
│ │  │ - Streams   │  │ - Tokens     │  │ REDIS_URL         │    │  │
│ │  │ - Cache     │  │ - Trades     │  │ ALCHEMY_WS_URL    │    │  │
│ │  │ - Rate limit│  │ - Candles    │  │ JWT_SECRET         │    │  │
│ │  │ - Pub/sub   │  │ - Holders    │  │                   │    │  │
│ │  └─────────────┘  │ - Fees       │  └───────────────────┘    │  │
│ │                    │ - Positions  │                            │  │
│ │                    └──────────────┘                            │  │
│ └────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 1b. Complete Data Flow (Single Region)

```
                         Base L2 Blockchain
                                │
                     Alchemy WebSocket (wss://)
                                │
                    ┌───────────▼────────────┐
                    │   SCANNER (1 pod)      │
                    │                        │
                    │  watchBlocks (live)     │──→ blocks processed IMMEDIATELY
                    │  catchUp (10 parallel) │    (no confirmation depth delay)
                    │  2-pass decode         │    reorg handled by parent hash check
                    │  reorg detection       │
                    └───────────┬────────────┘
                                │
          ┌─────────────────────▼─────────────────────────┐
          │        publishToChannels (pipelined batch)     │
          │        redis.multi() → N xAdds → exec()       │
          │        = 1 round trip for all events           │
          │                                                │
          │  Event Streams          │  Fast-path UI        │
          │  (consumer groups       │  (Pub/Sub broadcast  │
          │   split work)           │   to all pods)       │
          ├────────────────────────┤                       │
          │                        │                       │
          │  stream:swap ─────┐    │  pubsub:ui:candles ──┐│
          │  stream:fees ───┐ │    │  pubsub:ui:meta ────┐││
          │  stream:meta ─┐ │ │    │                     │││
          │  stream:price  │ │ │    │                     │││
          │  stream:xfer   │ │ │    └─────────────────────┘││
          └────────────────┘ │ │                           ││
                             │ │                           ││
               ┌─────────────▼─▼──────────────┐           ││
               │      PROCESSORS (6 pods)      │           ││
               │                               │           ││
               │  Trade  → trades table ───────│──→ pubsub:ui:trades
               │  Candle → Redis Lua OHLCV ────│──→ pubsub:ui:candles
               │          + PG batch (1 query) │           ││
               │  Token  → token_registry ─────│──→ pubsub:ui:meta
               │  Fees   → fee_distributions ──│──→ pubsub:ui:fees
               │  Position → holder_balances   │           ││
               │  Price  → Redis ETH/USD ──────│──→ pubsub:ui:rate
               └───────────────────────────────┘           ││
                                                           ││
               ┌───────────────────────────────────────────▼▼──┐
               │     API + WS GATEWAY (2-6 pods, HPA)          │
               │                                                │
               │  Pub/Sub subscribers (every pod gets ALL msgs) │
               │  → broadcast to connected WebSocket clients    │
               │                                                │
               │  REST API with Redis cache (5-30s TTL)         │
               │  → stampede lock prevents thundering herd      │
               │                                                │
               │  GET /metrics → Prometheus scraping             │
               └────────────────┬───────────────────────────────┘
                                │
                         ┌──────▼──────┐
                         │     ALB     │  sticky sessions (app cookie)
                         └──────┬──────┘
                                │
                            INTERNET
                         (browsers, bots)
```

## 1c. Multi-Region Architecture

```
When REDIS_REPLICA_URLS is configured, the scanner fans out to all regions:

                         Base Blockchain
                               │
                    ┌──────────▼──────────┐
                    │   SCANNER (US-East)  │
                    │                      │
                    │  publishToChannels() │
                    │  Promise.all([       │
                    │    pipeline(US),      │─── 1 pipeline per region
                    │    pipeline(EU),      │    all in parallel
                    │    pipeline(AP),      │
                    │  ])                   │
                    └──────┬───┬───┬───────┘
                           │   │   │
              ┌────────────┘   │   └────────────┐
              ▼                ▼                 ▼
     ┌────────────────┐ ┌────────────────┐ ┌────────────────┐
     │  Redis (US)    │ │  Redis (EU)    │ │  Redis (AP)    │
     │  - Streams     │ │  - Streams     │ │  - Streams     │
     │  - Pub/Sub     │ │  - Pub/Sub     │ │  - Pub/Sub     │
     │  - Cache       │ │  - Cache       │ │  - Cache       │
     └───────┬────────┘ └───────┬────────┘ └───────┬────────┘
             │                  │                   │
     ┌───────▼────────┐ ┌──────▼─────────┐ ┌──────▼─────────┐
     │ US Processors  │ │ EU Processors  │ │ AP Processors  │
     │ US API Pods    │ │ EU API Pods    │ │ AP API Pods    │
     │ US Postgres    │ │ EU Postgres    │ │ AP Postgres    │
     └────────────────┘ └────────────────┘ └────────────────┘

Each region:
  - Processors read from LOCAL Redis (no cross-region latency)
  - API pods read from LOCAL Redis cache + LOCAL Postgres
  - Scanner publishes to ALL regions in 1 batched pipeline per region
  - Latency: max(US_redis, EU_redis, AP_redis) ≈ 80ms (parallel, not additive)
```

## 1d. Event Processing Guarantees

```
Event lifecycle:

  Scanner decodes event
    │
    ├─ xAdd to Redis stream ─── publish ledger recorded in Postgres
    │                            (block_number, stream, event_count, stream_ids)
    │
    ├─ Processor xReadGroup picks up event
    │   ├─ handle() succeeds → xAck (removed from pending list)
    │   ├─ handle() fails   → 3 retries with backoff (1s, 2s, 3s)
    │   ├─ still fails      → left unacked in pending list
    │   ├─ claim loop       → reclaims after 30s idle
    │   └─ 5+ failures      → persisted to dead_letter_queue → xAck
    │
    └─ On scanner restart:
        verifyAndReplayGaps()
          → reads publish_ledger for last 100 blocks
          → spot-checks stream IDs in Redis (xRange)
          → re-fetches + re-publishes missing blocks from blockchain
          → safe because all DB writes are idempotent (ON CONFLICT)
```

---

## 2. Terraform Infrastructure

Everything in `terraform/` — 12 files creating AWS resources.

### VPC (`vpc.tf`)

**What**: Network with 4 subnets across 2 availability zones.

```
VPC: 10.0.0.0/16
├── Public subnets (10.0.0.0/24, 10.0.1.0/24)
│   └── NAT Gateway, ALB, GitHub Runner
└── Private subnets (10.0.100.0/24, 10.0.101.0/24)
    └── EKS nodes, RDS, ElastiCache
```

**Why 2 AZs**: If one AZ goes down, services continue in the other. RDS and EKS spread across both.

**Why NAT Gateway**: Private subnets need outbound internet (pull Docker images, connect to Alchemy RPC) but shouldn't accept inbound traffic.

### EKS (`eks.tf`)

**What**: Kubernetes v1.29 cluster with 2x t3.small worker nodes.

**Why EKS over EC2/docker-compose**:
- Auto-restarts crashed containers (no manual `nohup` commands)
- HPA scales pods based on real CPU/memory metrics
- PDB prevents downtime during node upgrades
- Network policies isolate pods (processors can't be reached from internet)
- Helm makes deployment repeatable and rollbackable

**Why t3.small**: 2 vCPU, 2GB RAM. Fits ~6 pods per node. 2 nodes = 12 pods total. Cheapest instance that can run the workload.

**Why 2 nodes**: Pod anti-affinity spreads API pods across nodes. If one node dies, the other still serves traffic.

### RDS (`rds.tf`)

**What**: PostgreSQL 16 on db.t3.micro (free tier).

**Why RDS over self-hosted Postgres**: Automated backups, patching, failover. One less thing to manage.

**Why private subnet**: Database should never be reachable from internet. Only EKS pods can connect (security group rule).

**Why SSL (`sslmode=no-verify`)**: RDS enforces SSL by default. `no-verify` skips certificate validation (acceptable within same VPC).

### ElastiCache (`elasticache.tf`)

**What**: Redis 7.1 on cache.t3.micro (free tier).

**Why managed Redis**: Same as RDS — no maintenance, auto-patching, persistent storage.

**Redis serves 4 purposes**:
1. **Streams** — indexer → processor message queue (reliable delivery)
2. **Cache** — API response cache (5-15s TTL with stampede lock)
3. **Rate limiting** — shared counter across all API pods (100 req/min/IP)
4. **Pub/sub** — processor → WebSocket gateway for real-time events

### ECR (`ecr.tf`)

**What**: Docker image registry. Lifecycle policy keeps last 10 images.

**Why ECR over Docker Hub**: Same AWS account, no auth complexity, faster pulls from EKS.

### Secrets Manager (`secrets-manager.tf`)

**What**: Stores POSTGRES_URL, REDIS_URL, ALCHEMY_WS_URL, JWT_SECRET.

**Why not K8s secrets directly**: K8s secrets are base64 encoded (not encrypted). Secrets Manager encrypts at rest, has audit logs, rotation support.

**How it connects to pods**: External Secrets Operator reads from Secrets Manager via IRSA (IAM Roles for Service Accounts) and creates a K8s secret that pods mount as env vars.

### IAM (`iam.tf`)

5 IAM roles:

| Role | Who uses it | What it can do |
|------|------------|----------------|
| `eks-cluster-role` | EKS control plane | Manage the cluster |
| `eks-node-role` | EC2 worker nodes | Pull images from ECR, manage ENIs |
| `github-actions-role` | CI/CD pipeline | Push to ECR, describe EKS cluster |
| `external-secrets-role` | ESO pods | Read from Secrets Manager |
| `runner-role` | GitHub runner EC2 | Push to ECR, SSM for remote access |

**OIDC for GitHub Actions**: No stored AWS keys. GitHub sends a signed JWT, AWS validates it against the OIDC provider and grants temporary credentials.

**IRSA for ESO**: Same concept — K8s ServiceAccount is annotated with IAM role ARN. When ESO pod starts, it gets temporary AWS credentials via the EKS OIDC provider.

### EC2 Runner (`ec2-runner.tf`)

**What**: t3.small instance running GitHub Actions runner agent.

**Why self-hosted**: Cheaper than GitHub-hosted runners ($15/mo vs per-minute billing). Docker layer caching makes builds faster. Inside VPC for direct ECR/EKS access.

**User data script** (`runner-init.sh`): Installs Docker, Node.js 20, GitHub runner agent, registers with the repo, starts as systemd service.

---

## 3. Helm Chart

Everything in `helm/token-analytics/` — deployed via `helm upgrade`.

### Why Helm

- **Templating**: One template generates 6 processor StatefulSets instead of 6 separate YAML files
- **Values**: Change replica count, image tag, resource limits without editing templates
- **Rollback**: `helm rollback token-analytics 1` reverts to previous deployment
- **Dependency management**: Install External Secrets Operator as a prerequisite

### Templates Explained

#### `deployment-api.yaml` — API Server

```yaml
Kind: Deployment (not StatefulSet)
Replicas: 2 (managed by HPA, scales 2→6)
```

**Why Deployment**: API is stateless. Any pod can handle any request. No need for stable identity.

**Anti-affinity**: Prefers scheduling on different nodes. If node-1 has an API pod, the second goes to node-2.

**3 probes**:
- `startupProbe`: Gives the pod 50s to start (10 retries × 5s). Prevents liveness from killing slow starts.
- `readinessProbe`: ALB only routes traffic to ready pods. Pod is ready when `/health` returns 200.
- `livenessProbe`: Restarts the pod if `/health` fails for 40s.

#### `deployment-indexer.yaml` — Scanner

```yaml
Kind: StatefulSet
Replicas: 1 (singleton, never scale)
```

**Why StatefulSet**: Stable pod name `indexer-0`. If it restarts, it gets the same identity and resumes from checkpoint.

**Why singleton**: Two indexers would both write to `sync_checkpoints`, causing duplicate events and checkpoint conflicts.

**Why no readiness probe**: Indexer doesn't serve HTTP traffic. Only liveness probe to restart if stuck.

#### `deployment-processors.yaml` — Event Processors

```yaml
Kind: StatefulSet
Replicas: 1-2 per type (trade/candle get 2, others get 1)
```

**Why StatefulSet**: Stable consumer names for Redis Streams. When `processor-trade-0` restarts, it reclaims its pending messages.

**Why trade and candle get 2 replicas**: These process the most events (every swap). Redis Streams consumer group distributes messages between them automatically.

**Why others get 1**: Token creation, fee distribution, price updates are infrequent. One processor is enough.

#### `hpa.yaml` — Horizontal Pod Autoscaler

```yaml
Target: API Deployment
Min: 2, Max: 6
CPU target: 70%, Memory target: 80%
Scale up: 1 pod per 60s
Scale down: 1 pod per 120s (prevents flapping)
```

**How it works**: Metrics-server collects CPU/memory from kubelet. HPA checks every 15s. If average CPU across API pods > 70%, it adds a pod.

**Why only on API**: Processors are bounded by Redis Streams throughput, not CPU. Indexer is singleton. Only API gets more load with more users.

#### `pdb.yaml` — Pod Disruption Budgets

```yaml
api: minAvailable: 1
indexer: minAvailable: 1
processor-trade: minAvailable: 1
processor-candle: minAvailable: 1
```

**Why**: During `kubectl drain` (node upgrade), K8s evicts pods. PDB prevents evicting the last pod — ensures at least 1 is always running.

#### `network-policy.yaml`

```yaml
API: allow ingress on port 3000
Processors/Indexer: deny all ingress
```

**Why**: Processors only make outbound connections (to Redis, Postgres). No reason for any traffic to reach them. API is the only entry point.

#### `resource-quota.yaml`

```yaml
Namespace limits: 4 CPU, 4Gi memory, 20 pods max
```

**Why**: Prevents a runaway pod or misconfigured HPA from consuming the entire cluster.

#### `secret.yaml` — External Secrets

3 resources in one file:

1. **ServiceAccount**: Annotated with IAM role ARN for IRSA
2. **SecretStore**: Tells ESO to use AWS Secrets Manager in ap-south-1
3. **ExternalSecret**: Maps 4 keys from Secrets Manager to K8s secret fields

```
AWS Secrets Manager → SecretStore → ExternalSecret → K8s Secret → Pod envFrom
```

Syncs every 1 hour. Force sync: `kubectl annotate externalsecret ... force-sync=$(date +%s)`

#### `ingress.yaml` — ALB Ingress

```yaml
Class: alb
Scheme: internet-facing
Stickiness: app_cookie (for WebSocket)
```

**Why ALB over NLB**: ALB understands HTTP, can do path-based routing, health checks on `/health`, and sticky sessions for WebSocket connections.

**Why sticky sessions**: WebSocket connections are stateful. Once a client connects to pod-1, all messages should go to pod-1. Without stickiness, the ALB could route the HTTP upgrade to pod-1 but subsequent frames to pod-2.

---

## 4. Resilience & Data Integrity

### Event Processing Pipeline

```
Scanner → xAdd to Redis Stream → Processor reads via xReadGroup
  │
  ├─ 3 retries with exponential backoff (1s, 2s, 3s)
  ├─ Unacked → claim loop reclaims after 30s idle
  ├─ After 5 delivery attempts → persisted to dead_letter_queue (Postgres)
  └─ Checkpoint only advances after successful publish
```

### Dead-Letter Queue

Events that fail 5 times are persisted to `dead_letter_queue` in Postgres for inspection/replay:

```sql
SELECT stream, message_id, error, attempts, created_at
FROM dead_letter_queue ORDER BY created_at DESC;
```

### Pub/Sub Fan-Out (Gateway)

The WebSocket gateway uses **Redis Pub/Sub** (not Streams consumer groups) to ensure every API pod receives every event:

```
Consumer Groups (processors): SPLIT messages across pods
  → Correct for work distribution

Pub/Sub (gateway): BROADCAST to all pods
  → Correct for real-time fan-out to WebSocket clients
```

Channels: `pubsub:ui:trades`, `pubsub:ui:candles`, `pubsub:ui:fees`, `pubsub:ui:rate`, `pubsub:ui:meta`

### Redis-Persisted State (Survives Pod Restart)

| Key | Type | Purpose | TTL |
|-----|------|---------|-----|
| `cache:tx-makers` | HASH | txHash → {from, to} for trade maker resolution | 24h |
| `cache:pending-pool-state` | HASH | poolId → buffered PoolStateUpdated events | ∞ (cleared on flush) |
| `cache:token-meta` | HASH | tokenAddr → {name, symbol, sparkline, mcap} | ∞ (updated on trade) |

Previously these were in-memory Maps lost on every pod restart. Now persisted to Redis and restored on startup.

### Pipelined Publishing

Scanner batches all xAdd + publish commands into a single Redis pipeline per region:

```
Before: 50 events × sequential await = 50 round trips
After:  redis.multi() → 50 xAdds + publishes → exec() = 1 round trip
```

### Multi-Region Fan-Out

```
REDIS_REPLICA_URLS=redis://eu:6379,redis://us-west:6379

Scanner fans out to all Redis instances in parallel (Promise.all).
Each region's processors read from their local Redis — no cross-region latency.
```

### Fast-Path Candle Publishing

Candle tip updates are computed inline by the scanner (pure math — no DB) and published directly to the UI Pub/Sub channel. The candle processor still persists to DB via the slow path.

```
Scanner → pubsub:ui:candles (instant) → Browser chart update
    └──→ stream:events:swap → CandleProcessor → DB persist (async)
```

### Query Optimization

Token list query uses CTEs instead of N×9 scalar subqueries:

```
Before: 9 subqueries per token × 100 tokens = 900 subquery executions
After:  8 CTEs (one table scan each) + 8 hash joins = 8 scans total
```

Market cap pre-computed in SQL: `price * totalSupply / 1e18` — not per-token BigInt in JS.

### Parallel Catch-Up

Scanner fetches block headers in parallel during catch-up (10 concurrent RPC calls):

```
Before: 50 blocks × 100ms RPC = 5s per batch
After:  50 / 10 × 100ms = 500ms per batch (~10x faster)
```

---

## 5. API Endpoints & Authentication

### Public (No Auth)

| Method | Path | Cache | Description |
|--------|------|-------|-------------|
| GET | `/health` | - | Redis + PG connectivity check (returns 503 if degraded) |
| GET | `/auth/nonce?wallet=` | - | Request signing nonce (5min TTL) |
| POST | `/auth/login` | - | Submit signature → JWT token |
| GET | `/tokens` | 5s | Token list (sort: marketCap/volume/trades/newest) |
| GET | `/tokens/:address` | 5s | Token detail |
| GET | `/tokens/:address/candles` | 10s | OHLCV candles (1m/15m/1h/4h/1d) |
| GET | `/tokens/:address/trades` | - | Paginated trade history |
| GET | `/tokens/:address/holders` | - | Holder list |
| GET | `/stats` | 10s | Platform totals |
| GET | `/stats/top-earners` | 10s | Top fee earners (24h) |
| WS | `/ws` | - | Real-time event stream |

### Authenticated (JWT Required)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/users/:wallet/positions` | Wallet's token holdings (**own wallet only**) |
| GET | `/users/:wallet/royalties` | Wallet's royalty earnings (**own wallet only**) |
| GET | `/users/:wallet/activity` | Wallet's trade/fee history (**own wallet only**) |
| PATCH | `/tokens/:address/metadata` | Update token description/links (**creator only, from JWT**) |

### Auth Flow

```
1. GET /auth/nonce?wallet=0x... → { nonce, message }
2. User signs message with wallet (Ethereum signature)
3. POST /auth/login { wallet, signature } → { token }
4. All subsequent requests: Authorization: Bearer <token>
```

### Security Properties

- JWT verified via Ed25519 on every non-public request
- `/users/*` routes verify JWT wallet matches requested `:wallet` param — users cannot access other wallets' data
- `PATCH /tokens/:address/metadata` reads wallet from JWT (not request body) and verifies it matches the token's creator
- Nonce is single-use (deleted after login) with 5-minute TTL
- Token/stats GET endpoints are intentionally public (analytics dashboard)

---

## 6. CI/CD Pipelines

### `ci.yml` — Application Pipeline

```
Trigger: push or PR to main

┌─────────────────────────────┐
│ lint-and-build (every push) │
│  checkout → npm ci → tsc    │
└─────────────┬───────────────┘
              │ (only on merge to main)
┌─────────────▼───────────────┐
│ docker-build-push            │
│  OIDC auth → ECR login       │
│  docker build (multi-stage)  │
│  push image with SHA tag     │
│  update values.yaml tag      │
│  git commit + push           │
└─────────────┬───────────────┘
              │
┌─────────────▼───────────────┐
│ deploy                       │
│  kubectl config              │
│  install ESO (if needed)     │
│  helm upgrade                │
│  verify pods                 │
│  print API endpoint          │
└─────────────────────────────┘
```

### `infra.yml` — Infrastructure Pipeline

```
Trigger: terraform/ path changes, or manual dispatch

PR: terraform plan → comment plan on PR
Merge: terraform plan → terraform apply
Manual: terraform destroy (for cleanup)
```

**Secrets needed in GitHub**:
- `RDS_PASSWORD` — for Terraform (can't store in Secrets Manager, chicken-egg)
- `RUNNER_TOKEN` — to register GitHub runner

Everything else comes from AWS Secrets Manager or OIDC.

---

## 5. Dockerfile

```dockerfile
# Stage 1: Build
FROM node:20-alpine AS builder
  npm ci (all deps including devDeps)
  tsc --outDir dist (compile TypeScript → JavaScript)

# Stage 2: Production
FROM node:20-alpine
  adduser appuser (uid 1001, non-root)
  npm ci --omit=dev (production deps only)
  COPY dist/ from builder
  USER appuser
  CMD ["node", "dist/indexer/main.js"]
```

**Why multi-stage**: Build stage has TypeScript compiler + dev deps (~300MB). Production image only has runtime deps (~65MB). Smaller image = faster pulls + less attack surface.

**Why non-root**: `appuser` (uid 1001). Combined with `readOnlyRootFilesystem: true` in Helm, containers can't write to disk or escalate privileges.

**Why `noEmitOnError false`**: `ox` package ships `.ts` source files that have browser-only types (`window`, `WebAuthn`). tsc reports errors but still emits JavaScript. We verify `dist/indexer/main.js` exists after build.

---

## 6. Caching Strategy

### Cache Layers

```
Client request
  │
  ▼
ALB (no caching)
  │
  ▼
API Pod
  ├── Redis cache hit? → return immediately (< 5ms)
  └── Cache miss → acquire lock → query PostgreSQL → write cache → return
```

### TTLs

| Endpoint | TTL | Why |
|----------|-----|-----|
| `/tokens` | 5s | Price-sensitive, near-real-time |
| `/tokens/:address` | 5s | Price changes per trade |
| `/candles` | 10s | Aggregated, slightly less critical |
| `/stats` | 10s | Aggregate platform metrics |
| `/stats/top-earners` | 15s | Changes slowly |
| `/users/:wallet/royalties` | 15s | User-specific, less traffic |

### Thundering Herd Protection

When cache expires and N requests arrive simultaneously:

```
Without lock:
  Request 1 → cache miss → query DB
  Request 2 → cache miss → query DB   (N queries!)
  ...
  Request N → cache miss → query DB

With stampede lock:
  Request 1 → cache miss → acquire lock → query DB → write cache → release lock
  Request 2 → cache miss → lock exists → poll cache every 50ms → cache appears → return
  ...
  Request N → same as Request 2          (1 query!)
```

Lock is a Redis key with `SET NX EX 5` (5s expiry). If lock holder crashes, lock auto-expires and next request retries.

### Cache Invalidation

Processors call `redis.del(key)` after writing to PostgreSQL. Since all API pods share the same Redis, the delete is immediate across all pods. Next request triggers a fresh DB query.

---

## 7. Rate Limiting

**Type**: Fixed window, Redis-backed (shared across all pods).

**Config**: 100 requests per minute per IP address.

**Implementation**: `@fastify/rate-limit` with `ioredis` store.

```
Request → ALB → Pod 1 or Pod 2
                  │
                  ▼
           Redis: INCR rate-limit:{ip}
                  │
           Count > 100? → 429 Too Many Requests
           Count ≤ 100? → process request
```

**Why Redis-backed**: With 2+ API pods, in-memory rate limiting lets a client make 100×N requests (100 per pod). Redis counter is shared — true 100/min regardless of which pod handles the request.

**Allowlist**: `127.0.0.1` — K8s liveness/readiness probes come from localhost and must never be rate limited.

---

## 8. Security

| Layer | Mechanism |
|-------|-----------|
| **Network** | VPC private subnets for RDS/Redis. Security groups: only EKS → RDS/Redis |
| **Authentication** | JWT via wallet signature (viem verifyMessage). Public GET for tokens/stats; user-specific routes require JWT with wallet match |
| **Secrets** | AWS Secrets Manager → ESO → K8s secrets. Never in Git, never in env files |
| **Containers** | Non-root user (uid 1001), readOnlyRootFilesystem, drop ALL capabilities |
| **Pods** | Pod anti-affinity, PDB, resource quotas, network policies |
| **Rate limiting** | 100 req/min/IP via Redis (shared across pods) |
| **CORS** | `origin: true` (open for analytics dashboard) |
| **IAM** | OIDC for GitHub Actions (no stored keys), IRSA for ESO (no stored keys) |
| **Database** | SSL required, encrypted at rest, private subnet only |

---

## 9. Monitoring

| What | How |
|------|-----|
| Pod health | K8s liveness/readiness/startup probes |
| API errors | Fastify global error handler logs with request ID |
| Stream lag | `XINFO GROUPS stream:*` — check pending count and lag per consumer group |
| Node resources | `kubectl top nodes` via metrics-server |
| Pod resources | `kubectl top pods -n token-analytics` |
| EKS control plane | CloudWatch logs (API server, audit, authenticator) |
| HPA decisions | `kubectl describe hpa api-hpa -n token-analytics` |

---

## 10. Scaling

| Component | How it scales | Limit |
|-----------|--------------|-------|
| API | HPA: 2→6 pods based on CPU/memory | 6 pods (values.yaml), then need more nodes |
| Trade processor | Increase `processors.trade.replicas` | Redis Streams distributes work |
| Candle processor | Increase `processors.candle.replicas` | Same |
| Other processors | Increase replicas as needed | Same |
| Indexer | **Cannot scale** — singleton with checkpoint | 1 always |
| Nodes | Add EKS node group capacity or Cluster Autoscaler | AWS account limits |
| Database | RDS instance resize or read replicas | `POSTGRES_READ_URL` already supported |
| Redis | ElastiCache node resize | Single node currently |
