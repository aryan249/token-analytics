// src/processors/candle.ts

import "dotenv/config";
import { upsertCandle } from "../utils/db/candles";
import { EVENT_CHANNELS, publishCandleUpdate, setCandleTip, KEYS } from "../clients/redis";
import { invalidate } from "../api/cache";
import { BaseProcessor } from "./base-processor";
import { getBucketTime, ALL_RESOLUTIONS } from "../utils/math";
import { logger } from "../utils/logger";
import type { CandleResolution, DecodedEvent, PoolSwapEvent } from "../types/events";

class CandleProcessor extends BaseProcessor {
  get channel() { return EVENT_CHANNELS.swap; }
  get groupName() { return "candle-processor"; }

  async handle(event: DecodedEvent): Promise<void> {
    if (event.eventType !== "PoolSwap") return;
    const e = event as PoolSwapEvent;

    // Skip swaps where we couldn't resolve the token address or price is zero
    if (!e.tokenAddress || e.priceEth === 0n) return;

    for (const resolution of ALL_RESOLUTIONS) {
      const bucketTime = getBucketTime(e.blockTimestamp, resolution);
      const candle = {
        tokenAddress: e.tokenAddress,
        resolution:   resolution as CandleResolution,
        bucketTime,
        openEth:  e.priceEth,
        highEth:  e.priceEth,
        lowEth:   e.priceEth,
        closeEth: e.priceEth,
        volumeEth: e.volumeEth,
        tradeCount: 1,
      };
      await upsertCandle(this.pool, candle);

      const tip = {
        type:         "candle",
        tokenAddress: e.tokenAddress,
        resolution,
        bucketTime:   bucketTime.toString(),
        closeEth:     e.priceEth.toString(),
        volumeEth:    e.volumeEth.toString(),
      };
      await invalidate(this.publisher, KEYS.apiCandles(e.tokenAddress, resolution));
      await setCandleTip(this.publisher, e.tokenAddress, resolution, tip);
      await publishCandleUpdate(this.publisher, e.tokenAddress, resolution, tip);
    }

    logger.debug({ token: e.tokenAddress, price: e.priceEth.toString() }, "Candles updated");
  }
}

new CandleProcessor(
  process.env.REDIS_URL    ?? "redis://localhost:6379",
  process.env.POSTGRES_URL!
).start().catch((err) => { console.error("Fatal:", err); process.exit(1); });
