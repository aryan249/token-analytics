# API Testing Guide

## Setup

```bash
# Port forward to EKS
kubectl port-forward svc/api -n token-analytics 8080:80

# Base URL
export BASE=http://localhost:8080

# Generate JWT token
export TOKEN=$(node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({wallet:'0xtest'},'flaunch-analytics-jwt-secret-2026-prod',{expiresIn:'1h'}))")
```

## Public Endpoints (no auth required)

### Health Check
```bash
curl $BASE/health
```

### Get Nonce (for wallet login)
```bash
curl "$BASE/auth/nonce?wallet=0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
```

### Login (requires wallet signature)
```bash
curl -X POST $BASE/auth/login \
  -H "Content-Type: application/json" \
  -d '{"wallet":"0xYOUR_WALLET","signature":"0xSIGNATURE_FROM_METAMASK"}'
```

## Protected Endpoints (require JWT)

### Token List
```bash
# Default (sorted by market cap)
curl -H "Authorization: Bearer $TOKEN" "$BASE/tokens"

# With sort
curl -H "Authorization: Bearer $TOKEN" "$BASE/tokens?sort=marketCap&limit=10&offset=0"
curl -H "Authorization: Bearer $TOKEN" "$BASE/tokens?sort=volume&limit=10"
curl -H "Authorization: Bearer $TOKEN" "$BASE/tokens?sort=trades&limit=10"
curl -H "Authorization: Bearer $TOKEN" "$BASE/tokens?sort=newest&limit=10"
```

### Token Detail
```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE/tokens/0x7b74e3a136de6c8d379e0e97c66b48adbbe72aa8"
```

### Token Candles (OHLCV)
```bash
# 1 hour candles
curl -H "Authorization: Bearer $TOKEN" "$BASE/tokens/0x7b74e3a136de6c8d379e0e97c66b48adbbe72aa8/candles?resolution=1h"

# 1 minute candles
curl -H "Authorization: Bearer $TOKEN" "$BASE/tokens/0x7b74e3a136de6c8d379e0e97c66b48adbbe72aa8/candles?resolution=1m"

# With time range (unix timestamps)
curl -H "Authorization: Bearer $TOKEN" "$BASE/tokens/0x7b74e3a136de6c8d379e0e97c66b48adbbe72aa8/candles?resolution=1h&from=1774280000&to=1774360000"

# Available resolutions: 1m, 15m, 1h, 4h, 1d
```

### Token Trades
```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE/tokens/0x7b74e3a136de6c8d379e0e97c66b48adbbe72aa8/trades?limit=20&offset=0"
```

### Token Holders
```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE/tokens/0x7b74e3a136de6c8d379e0e97c66b48adbbe72aa8/holders?limit=20&offset=0"
```

### Update Token Metadata (creator only)
```bash
curl -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  "$BASE/tokens/0x7b74e3a136de6c8d379e0e97c66b48adbbe72aa8/metadata" \
  -d '{"creator":"0x71fa25bf152f205527e2911261e57ecd87b2e26b","description":"My token","website":"https://example.com","twitter":"mytoken","telegram":"mytoken"}'
```

### User Positions
```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE/users/0x71fa25bf152f205527e2911261e57ecd87b2e26b/positions?limit=20&offset=0"
```

### User Royalties
```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE/users/0x71fa25bf152f205527e2911261e57ecd87b2e26b/royalties"
```

### User Activity
```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE/users/0x71fa25bf152f205527e2911261e57ecd87b2e26b/activity?limit=20&offset=0"
```

### Platform Stats
```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE/stats"
```

### Top Fee Earners
```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE/stats/top-earners?limit=10"
```

## WebSocket

```bash
# Connect with wscat (install: npm i -g wscat)
wscat -c "ws://localhost:8080/ws?token=$TOKEN"

# Or with node
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:8080/ws?token=$TOKEN');
ws.on('message', (d) => {
  const msg = JSON.parse(d);
  console.log(msg.type, msg.type === 'tokenList' ? msg.data.length + ' tokens' : JSON.stringify(msg.data).slice(0, 100));
});
ws.on('open', () => ws.send(JSON.stringify({ type: 'ping' })));
"
```

### WebSocket Events

| Event | When | Data |
|-------|------|------|
| `tokenList` | On connect + every 2s on updates | Full token list sorted by market cap |
| `activity` | Every trade | `{id, type, coin, maker, amountUSD, timestamp, txHash}` |
| `priceUpdate` | Every trade | `{coinAddress, priceETH, priceUSD, marketCapETH, marketCapUSD}` |
| `candle` | Candle tip update | `{tokenAddress, resolution, bucketTime, openEth, highEth, lowEth, closeEth}` |
| `sparklineUpdate` | 1h candle change | `{coinAddress, sparkline}` |
| `coinFeeUpdate` | Fee distribution | Fee data for a token |
| `protocolFeeUpdate` | Protocol fee | Protocol fee delta |
| `new_token` | New token launched | Token metadata |
| `pong` | Response to ping | - |

## Error Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 400 | Bad request (invalid sort, resolution, missing fields) |
| 401 | Missing or invalid JWT token |
| 403 | Forbidden (e.g., non-creator updating metadata) |
| 404 | Token not found |

## Testing Auth Flow End-to-End

```bash
# 1. Without token (should 401)
curl -s -o /dev/null -w "%{http_code}" $BASE/tokens
# 401

# 2. Health is public (should 200)
curl -s -o /dev/null -w "%{http_code}" $BASE/health
# 200

# 3. With token (should 200)
curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TOKEN" $BASE/tokens
# 200

# 4. Expired token (should 401)
EXPIRED=$(node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({wallet:'0x'},'flaunch-analytics-jwt-secret-2026-prod',{expiresIn:'-1s'}))")
curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $EXPIRED" $BASE/tokens
# 401

# 5. WS without token (should close 4001)
node -e "const ws=new (require('ws'))('ws://localhost:8080/ws');ws.on('close',(c)=>console.log('code:',c))"
# code: 4001
```
