import { createClient, type RedisClientType } from "redis";
import { logger } from "../utils/logger";
import { ALL_RESOLUTIONS } from "../utils/constants";

export type RedisClient = RedisClientType;

export async function makeRedisClient(url: string): Promise<RedisClient> {
  const client = createClient({ url }) as RedisClient;
  client.on("error",        (err) => logger.error({ err }, "Redis client error"));
  client.on("reconnecting", ()    => logger.warn("Redis reconnecting"));
  client.on("ready",        ()    => logger.info("Redis ready"));
  await client.connect();
  return client;
}

export const KEYS = {
  // Processor-side state blobs
  tokenState:  (tokenAddress: string)                     => `token:${tokenAddress.toLowerCase()}`,
  ethUsdRate:  ()                                         => "chainlink:eth_usd",
  candleTip:   (tokenAddress: string, resolution: string) => `candle:${tokenAddress.toLowerCase()}:${resolution}`,
  walletState: (walletAddress: string)                    => `wallet:${walletAddress.toLowerCase()}`,
  // API response cache (invalidated by processors on write)
  apiTokenList: ()                                        => "api:tokens:list",
  apiCandles:   (tokenAddress: string, resolution: string) => `api:candles:${tokenAddress.toLowerCase()}:${resolution}`,
  apiPositions:   (walletAddress: string)                   => `api:positions:${walletAddress.toLowerCase()}`,
  apiRoyalties:   (walletAddress: string)                   => `api:royalties:${walletAddress.toLowerCase()}`,
  apiActivity:    (walletAddress: string)                   => `api:activity:${walletAddress.toLowerCase()}`,
  apiTokenDetail: (tokenAddress: string)                    => `api:token:${tokenAddress.toLowerCase()}`,
  apiTrades:      (tokenAddress: string, offset: number)    => `api:trades:${tokenAddress.toLowerCase()}:${offset}`,
  apiHolders:     (tokenAddress: string, offset: number)    => `api:holders:${tokenAddress.toLowerCase()}:${offset}`,
  apiStats:       ()                                        => "api:stats",
  // Segregated token cache — per-token fast-changing data, independent TTLs
  tokenPrice:    (tokenAddress: string)                    => `tp:${tokenAddress.toLowerCase()}`,
  tokenVolume:   (tokenAddress: string)                    => `tv:${tokenAddress.toLowerCase()}`,
  tokenHolders:  (tokenAddress: string)                    => `th:${tokenAddress.toLowerCase()}`,
  tokenMeta:     (tokenAddress: string)                    => `tm:${tokenAddress.toLowerCase()}`,
  tokenFees:     (tokenAddress: string)                    => `tf:${tokenAddress.toLowerCase()}`,
  tokenSparkline:(tokenAddress: string)                    => `ts:${tokenAddress.toLowerCase()}`,
} as const;

export const TTL = {
  tokenState:  60,
  ethUsdRate:  3600,
  candleTip:   60,
  walletState: 120,
} as const;

// ── Lua script for atomic OHLCV candle upsert in Redis ──────────────────────
// Key: candle:{tokenAddress}:{resolution}:{bucketTime}
// Args: priceEth, volumeEth, ttlSeconds
// Returns: [open, high, low, close, volume, tradeCount] as strings
export const CANDLE_UPSERT_LUA = `
local key = KEYS[1]
local price = ARGV[1]
local volume = ARGV[2]
local ttl = tonumber(ARGV[3])

local exists = redis.call('EXISTS', key)
if exists == 0 then
  -- New candle: set all OHLCV fields
  redis.call('HMSET', key,
    'open', price, 'high', price, 'low', price, 'close', price,
    'volume', volume, 'count', '1')
  if ttl > 0 then redis.call('EXPIRE', key, ttl) end
  return {price, price, price, price, volume, '1'}
end

-- Existing candle: update high/low/close, accumulate volume + count
local high = redis.call('HGET', key, 'high')
local low = redis.call('HGET', key, 'low')
local vol = redis.call('HGET', key, 'volume') or '0'
local cnt = redis.call('HGET', key, 'count') or '0'

-- Compare as strings (BigInt-safe): lexicographic works for same-length numeric strings
-- We pad to 78 chars (max uint256 length) for correct comparison
local function padNum(s) return string.rep('0', 78 - #s) .. s end

if padNum(price) > padNum(high) then redis.call('HSET', key, 'high', price) high = price end
if padNum(price) < padNum(low) then redis.call('HSET', key, 'low', price) low = price end
redis.call('HSET', key, 'close', price)

-- Volume + count: we do string addition in Lua (safe for integers up to 2^53)
local newVol = tostring(tonumber(vol) + tonumber(volume))
local newCnt = tostring(tonumber(cnt) + 1)
redis.call('HMSET', key, 'volume', newVol, 'count', newCnt)

local open = redis.call('HGET', key, 'open')
return {open, high, low, price, newVol, newCnt}
`;

export function candleRedisKey(tokenAddress: string, resolution: string, bucketTime: string): string {
  return `ohlcv:${tokenAddress.toLowerCase()}:${resolution}:${bucketTime}`;
}

