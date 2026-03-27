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
} as const;

export const TTL = {
  tokenState:  60,
  ethUsdRate:  3600,
  candleTip:   60,
  walletState: 120,
} as const;

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
  await client.xAdd(UI_STREAMS.trades, "*", { data: JSON.stringify(payload) },
    { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: STREAM_MAX_LEN } });
}

export async function publishCandleUpdate(client: RedisClient, tokenAddress: string, resolution: string, payload: object): Promise<void> {
  await client.xAdd(UI_STREAMS.candles, "*", { data: JSON.stringify({ ...payload, tokenAddress, resolution }) },
    { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: STREAM_MAX_LEN } });
}

export async function publishWalletUpdate(client: RedisClient, walletAddress: string, payload: object): Promise<void> {
  await client.xAdd(UI_STREAMS.trades, "*", { data: JSON.stringify({ ...payload, walletAddress }) },
    { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: STREAM_MAX_LEN } });
}

export async function publishCoinFeeUpdate(client: RedisClient, _tokenAddress: string, payload: object): Promise<void> {
  await client.xAdd(UI_STREAMS.fees, "*", { data: JSON.stringify(payload) },
    { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: STREAM_MAX_LEN } });
}

export async function publishProtocolFeeUpdate(client: RedisClient, payload: object): Promise<void> {
  await client.xAdd(UI_STREAMS.fees, "*", { data: JSON.stringify({ ...payload, type: "protocol" }) },
    { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: STREAM_MAX_LEN } });
}