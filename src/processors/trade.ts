// src/processors/trade.ts

import "dotenv/config";
import { insertTrade }               from "../utils/db/trades";
import { EVENT_CHANNELS, publishTokenUpdate, getEthUsdRate, KEYS } from "../clients/redis";
import { invalidate }                from "../api/cache";
import { BaseProcessor }             from "./base-processor";
import { ethPriceToUsd }             from "../utils/math";
import { logger }                    from "../utils/logger";
import type { DecodedEvent, PoolSwapEvent } from "../types/events";

class TradeProcessor extends BaseProcessor {
  get channel() { return EVENT_CHANNELS.swap; }

  async handle(event: DecodedEvent): Promise<void> {
    if (event.eventType !== "PoolSwap") return;
    const e = event as PoolSwapEvent;

    // Skip swaps where we couldn't resolve the token address
    if (!e.tokenAddress) return;

    const ethUsdRate = await getEthUsdRate(this.publisher);
    const priceUsd   = ethUsdRate ? ethPriceToUsd(e.priceEth, ethUsdRate) : null;

    await insertTrade(this.pool, {
      id:             e.id,
      blockNumber:    e.blockNumber,
      blockHash:      e.blockHash,
      blockTimestamp: e.blockTimestamp,
      txHash:         e.transactionHash,
      tokenAddress:   e.tokenAddress,
      poolId:         e.poolId,
      amount0Eth:     e.totalAmount0,
      amount1Tokens:  e.totalAmount1,
      priceEth:       e.priceEth,
      priceUsd,
      isBuy:          e.isBuy,
      chainId:        e.chainId,
    });

    await invalidate(this.publisher, KEYS.apiTokenList());
    await publishTokenUpdate(this.publisher, e.tokenAddress, {
      type:           "trade",
      tokenAddress:   e.tokenAddress,
      priceEth:       e.priceEth.toString(),
      isBuy:          e.isBuy,
      volumeEth:      e.volumeEth.toString(),
      txHash:         e.transactionHash,
      blockTimestamp: e.blockTimestamp.toString(),
    });

    logger.debug({ id: e.id, token: e.tokenAddress }, "Trade written");
  }
}

new TradeProcessor(
  process.env.REDIS_URL    ?? "redis://localhost:6379",
  process.env.POSTGRES_URL!
).start().catch((err) => { console.error("Fatal:", err); process.exit(1); });