/** Atomically upsert a candle in Redis using Lua. Returns the updated OHLCV. */
export async function upsertCandleRedis(
  client: RedisClient,
  tokenAddress: string,
  resolution: string,
  bucketTime: string,
  priceEth: string,
  volumeEth: string,
  ttlSeconds = 172800, // 48h default — covers 24h sparkline + buffer
): Promise<{ open: string; high: string; low: string; close: string; volume: string; count: string }> {
  const key = candleRedisKey(tokenAddress, resolution, bucketTime);
  const result = await client.eval(CANDLE_UPSERT_LUA, {
    keys: [key],
    arguments: [priceEth, volumeEth, ttlSeconds.toString()],
  }) as string[];
  return {
    open:   result[0],
    high:   result[1],
    low:    result[2],
    close:  result[3],
    volume: result[4],
    count:  result[5],
  };
}

// ── Event streams (indexer → processors via Redis Streams) ───────────────────

export const EVENT_CHANNELS = {
  swap:     "stream:swap",      // PoolSwap + PoolStateUpdated → trade + candle
  fees:     "stream:fees",      // PoolFeesDistributed   → fee processor
  meta:     "stream:meta",      // PoolCreated           → token processor
  price:    "stream:price",     // ChainlinkAnswerUpdated → price processor
  transfer: "stream:transfer",  // ERC20Transfer         → holder balances
} as const;

export type EventChannel = (typeof EVENT_CHANNELS)[keyof typeof EVENT_CHANNELS];

/** Max stream length before older entries are trimmed (approximate). */
export const STREAM_MAX_LEN = 10_000;

// ── UI streams (processors → WebSocket gateway via Redis Streams) ────────────

export const UI_STREAMS = {
  trades:   "stream:ui:trades",    // trade activity + price updates
  candles:  "stream:ui:candles",   // candle tip updates
  fees:     "stream:ui:fees",      // fee distributions
  rate:     "stream:ui:rate",      // ETH/USD rate changes
} as const;

// ── Pub/Sub channels (fan-out to ALL gateway pods — every pod gets every message)
export const PUBSUB_CHANNELS = {
  trades:  "pubsub:ui:trades",
  candles: "pubsub:ui:candles",
  fees:    "pubsub:ui:fees",
  rate:    "pubsub:ui:rate",
  meta:    "pubsub:ui:meta",
} as const;

export async function setTokenState(client: RedisClient, tokenAddress: string, state: object): Promise<void> {
  await client.setEx(KEYS.tokenState(tokenAddress), TTL.tokenState, JSON.stringify(state));
}

export async function setEthUsdRate(client: RedisClient, rate: bigint): Promise<void> {
  await client.setEx(KEYS.ethUsdRate(), TTL.ethUsdRate, rate.toString());
}

export async function getEthUsdRate(client: RedisClient): Promise<bigint | null> {
  const raw = await client.get(KEYS.ethUsdRate());
  return raw ? BigInt(raw) : null;
}

export async function setCandleTip(client: RedisClient, tokenAddress: string, resolution: string, candle: object): Promise<void> {
  await client.setEx(KEYS.candleTip(tokenAddress, resolution), TTL.candleTip, JSON.stringify(candle));
}

export async function setWalletState(client: RedisClient, walletAddress: string, state: object): Promise<void> {
  await client.setEx(KEYS.walletState(walletAddress), TTL.walletState, JSON.stringify(state));
}

export async function flushTokenCache(client: RedisClient, tokenAddress: string): Promise<void> {
  const keys = [KEYS.tokenState(tokenAddress), ...ALL_RESOLUTIONS.map((r) => KEYS.candleTip(tokenAddress, r))];
  await client.del(keys);
}

export async function publishTokenUpdate(client: RedisClient, _tokenAddress: string, payload: object): Promise<void> {
  const msg = JSON.stringify(payload);
  await Promise.all([
    client.xAdd(UI_STREAMS.trades, "*", { data: msg },
      { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: STREAM_MAX_LEN } }),
    client.publish(PUBSUB_CHANNELS.trades, msg),
  ]);
}

export async function publishCandleUpdate(client: RedisClient, tokenAddress: string, resolution: string, payload: object): Promise<void> {
  const msg = JSON.stringify({ ...payload, tokenAddress, resolution });
  await Promise.all([
    client.xAdd(UI_STREAMS.candles, "*", { data: msg },
      { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: STREAM_MAX_LEN } }),
    client.publish(PUBSUB_CHANNELS.candles, msg),
  ]);
}

export async function publishWalletUpdate(client: RedisClient, walletAddress: string, payload: object): Promise<void> {
  const msg = JSON.stringify({ ...payload, walletAddress });
  await Promise.all([
    client.xAdd(UI_STREAMS.trades, "*", { data: msg },
      { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: STREAM_MAX_LEN } }),
    client.publish(PUBSUB_CHANNELS.trades, msg),
  ]);
}

export async function publishCoinFeeUpdate(client: RedisClient, _tokenAddress: string, payload: object): Promise<void> {
  const msg = JSON.stringify(payload);
  await Promise.all([
    client.xAdd(UI_STREAMS.fees, "*", { data: msg },
      { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: STREAM_MAX_LEN } }),
    client.publish(PUBSUB_CHANNELS.fees, msg),
  ]);
}

export async function publishProtocolFeeUpdate(client: RedisClient, payload: object): Promise<void> {
  const msg = JSON.stringify({ ...payload, type: "protocol" });
  await Promise.all([
    client.xAdd(UI_STREAMS.fees, "*", { data: msg },
      { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: STREAM_MAX_LEN } }),
    client.publish(PUBSUB_CHANNELS.fees, msg),
  ]);
}