// src/processors/candle.ts
//
// Dual write:
//   1. Redis Lua atomic OHLCV upsert (sub-ms) → real-time UI via Pub/Sub
//   2. Postgres batch upsert (1 query for all 5 resolutions) → durability
//
// If Redis dies: Postgres has the data, UI recovers on reconnect.
// If Postgres dies: Redis has the data, processor retries on next event (base-processor retry).
// If processor dies: both Redis and Postgres have the data up to the last processed event.

import "dotenv/config";
import { upsertCandleBatch } from "../utils/db/candles";
import {
  EVENT_CHANNELS, publishCandleUpdate, setCandleTip, KEYS,
  upsertCandleRedis,
} from "../clients/redis";
import { invalidate } from "../api/cache";
import { BaseProcessor } from "./base-processor";
import { getBucketTime, ALL_RESOLUTIONS } from "../utils/math";
import { logger } from "../utils/logger";
import type { Candle, CandleResolution, DecodedEvent, PoolSwapEvent } from "../types/events";

class CandleProcessor extends BaseProcessor {
  get channel() { return EVENT_CHANNELS.swap; }
  get groupName() { return "candle-processor"; }

  async handle(event: DecodedEvent): Promise<void> {
    if (event.eventType !== "PoolSwap") return;
    const e = event as PoolSwapEvent;

    if (!e.tokenAddress || e.priceEth === 0n) return;

    // Build candles for all 5 resolutions
    const candles: Candle[] = [];

    for (const resolution of ALL_RESOLUTIONS) {
      const bucketTime = getBucketTime(e.blockTimestamp, resolution);
      const bucketStr = bucketTime.toString();

      candles.push({
        tokenAddress: e.tokenAddress,
        resolution:   resolution as CandleResolution,
        bucketTime,
        openEth:  e.priceEth,
        highEth:  e.priceEth,
        lowEth:   e.priceEth,
        closeEth: e.priceEth,
        volumeEth: e.volumeEth,
        tradeCount: 1,
      });

      // Fast path: atomic Redis Lua OHLCV upsert (sub-ms, for real-time UI)
      const candle = await upsertCandleRedis(
        this.publisher,
        e.tokenAddress,
        resolution,
        bucketStr,
        e.priceEth.toString(),
        e.volumeEth.toString(),
      );

      // Publish tip to UI via Pub/Sub
      const tip = {
        type:         "candle",
        tokenAddress: e.tokenAddress,
        resolution,
        bucketTime:   bucketStr,
        closeEth:     candle.close,
        volumeEth:    candle.volume,
      };
      await invalidate(this.publisher, KEYS.apiCandles(e.tokenAddress, resolution));
      await setCandleTip(this.publisher, e.tokenAddress, resolution, tip);
      await publishCandleUpdate(this.publisher, e.tokenAddress, resolution, tip);
    }

    // Durable path: batch upsert all 5 resolutions in 1 Postgres query
    await upsertCandleBatch(this.pool, candles);

    logger.debug({ token: e.tokenAddress, price: e.priceEth.toString() }, "Candles updated");
  }
}

new CandleProcessor(
  process.env.REDIS_URL    ?? "redis://localhost:6379",
  process.env.POSTGRES_URL!
).start().catch((err) => { console.error("Fatal:", err); process.exit(1); });
