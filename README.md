# 🔧 TrustFlow Core — Backend API

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **The off-chain backbone of the TrustFlow Protocol.**

TrustFlow Core is the backend API service that powers off-chain logic for the TrustFlow gig-economy platform. Built with NestJS and TypeScript, it bridges the Stellar/Soroban blockchain with real-world application features — handling authentication, escrow state management, webhook delivery, and Prometheus-grade observability.

---

## ✨ Core Features.

- 🔐 **JWT Authentication with Wallet Signatures**: Secure wallet-based auth using Stellar signature verification. Users authenticate by signing a cryptographic challenge with their Freighter wallet, proving ownership without exposing private keys.
- 💼 **Escrow Management**: Full CRUD API for escrow entities — creation, funding, milestone tracking.
- 🌐 **Stellar Integration**: Native Horizon and Soroban RPC helpers for on-chain reads and writes.
- 🔔 **Webhook Engine**: Event-driven webhook dispatch with automatic retry logic.
- 📊 **Monitoring & Metrics**: Built-in Prometheus metrics, health checks, and alerting helpers.
- 🛡️ **Distributed Rate Limiting**: Redis-backed per-IP and per-wallet token buckets with sliding-window abuse detection and temporary lockouts.

---

## 🗂️ Project Structure

```
backend/
└── src/
    ├── admin/                  # Read-only protocol analytics dashboard (admin-only)
    ├── auth/                   # Wallet-signature JWT auth — challenge/verify, nonce store, guard
    ├── common/                 # Cross-cutting: rate limiting, Redis client, idempotency, pagination, logging, DB, filters
    ├── config/                 # Zod-validated env config, .env loading
    ├── deliverable/            # Gig deliverable submission and review
    ├── dispute/                # Dispute resolution saga (juror voting, resolution)
    ├── escrow/                 # Escrow vault CRUD, milestone release, disputes
    ├── escrow-reconciliation/  # Reconciles off-chain escrow state against on-chain Soroban state
    ├── escrow-write/           # Builds unsigned Soroban release transactions for client signing
    ├── event-ingestion/        # Polls Soroban RPC for contract events, feeds the outbox
    ├── gig/                    # Gig solicitation postings — accept/cancel, auto-expiry sweep
    ├── ipfs-pinning/           # Multi-provider IPFS pinning (Pinata/Web3.Storage/Infura) with failover
    ├── migration/              # Schema migration registry/runner (admin-triggered run/rollback)
    ├── milestone-notifications/# WebSocket gateway for milestone/escrow event notifications
    ├── monitoring/             # Health checks (`/health`) and Prometheus metrics (`/metrics`)
    ├── notification/           # Shared notification dispatch types/service
    ├── outbox/                 # Transactional outbox relay to WebSocket/webhooks/workers
    ├── reputation/             # Wallet reputation scoring with time decay
    ├── sentry/                 # Sentry error-monitoring integration
    ├── soroban-event-indexer/  # Indexes raw Soroban events into Redis for `/events/soroban`
    ├── stellar/                # Horizon/Soroban RPC clients, failover, network config
    ├── testing/                # Shared test doubles (fake Redis client)
    ├── user-profile/           # Wallet-linked user profiles — search, ratings, verification
    ├── webhook/                # Webhook registration/dispatch, HMAC signing, Discord notifications
    └── main.ts                 # App entry point
```

---

## 🚀 Getting Started

### Prerequisites

- Node.js >= 20
- A Stellar RPC endpoint (testnet or mainnet)
- Freighter wallet (for client-side wallet signature testing)

### Installation

```bash
npm install
```

### Environment Setup

Copy the example env file into `backend/` (where the app looks for it) and fill in your values:

```bash
cd backend
cp ../.env.example .env
```

