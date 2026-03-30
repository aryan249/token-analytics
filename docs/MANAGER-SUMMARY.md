# Token Analytics — Infrastructure & Deployment Summary

## What We Built

A real-time blockchain analytics platform that indexes the FLaunch protocol on Base L2, processes on-chain events, and serves data via REST API + WebSocket to a browser dashboard.

---

## Infrastructure Components

### Cloud Provider: AWS (ap-south-1, Mumbai)

| Component | Service | Spec | Purpose |
|---|---|---|---|
| **Compute** | EKS (Kubernetes) | 3 nodes, t3.small | Runs all application pods with auto-scaling |
| **Database** | RDS PostgreSQL | v16.6, 20GB, 7-day backups | Stores trades, candles, tokens, holder balances, fees |
| **Cache** | ElastiCache Redis | v7.1, AOF persistence | Event streams, API cache, real-time Pub/Sub, rate limiting |
| **Registry** | ECR | Private Docker registry | Stores application container images |
| **Secrets** | Secrets Manager | Encrypted, 7-day recovery | Database URLs, API keys, JWT secret |
| **Networking** | VPC + ALB | 2 AZ, sticky sessions | Private subnets for data stores, public ALB for API |
| **CI Runner** | EC2 t3.small | Self-hosted GitHub Actions | Builds, tests, and deploys the application |

### Monthly Cost: ~$190 (free-tier pricing where applicable)

---

## Application Pods (10 total)

| Pod | Replicas | What it does |
|---|---|---|
| **API** | 2-6 (auto-scales) | REST API + WebSocket server. Serves dashboard data. |
| **Indexer** | 1 | Connects to blockchain, fetches events, publishes to event streams. |
| **Trade Processor** | 1 | Processes swap events → trade records + real-time price updates. |
| **Candle Processor** | 1 | Aggregates trades into OHLCV candles (1m, 15m, 1h, 4h, 1d). |
| **Token Processor** | 1 | Registers new tokens, fetches metadata from blockchain. |
| **Fee Processor** | 1 | Tracks fee distributions and royalty payments. |
| **Position Processor** | 1 | Tracks holder balances from token transfers. |
| **Price Processor** | 1 | Maintains ETH/USD exchange rate from Chainlink oracle. |

---

## Monitoring Stack (6 pods)

| Component | What it does |
|---|---|
| **Prometheus** | Collects application metrics every 15 seconds (request latency, error rates, throughput) |
| **Grafana** | Dashboard UI with 8 pre-built panels. Accessible via port-forward. |
| **Loki** | Aggregates logs from all pods. Searchable in Grafana. 3-day retention. |
| **Promtail** (×3) | Ships logs from every node to Loki. Runs on all 3 nodes. |

### Key Metrics Tracked
- Events processed per second (by processor)
- API response latency (P95)
- Cache hit/miss rate
- WebSocket client count
- Dead-letter queue size (failed events)
- Error rate by component

### Alerting (4 rules)
- Error rate above threshold → warning
- Events in dead-letter queue → critical
- API latency above 2 seconds → warning
- API health check failing → critical

---

## CI/CD Pipeline

### How Code Gets to Production

```
Developer pushes code
  ↓
GitHub Actions (automated):
  1. Lint code quality
  2. Type check (TypeScript)
  3. Run 35 unit tests
  4. Scan dependencies for vulnerabilities
  5. Build Docker image
  6. Scan image for security issues (Trivy)
  7. Push to private registry (ECR)
  8. Deploy to Kubernetes (Helm)
  9. Verify all pods are healthy
```

**Build time:** ~5 minutes end-to-end
**Rollback:** Revert git commit → CI redeploys previous version

### Infrastructure Pipeline (separate)

```
Developer changes Terraform files
  ↓
GitHub Actions:
  1. Validate configuration
  2. Plan changes (preview what will change)
  3. Comment plan on pull request for review
  4. Apply changes on merge to main
```

---

## GitOps with Argo CD (Ready to Deploy)

### What it adds:
- **Drift detection** — if someone manually changes a pod config, Argo CD reverts it within 3 minutes
- **Audit trail** — every deployment is tracked with git commit SHA and diff
- **Staging → Production promotion** — merge a PR to promote code between environments
- **Rollback** — one command to revert to any previous deployment

### Environment strategy:
| Environment | Branch | Namespace | Auto-deploy |
|---|---|---|---|
| Staging | `staging` | token-analytics-staging | Yes |
| Production | `main` | token-analytics | Yes |

---

## Security Measures

| Category | What we do |
|---|---|
| **Container security** | Non-root user, read-only filesystem, no Linux capabilities, restricted syscalls |
| **Network security** | Private subnets for databases, ingress restricted to load balancer only, egress restricted to 4 ports |
| **Authentication** | JWT tokens via Ethereum wallet signature. Users can only access their own data. |
| **Secrets** | Encrypted in AWS Secrets Manager. Injected into pods via External Secrets Operator. No secrets in code. |
| **CI/CD security** | No stored AWS keys (OIDC federation). Docker images scanned for vulnerabilities. Dependencies audited. |
| **API security** | Rate limiting (1000 req/min per IP), CSP headers, XSS protection, clickjacking prevention |
| **Backup** | Database: 7-day automated backups. Redis: AOF persistence (1 second max data loss). Event replay via publish ledger. |

---

## Reliability

| Feature | What it does |
|---|---|
| **Auto-scaling** | API pods scale from 2 to 6 based on CPU/memory load |
| **Auto-recovery** | Runner EC2 auto-recovers on hardware failure. Watchdog restarts crashed services every 5 minutes. |
| **Pod disruption budgets** | Prevents all pods from being killed simultaneously during maintenance |
| **Graceful shutdown** | Connections drain cleanly during deployments (no dropped requests) |
| **Dead-letter queue** | Failed events saved to database for investigation instead of being lost |
| **Event replay** | If Redis loses data, indexer detects gaps and re-fetches from blockchain |
| **Idempotent processing** | All database writes are safe to replay (no duplicates on retry) |

---

## Multi-Region Ready

The system is designed to scale to multiple AWS regions:

```
Scanner (Mumbai) publishes to:
  → Redis (Mumbai) → local processors + API
  → Redis (EU)     → EU processors + API
  → Redis (US)     → US processors + API
```

- VPC peering configured for cross-region Redis connectivity
- Each region reads from local Redis (no cross-region latency for users)
- Scanner publishes to all regions in parallel (one batched pipeline per region)

---

## Key Numbers

| Metric | Value |
|---|---|
| Total pods | 16 (10 app + 6 monitoring) |
| EKS nodes | 3 (t3.small, 2 availability zones) |
| API endpoints | 14 (10 public, 4 authenticated) |
| Unit tests | 35 |
| Database backup | 7 days |
| Max data loss (Redis crash) | 1 second |
| API auto-scale range | 2-6 pods |
| CI/CD build time | ~5 minutes |
| Prometheus metrics | 13 custom + Node.js defaults |
| Alerting rules | 4 |
| Estimated monthly cost | ~$190 |
