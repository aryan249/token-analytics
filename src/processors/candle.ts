// src/processors/candle.ts

import "dotenv/config";
import { upsertCandle } from "../utils/db/candles";
import { EVENT_CHANNELS } from "../clients/redis";
import { BaseProcessor } from "./base-processor";
import { sqrtPriceX96ToEthPrice, getBucketTime, ALL_RESOLUTIONS } from "../utils/math";
import { logger } from "../utils/logger";
import type { DecodedEvent, PoolSwapEvent } from "../types/events";

class CandleProcessor extends BaseProcessor {
  get channel() { return EVENT_CHANNELS.swap; }

  async handle(event: DecodedEvent): Promise<void> {
    if (event.eventType !== "PoolSwap") return;
    const e = event as PoolSwapEvent;

    const priceEth  = sqrtPriceX96ToEthPrice(e.sqrtPriceX96);
    const volumeEth = e.amount0 < 0n ? -e.amount0 : e.amount0;

    for (const resolution of ALL_RESOLUTIONS) {
      const bucketTime = getBucketTime(e.blockTimestamp, resolution);
      await upsertCandle(this.pool, {
        tokenAddress: e.tokenAddress, resolution, bucketTime,
        openEth: priceEth, highEth: priceEth, lowEth: priceEth, closeEth: priceEth,
        volumeEth, tradeCount: 1,
      });
    }

    logger.debug({ token: e.tokenAddress, price: priceEth.toString() }, "Candles updated");
  }
}

new CandleProcessor(
  process.env.REDIS_URL    ?? "redis://localhost:6379",
  process.env.POSTGRES_URL!
).start().catch((err) => { console.error("Fatal:", err); process.exit(1); });