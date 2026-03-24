# Token Analytics

Real-time blockchain indexer and analytics API for the FLaunch protocol on Base (Chain ID 8453). Indexes on-chain events, processes trades/candles/fees/positions, and serves data via REST API and WebSocket.

## Architecture

```
                  ┌──────────────┐
                  │  Base Chain   │
                  │  (WebSocket)  │
                  └──────┬───────┘
                         │
                  ┌──────▼───────┐
                  │   Scanner    │  Fetches logs, decodes events
                  └──────┬───────┘
                         │ XADD
                  ┌──────▼───────┐
                  │ Redis Streams │  stream:swap, stream:fees,
                  │              │  stream:meta, stream:price,
                  │              │  stream:transfer
                  └──┬───┬───┬──┘
                     │   │   │  XREADGROUP (consumer groups)
          ┌──────────┤   │   ├──────────┐
          │          │   │   │          │
     ┌────▼───┐ ┌───▼───▼┐ ┌▼────┐ ┌───▼────┐
     │ Trade  │ │ Candle  │ │Fees │ │Position│ ...
     │Processor│ │Processor│ │Proc │ │  Proc  │
     └────┬───┘ └───┬────┘ └──┬──┘ └───┬────┘
          │         │         │        │
          └─────────┴────┬────┴────────┘
                         │
                  ┌──────▼───────┐
                  │  PostgreSQL   │
                  └──────┬───────┘
                         │
                  ┌──────▼───────┐
                  │  Fastify API  │  REST + WebSocket
                  │  + Redis Cache│
                  └──────────────┘
```

## Quick Start

### Prerequisites

- Node.js 20+
- PostgreSQL 16+
- Redis 7+

### 1. Clone and install

```bash
git clone https://github.com/aryan249/token-analytics.git
cd token-analytics
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Required
ALCHEMY_WS_URL=wss://base-mainnet.g.alchemy.com/v2/YOUR_KEY
POSTGRES_URL=postgresql://postgres:password@localhost:5432/flaunch
REDIS_URL=redis://localhost:6379

# Chain config
CHAIN_ID=8453
CONFIRMATION_DEPTH=3
BATCH_SIZE=100

# API
API_PORT=3000

# Auth (optional — leave empty to disable)
# JWT_SECRET=your-secret-at-least-32-chars
# JWT_EXPIRY=24h

# Logging
LOG_LEVEL=info
NODE_ENV=development
```

### 3. Create the database

```bash
createdb flaunch
```

Schema is bootstrapped automatically on first run.

### 4. Start all services

Start each in a separate terminal:

```bash
# Scanner (indexer)
npx ts-node --transpile-only src/indexer/main.ts

# Processors
npx ts-node --transpile-only src/processors/trade.ts
npx ts-node --transpile-only src/processors/token.ts
npx ts-node --transpile-only src/processors/candle.ts
npx ts-node --transpile-only src/processors/fees.ts
npx ts-node --transpile-only src/processors/position.ts
npx ts-node --transpile-only src/processors/price.ts

# API server
npx ts-node --transpile-only src/api/server.ts
```

### 5. Verify

```bash
curl http://localhost:3000/health
# {"status":"ok","timestamp":"2026-03-24T09:00:00.000Z","wsClients":0}
```

## Docker Setup

```bash
# Start PostgreSQL and Redis
docker compose up -d postgres redis

# Start all services
docker compose up -d
```

## API Reference

Base URL: `http://localhost:3000`

### Authentication (optional)

When `JWT_SECRET` is set, all endpoints except `/health`, `/auth/nonce`, and `/auth/login` require a JWT token.

**Get nonce:**
```bash
curl "http://localhost:3000/auth/nonce?wallet=0xYOUR_WALLET"
```
```json
{
  "nonce": "a1b2c3...",
  "message": "Sign this message to authenticate with FLaunch Analytics:\n\na1b2c3..."
}
```