> **Note on .env Precedence (#920)**: `backend/.env` is the primary source of truth for the backend service. If both a root `.env` and `backend/.env` exist, `backend/.env` takes precedence. Pre-existing environment variables already set in your shell/container always take highest precedence over file values.

Key variables:

```env
JWT_SECRET=your-secret
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
REDIS_URL=redis://localhost:6379
RATE_LIMIT_ABUSE_WINDOW_SECONDS=300
RATE_LIMIT_ABUSE_THRESHOLD=5
RATE_LIMIT_LOCKOUT_SECONDS=900
# allow (fail open, default) or deny (503 + Retry-After) when Redis is down; /auth/* always denies
RATE_LIMIT_ON_REDIS_ERROR=allow
REDIS_COMMAND_TIMEOUT_MS=1000
```

See [`.env.example`](.env.example) for the full list of variables, including optional IPFS, database, and admin settings.

**What dependencies are required?** See [Runtime Dependencies](docs/runtime-dependencies.md) for a detailed breakdown of each external service (Redis, PostgreSQL, Stellar, IPFS, etc.), what happens when they're unset or down, and which are mandatory for production.

### Running

```bash
# Development
cd backend
npm run dev

# Production
npm run build && npm start

# Run tests
npm test

# Run CI checks locally
./scripts/ci-check.sh
```

See [Backend Setup Instructions](backend/SETUP_INSTRUCTIONS.md) for detailed development workflow.

---

## 📖 API Modules

### 📚 Interactive API Documentation

**Swagger UI**: `http://localhost:3001/api/docs`  
**OpenAPI JSON**: `http://localhost:3001/api/docs-json`
(Disabled in production unless `SWAGGER_ENABLED=true`; protect with `SWAGGER_USER`/`SWAGGER_PASSWORD`.)

Full guide: [API Documentation](backend/API_DOCUMENTATION.md)

### 🗂️ Off-Chain State Model

[docs/state-model.md](docs/state-model.md) — Reference for the Escrow, Gig, and DisputeSaga state
machines: which transitions are driven by API calls, on-chain Soroban events, or background workers,
plus a catalogue of known deviations from the intended model.

### All Route Prefixes

| Controller path | Auth required | Swagger tag |
| --- | --- | --- |
| `/auth` | No (issues the JWT) | Authentication |
| `/escrows` | No (IP rate-limited only) | Escrow |
| `/webhooks` | No (IP rate-limited only) | Webhooks |
| `/health`, `/metrics` | No | Monitoring |
| `/gigs` | Partial — reads public, writes require JWT | Gigs |
| `/profiles` | Partial — reads public (never include the email address), writes and `GET /profiles/me` require JWT | User Profiles |
| `/deliverables` | Yes (JWT) | Deliverables |
| `/dispute` | Yes (JWT) | Dispute Resolution |
| `/reputation` | No | Reputation |
| `/ipfs/pins` | Yes (JWT) | IPFS Pinning |
| `/outbox` | Yes (JWT) | Outbox |
| `/escrow-reconciliation` | Yes (JWT) | Escrow Reconciliation |
| `/event-ingestion` | No | Event Ingestion |
| `/events/soroban` | No | Soroban Events |
| `/stellar` | No | Stellar |
| `/rpc-status` | Yes (JWT) | RPC Status |
| `/migrations` | Yes (JWT + admin allow-list) | Schema Migrations |
| `/admin/analytics` | Yes (JWT + admin allow-list) | Admin |

### Auth (`/auth`)

- **`GET /auth/challenge`** — Get authentication challenge for wallet signing
- **`POST /auth/verify`** — Verify wallet signature, returns JWT
- JWT Guard protects downstream routes that require it (see table above — several routes are intentionally public and rely on IP-scoped rate limiting instead).

#### Authentication Flow

1. **Request Challenge**: Client requests a cryptographic challenge for their wallet address
2. **Sign Challenge**: User signs the challenge with their Freighter wallet
3. **Verify & Get Token**: Client sends the signature to verify and receive a JWT token
4. **Use Token**: Include JWT in Authorization header for authenticated requests

#### Example Usage

```bash
# 1. Get challenge
curl "http://localhost:3001/auth/challenge?address=GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"

# 2. Sign challenge with Freighter wallet (client-side)

# 3. Verify signature and get JWT
curl -X POST http://localhost:3001/auth/verify \
  -H "Content-Type: application/json" \
  -d '{"address":"G...","signature":"..."}'

# 4. Use JWT for authenticated requests
curl http://localhost:3001/escrows \
  -H "Authorization: Bearer <jwt-token>"
```

### Escrow (`/escrows`)

- **`POST /escrows`** — Create a new escrow vault.
- **`GET /escrows/:id`** — Fetch escrow state and milestone details.
- **`GET /escrows/depositor/:address`** — Get all escrows by depositor
- **`POST /escrows/:id/release`** — Approve a milestone tranche.
- **`POST /escrows/:id/dispute`** — Raise a dispute (triggers Discord notification).

### Webhooks (`/webhooks`)

- **`POST /webhooks`** — Register a webhook endpoint (supports optional HMAC `secret` for payload signing).
- **`DELETE /webhooks/:id`** — Unregister a webhook.
- **HMAC Signatures**: Secure outgoing payloads with `X-TrustFlow-Signature` (HMAC-SHA256). [Verification Guide](docs/webhook-signatures.md)
- Automatic retry logic handles delivery failures gracefully.
- **Discord Integration**: Automatically notifies a Discord channel when disputes need jurors. [Setup Guide](backend/src/webhook/DISCORD_INTEGRATION.md)

### Monitoring (`/health`, `/metrics`)

- **`GET /health`** — Liveness and readiness probe.
- **`GET /metrics`** — Prometheus-compatible metrics endpoint.

---

## 🛡️ Security

- **Wallet Signature Verification**: Uses @stellar/stellar-sdk for cryptographic signature verification
- **Challenge Expiration**: Challenges expire after 60 seconds to prevent replay attacks
- **One-Time Use**: Each challenge can only be used once
- **JWT Expiration**: Tokens expire after 24 hours
- **Address Validation**: Validates Stellar public key format (G-prefixed, 56 characters)
- **Input Validation**: Uses class-validator DTOs on all endpoints
- **Distributed Rate Limiting**: Coordinates per-IP and per-wallet token buckets through Redis across API nodes
- **Abuse Lockouts**: Tracks repeated limit violations in a sliding window and temporarily locks abusive identities
- **Guard Middleware**: All protected routes require valid JWT via JwtAuthGuard
- **Environment Secrets**: Never logged or exposed in responses

For detailed authentication implementation documentation, see [AUTH_IMPLEMENTATION.md](backend/src/auth/AUTH_IMPLEMENTATION.md).

---

## 🔄 CI/CD

The project uses GitHub Actions for continuous integration — a single `ci` job (lint,
format check, type check, tests against a `redis:7-alpine` service container, build, and an
`npm audit` gate) running on the Node version pinned in the repo-root `.nvmrc`:

- ✅ **Automated Testing**: Runs on every PR affecting backend code
- ✅ **Code Quality**: ESLint and Prettier checks
- ✅ **Type Safety**: TypeScript compilation and type checking
- ✅ **Dependency Audit**: `npm audit --audit-level=high` blocks the build on high/critical
  advisories
- ✅ **Branch Protection**: PRs blocked on a failing `ci` check

See [CI/CD Documentation](.github/workflows/README.md) for details.

**Local CI Check**:

```bash
cd backend && ./scripts/ci-check.sh
```

---

## 🗺️ Roadmap

- [x] **JWT Authentication with Wallet Signatures**: Implemented Stellar signature verification
- [ ] **GraphQL Layer**: Optional GraphQL gateway over REST endpoints.
- [x] **Rate Limiting**: Per-wallet and per-IP distributed throttling with Redis-backed abuse lockouts.
- [ ] **Event Sourcing**: Full audit log for all escrow state transitions.
- [ ] **Multi-network Support**: Seamless mainnet/testnet switching via config.
- [ ] **Token Refresh**: Implement refresh token mechanism for better UX
- [x] **Redis Integration**: Distributed challenge (nonce) storage via `NonceStoreService`, backed by `REDIS_CLIENT`

---

## 🤝 Community & Support

- **Documentation**: [Full API Reference](https://docs.trustflow.xyz)
- **Issues**: [Report bugs or request features](https://github.com/trustflow-protocol/trustflow-core/issues)
- **Discussions**: [Stellar Community Forum](https://stellar.org/community)

---

_Securing the future of work, one transaction at a time._

---

## 📜 License

MIT License. Copyright (c) 2026 TrustFlow Protocol.
