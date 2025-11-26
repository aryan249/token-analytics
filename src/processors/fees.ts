// src/processors/fees.ts

import "dotenv/config";
import { insertFeeDistribution, insertFeeEscrowWithdrawal } from "../utils/db/fees";
import { EVENT_CHANNELS, publishWalletUpdate, KEYS }        from "../clients/redis";
import { invalidate }                                        from "../api/cache";
import { BaseProcessor }                                    from "./base-processor";
import { logger }                                           from "../utils/logger";
import type {
  DecodedEvent,
  PoolFeesDistributedEvent,
  FeeEscrowWithdrawalEvent,
} from "../types/events";

class FeeProcessor extends BaseProcessor {
  get channel() { return EVENT_CHANNELS.fees; }

  async handle(event: DecodedEvent): Promise<void> {
    if (event.eventType === "PoolFeesDistributed") {
      const e = event as PoolFeesDistributedEvent;

      // Skip if token address couldn't be resolved from pool id
      const tokenAddress = e.tokenAddress ?? e.poolId;

      await insertFeeDistribution(this.pool, {
        id:               e.id,
        blockNumber:      e.blockNumber,
        blockTimestamp:   e.blockTimestamp,
        txHash:           e.transactionHash,
        tokenAddress,
        poolId:           e.poolId,
        donateAmount:     e.donateAmount,
        creatorAmount:    e.creatorAmount,
        bidWallAmount:    e.bidWallAmount,
        governanceAmount: e.governanceAmount,
        protocolAmount:   e.protocolAmount,
        chainId:          e.chainId,
      });

      logger.debug({ id: e.id, poolId: e.poolId, token: e.tokenAddress }, "Fee distribution written");

    } else if (event.eventType === "FeeEscrowWithdrawal") {
      const e = event as FeeEscrowWithdrawalEvent;

      await insertFeeEscrowWithdrawal(this.pool, {
        id:             e.id,
        blockNumber:    e.blockNumber,
        blockTimestamp: e.blockTimestamp,
        txHash:         e.transactionHash,
        sender:         e.sender,
        recipient:      e.recipient,
        token:          e.token,
        amount:         e.amount,
        chainId:        e.chainId,
      });

      await invalidate(this.publisher, KEYS.apiRoyalties(e.recipient));
      await publishWalletUpdate(this.publisher, e.recipient, {
        type:      "fee_withdrawal",
        recipient: e.recipient,
        token:     e.token,
        amountEth: e.amount.toString(),
      });

      logger.debug({ id: e.id, recipient: e.recipient, amount: e.amount.toString() }, "Fee escrow withdrawal written");
    }
  }
}

new FeeProcessor(
  process.env.REDIS_URL    ?? "redis://localhost:6379",
  process.env.POSTGRES_URL!
).start().catch((err) => { console.error("Fatal:", err); process.exit(1); });