**Login (sign the message with your wallet, then):**
```bash
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"wallet":"0xYOUR_WALLET","signature":"0xSIGNATURE"}'
```
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "wallet": "0xyour_wallet"
}
```

**Use the token:**
```bash
curl -H "Authorization: Bearer YOUR_JWT" http://localhost:3000/tokens
```

### GET /tokens

List all tokens sorted by market cap.

```bash
curl "http://localhost:3000/tokens?sort=marketCap&limit=2&offset=0"
```

Query params: `sort` (marketCap|volume|trades|newest), `limit` (max 200), `offset`

```json
[
  {
    "tokenAddress": "0xac80a965d0f45aba319f232797be09b9514980ca",
    "image": "https://i.flaunch.gg/token/0xac80a965d0f45aba319f232797be09b9514980ca",
    "symbol": "ZRX",
    "name": "0xTennis",
    "priceETH": "0.000000000049228561",
    "priceUSD": "1.0578719437966878e-7",
    "twentyFourHourChangePercentage": 0.026,
    "twentyFourHourVolume": "0.00773178300712539",
    "twentyFourHourVolumeUSD": "16.62",
    "tradeCount24h": 6,
    "holderCount": 2,
    "feesEarned": "0",
    "feesEarnedUSD": "0",
    "marketCapETH": "4.9228561",
    "marketCapUSD": "10578.72",
    "discoveredAt": "2026-03-23T12:51:54.224Z",
    "royaltyMembers": [
      { "address": "0xb326992107e505ebc4296d8a680f637c0f874c79", "percentage": 100 }
    ],
    "hourData": [
      {
        "periodStartUnix": 1774256400,
        "volumeETH": "0.00773178300712539",
        "volumeUSD": "16.62",
        "openPriceETH": "0.000000000049228419",
        "closePriceETH": "0.000000000049228561"
      }
    ]
  }
]
```

### GET /tokens/:address

Token detail with fair launch info.

```bash
curl http://localhost:3000/tokens/0x7b74e3a136de6c8d379e0e97c66b48adbbe72aa8
```

```json
{
  "tokenAddress": "0x7b74e3a136de6c8d379e0e97c66b48adbbe72aa8",
  "symbol": "FUGABE",
  "name": "fugabe",
  "priceETH": "0.000000000046950517",
  "priceUSD": "1.0089190842090516e-7",
  "twentyFourHourChangePercentage": 0.067,
  "twentyFourHourVolume": "3.527",
  "twentyFourHourVolumeUSD": "7579.19",
  "tradeCount24h": 62,
  "holderCount": 8,
  "feesEarned": "0.035059915155299793",
  "feesEarnedUSD": "75.34",
  "marketCapETH": "4.6950517",
  "marketCapUSD": "10089.19",
  "poolId": "0x...",
  "pmAddress": "0x...",
  "fairLaunch": null,
  "description": null,
  "website": null,
  "twitter": null,
  "telegram": null,
  "royaltyMembers": [...],
  "hourData": [...]
}
```

### GET /tokens/:address/candles

OHLCV candle data.

```bash
curl "http://localhost:3000/tokens/0x.../candles?resolution=1h&from=1774280000&to=1774290000"
```

Query params: `resolution` (1m|15m|1h|4h|1d), `from` (unix), `to` (unix)

```json
[
  {
    "bucketTime": "1774281600",
    "openEth": "46918994",
    "highEth": "71320871",
    "lowEth": "46918994",
    "closeEth": "50993272",
    "volumeEth": "3297871983142273154",
    "tradeCount": 57,
    "openUSD": "1.008e-7",
    "highUSD": "1.532e-7",
    "lowUSD": "1.008e-7",
    "closeUSD": "1.095e-7",
    "volumeUSD": "7086.79"
  }
]
```

### GET /tokens/:address/trades

Paginated trade history.

```bash
curl "http://localhost:3000/tokens/0x.../trades?limit=10&offset=0"
```

```json
{
  "trades": [
    {
      "id": "0xb337...382651:462",
      "txHash": "0x8d9bfdd6...",
      "blockTimestamp": "1774291709",
      "isBuy": true,
      "amountETH": "0.225349609355869707",
      "amountTokens": "4580992784630762191489302324",
      "priceETH": "0.000000000049192308",
      "priceUSD": "1.057e-7",
      "feeETH": "0.002253496093558697",
      "trader": "0x...",
      "phase": "swap",
      "amountUSD": "484.25"
    }
  ],
  "total": 59,
  "limit": 10,
  "offset": 0
}
```

### GET /tokens/:address/holders

Token holder balances.

```bash
curl "http://localhost:3000/tokens/0x.../holders?limit=5&offset=0"
```

```json
{
  "holders": [
    {
      "wallet": "0x498581ff718922c3f8e6a244956af099b2652b2b",
      "balance": "99968551841289376070084580451",
      "balanceUSD": "10086.01",
      "percentage": "99.9685"
    }
  ],
  "total": 8,
  "limit": 5,
  "offset": 0
}
```

### PATCH /tokens/:address/metadata

Update token metadata (creator only).

```bash
curl -X PATCH http://localhost:3000/tokens/0x.../metadata \
  -H "Content-Type: application/json" \
  -d '{"creator":"0xCREATOR","description":"My token","website":"https://..."}'
