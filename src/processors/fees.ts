import "dotenv/config";
import { insertFeeDistribution, insertFeeEscrowWithdrawal } from "../utils/db/fees";
import {
  EVENT_CHANNELS, publishWalletUpdate, publishCoinFeeUpdate, publishProtocolFeeUpdate,
  getEthUsdRate, KEYS,
}                                                            from "../clients/redis";
import { invalidate }                                        from "../api/cache";
import { ethPriceToUsd }                                     from "../utils/math";
import { BaseProcessor }                                    from "./base-processor";
import { logger }                                           from "../utils/logger";
import type {
  DecodedEvent,
  PoolFeesDistributedEvent,
  FeeEscrowWithdrawalEvent,
} from "../types/events";

class FeeProcessor extends BaseProcessor {
  get channel() { return EVENT_CHANNELS.fees; }
  get groupName() { return "fee-processor"; }

  async handle(event: DecodedEvent): Promise<void> {
    if (event.eventType === "PoolFeesDistributed") {
      const e = event as PoolFeesDistributedEvent;

      // Skip if token address couldn't be resolved from pool id
      if (!e.tokenAddress) {
        logger.debug({ poolId: e.poolId }, "PoolFeesDistributed: unknown pool, skipping");
        return;
      }
      const tokenAddress = e.tokenAddress;

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

      // Publish to WebSocket gateway
      const ethUsdRate   = await getEthUsdRate(this.publisher);
      const totalFeesEth = e.creatorAmount + e.protocolAmount;
      const feesUSD      = ethUsdRate ? ethPriceToUsd(totalFeesEth, ethUsdRate).toFixed(18) : "0";
      const deltaUSD     = ethUsdRate ? ethPriceToUsd(e.protocolAmount, ethUsdRate).toFixed(18) : "0";

      await publishCoinFeeUpdate(this.publisher, tokenAddress, {
        coinAddress:    tokenAddress,
        creatorFeesETH: e.creatorAmount.toString(),
        feesUSD,
        timestamp:      Number(e.blockTimestamp),
      });

      if (e.protocolAmount > 0n) {
        await publishProtocolFeeUpdate(this.publisher, { deltaUSD });
      }

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
