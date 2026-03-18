// src/processors/fees.ts

import "dotenv/config";
import { insertFeeDistribution, insertFeesClaimed }        from "../utils/db/fees";
import { EVENT_CHANNELS }                                  from "../clients/redis";
import { BaseProcessor }                                   from "./base-processor";
import { logger }                                          from "../utils/logger";
import type { DecodedEvent, PoolFeesDistributedEvent, FeesClaimedEvent } from "../types/events";

class FeeProcessor extends BaseProcessor {
  get channel() { return EVENT_CHANNELS.fees; }

  async handle(event: DecodedEvent): Promise<void> {
    if (event.eventType === "PoolFeesDistributed") {
      const e = event as PoolFeesDistributedEvent;
      await insertFeeDistribution(this.pool, {
        id: e.id, blockNumber: e.blockNumber, blockTimestamp: e.blockTimestamp,
        txHash: e.transactionHash, tokenAddress: e.tokenAddress, poolId: e.poolId,
        totalFeeEth: e.totalFeeEth, creatorFeeEth: e.creatorFeeEth,
        protocolFeeEth: e.protocolFeeEth, feeReceiver: e.feeReceiver, chainId: e.chainId,
      });
      logger.debug({ id: e.id, token: e.tokenAddress }, "Fee distribution written");

    } else if (event.eventType === "FeesClaimed") {
      const e = event as FeesClaimedEvent;
      await insertFeesClaimed(this.pool, {
        id: e.id, blockNumber: e.blockNumber, blockTimestamp: e.blockTimestamp,
        txHash: e.transactionHash, tokenAddress: e.tokenAddress,
        claimant: e.claimant, amountEth: e.amountEth, chainId: e.chainId,
      });
      logger.debug({ id: e.id, claimant: e.claimant }, "Fees claimed written");
    }
  }
}

new FeeProcessor(
  process.env.REDIS_URL    ?? "redis://localhost:6379",
  process.env.POSTGRES_URL!
).start().catch((err) => { console.error("Fatal:", err); process.exit(1); });