```

### GET /users/:wallet/positions

Wallet token positions with unrealized PnL.

```bash
curl http://localhost:3000/users/0xWALLET/positions
```

```json
{
  "positions": [
    {
      "tokenAddress": "0x...",
      "name": "FUGABE",
      "symbol": "FUGABE",
      "balance": "1000000000000000000",
      "valueETH": "0.046950517",
      "valueUSD": "100.89",
      "priceETH": "0.000000000046950517",
      "priceUSD": "1.008e-7",
      "pctOfSupply": "0.0010",
      "costBasisETH": "0.045",
      "unrealizedPnlETH": "0.001950517",
      "unrealizedPnlUSD": "4.19",
      "realizedPnlETH": "0",
      "realizedPnlUSD": "0"
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```

### GET /users/:wallet/royalties

Wallet royalty earnings breakdown.

```bash
curl http://localhost:3000/users/0xWALLET/royalties
```

```json
{
  "totalEarnedEth": "35059915155299793",
  "totalClaimedEth": "0",
  "claimableEth": "35059915155299793",
  "totalEarnedUSD": "75.34",
  "byToken": [
    {
      "tokenAddress": "0x...",
      "name": "fugabe",
      "symbol": "FUGABE",
      "earnedEth": "35059915155299793",
      "earnedUSD": "75.34",
      "claimedEth": "0",
      "claimableEth": "35059915155299793",
      "feeSharePct": "100.00",
      "marketCapETH": "4695051700000000000",
      "marketCapUSD": "10089.19"
    }
  ]
}
```

### GET /users/:wallet/activity

Wallet activity feed (trades + fee claims).

```bash
curl "http://localhost:3000/users/0xWALLET/activity?limit=20&offset=0"
```

### GET /stats

Platform-wide statistics.

```bash
curl http://localhost:3000/stats
```

```json
{
  "totalTokens": 685,
  "totalTrades": 95,
  "totalHolders": 12,
  "totalVolumeETH": "3.703461456194705911",
  "totalVolumeUSD": "7958.36",
  "totalFeesETH": "0.036092620083439855",
  "totalFeesUSD": "77.56",
  "topFeeEarners24h": [
    { "wallet": "0x71fa...", "earnedETH": "35059915155299793", "earnedUSD": "75.34" }
  ]
}
```

### GET /stats/top-earners

Top fee earning tokens.

```bash
curl "http://localhost:3000/stats/top-earners?limit=10"
```

## WebSocket

Connect to `ws://localhost:3000/ws` (or `ws://localhost:3000/ws?token=JWT` when auth is enabled).

**Events received on connect:**
- `tokenList` — full token list sorted by market cap

**Events received in real-time:**
- `activity` — every trade (buy/sell)
- `priceUpdate` — price + market cap change
- `candle` — OHLCV candle tip update
- `sparklineUpdate` — last 24 hourly closes
- `coinFeeUpdate` — fee distribution for a token
- `protocolFeeUpdate` — protocol fee delta
- `new_token` — new token launched

**Client can send:**
- `{"type":"ping"}` → receives `{"type":"pong"}`

**Example:**
```javascript
const ws = new WebSocket("ws://localhost:3000/ws");

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  switch (msg.type) {
    case "tokenList":
      console.log(`${msg.data.length} tokens`);
      break;
    case "activity":
      console.log(`${msg.data.type} ${msg.data.coin.symbol} $${msg.data.amountUSD}`);
      break;
    case "priceUpdate":
      console.log(`${msg.data.coinAddress} price=${msg.data.priceETH}`);
      break;
  }
};
```

## Services

| Service | Command | Redis Stream | Description |
|---------|---------|-------------|-------------|
| Scanner | `src/indexer/main.ts` | Publishes to all | Fetches on-chain logs, decodes events |
| Trade Processor | `src/processors/trade.ts` | `stream:swap` | Writes trades, resolves maker addresses |
| Candle Processor | `src/processors/candle.ts` | `stream:swap` | Builds OHLCV candles (1m/15m/1h/4h/1d) |
| Token Processor | `src/processors/token.ts` | `stream:meta` | Registers tokens, fetches ERC-20 metadata |
| Fee Processor | `src/processors/fees.ts` | `stream:fees` | Tracks fee distributions |
| Position Processor | `src/processors/position.ts` | `stream:transfer` | Tracks holder balances from ERC-20 transfers |
| Price Processor | `src/processors/price.ts` | `stream:price` | Updates ETH/USD rate from Chainlink |
| API Server | `src/api/server.ts` | — | REST API + WebSocket gateway |

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ALCHEMY_WS_URL` | Yes | — | Alchemy WebSocket RPC URL for Base |
| `POSTGRES_URL` | Yes | — | PostgreSQL connection string |
| `REDIS_URL` | No | `redis://localhost:6379` | Redis connection string |
| `CHAIN_ID` | No | `8453` | Chain ID (Base) |
| `CONFIRMATION_DEPTH` | No | `3` | Blocks to wait before processing |
| `BATCH_SIZE` | No | `100` | Blocks per catch-up batch |
| `START_BLOCK` | No | — | Override start block (otherwise resumes from checkpoint) |
| `API_PORT` | No | `3000` | API server port |
| `POSTGRES_READ_URL` | No | — | Read replica URL (falls back to POSTGRES_URL) |
| `JWT_SECRET` | No | — | Set to enable wallet-based JWT auth |
| `JWT_EXPIRY` | No | `24h` | JWT token expiry |
| `LOG_LEVEL` | No | `info` | Log level (debug/info/warn/error) |
| `NODE_ENV` | No | `development` | Environment |
