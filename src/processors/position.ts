// src/processors/position.ts

import "dotenv/config";
import { getPosition, upsertPosition }   from "../utils/db/positions";
import { EVENT_CHANNELS }                from "../clients/redis";
import { BaseProcessor }                 from "./base-processor";
import { applyTradeToPosition }          from "../utils/math";
import { logger }                        from "../utils/logger";
import type { DecodedEvent, PoolSwapEvent } from "../types/events";

class PositionProcessor extends BaseProcessor {
  get channel() { return EVENT_CHANNELS.swap; }

  async handle(event: DecodedEvent): Promise<void> {
    if (event.eventType !== "PoolSwap") return;
    const e = event as PoolSwapEvent;

    const walletAddress = e.isBuy ? e.recipient : e.sender;
    const tokenAmount   = e.amount1 < 0n ? -e.amount1 : e.amount1;
    const ethAmount     = e.amount0 < 0n ? -e.amount0 : e.amount0;

    const existing = await getPosition(this.pool, walletAddress, e.tokenAddress);
    const updated  = applyTradeToPosition(existing, walletAddress, e.tokenAddress, e.isBuy, tokenAmount, ethAmount);
    await upsertPosition(this.pool, updated);

    logger.debug({ wallet: walletAddress, token: e.tokenAddress }, "Position updated");
  }
}

new PositionProcessor(
  process.env.REDIS_URL    ?? "redis://localhost:6379",
  process.env.POSTGRES_URL!
).start().catch((err) => { console.error("Fatal:", err); process.exit(1); });