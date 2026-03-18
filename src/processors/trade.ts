// src/processors/trade.ts

import "dotenv/config";
import { insertTrade }               from "../utils/db/trades";
import { EVENT_CHANNELS }            from "../clients/redis";
import { BaseProcessor }             from "./base-processor";
import { sqrtPriceX96ToEthPrice }    from "../utils/math";
import { logger }                    from "../utils/logger";
import type { DecodedEvent, PoolSwapEvent } from "../types/events";

class TradeProcessor extends BaseProcessor {
  get channel() { return EVENT_CHANNELS.swap; }

  async handle(event: DecodedEvent): Promise<void> {
    if (event.eventType !== "PoolSwap") return;
    const e = event as PoolSwapEvent;
    const priceEth = sqrtPriceX96ToEthPrice(e.sqrtPriceX96);

    await insertTrade(this.pool, {
      id: e.id, blockNumber: e.blockNumber, blockHash: e.blockHash,
      blockTimestamp: e.blockTimestamp, txHash: e.transactionHash,
      tokenAddress: e.tokenAddress, poolId: e.poolId,
      sender: e.sender, recipient: e.recipient,
      amount0Eth: e.amount0, amount1Tokens: e.amount1,
      priceEth, priceUsd: null,
      feeEth: e.fee, isBuy: e.isBuy, phase: e.phase, chainId: e.chainId,
    });

    logger.debug({ id: e.id, token: e.tokenAddress }, "Trade written");
  }
}

new TradeProcessor(
  process.env.REDIS_URL    ?? "redis://localhost:6379",
  process.env.POSTGRES_URL!
).start().catch((err) => { console.error("Fatal:", err); process.exit(1); });