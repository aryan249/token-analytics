// src/processors/position.ts

import "dotenv/config";
import { EVENT_CHANNELS } from "../clients/redis";
import { BaseProcessor }  from "./base-processor";
import { logger }         from "../utils/logger";
import type { DecodedEvent, PoolSwapEvent } from "../types/events";

// NOTE: PoolSwap no longer carries sender/recipient — wallet position tracking
// must be driven by ERC-20 Transfer events instead. This processor is a placeholder
// until ERC-20-based position tracking is implemented.

class PositionProcessor extends BaseProcessor {
  get channel() { return EVENT_CHANNELS.swap; }

  async handle(event: DecodedEvent): Promise<void> {
    if (event.eventType !== "PoolSwap") return;
    const e = event as PoolSwapEvent;
    if (!e.tokenAddress) return;

    // TODO: replace with ERC-20 Transfer based position tracking
    logger.debug({ token: e.tokenAddress, poolId: e.poolId }, "PoolSwap observed (position tracking pending ERC-20 Transfer impl)");
  }
}

new PositionProcessor(
  process.env.REDIS_URL    ?? "redis://localhost:6379",
  process.env.POSTGRES_URL!
).start().catch((err) => { console.error("Fatal:", err); process.exit(1); });
