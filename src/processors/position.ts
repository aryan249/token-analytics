// Tracks holder balances by processing ERC-20 Transfer events.

import "dotenv/config";
import type { Pool }             from "pg";
import { EVENT_CHANNELS, KEYS }  from "../clients/redis";
import { invalidate }            from "../api/cache";
import { BaseProcessor }         from "./base-processor";
import { logger }                from "../utils/logger";
import type { DecodedEvent, ERC20TransferEvent } from "../types/events";

const ZERO = "0x0000000000000000000000000000000000000000";

async function upsertBalance(
  pool: Pool,
  tokenAddress: string,
  wallet:       string,
  delta:        bigint,
  blockNumber:  bigint,
): Promise<void> {
  await pool.query(
    `INSERT INTO holder_balances (token_address, wallet, balance, updated_block)
     VALUES ($1, $2, GREATEST(0, $3::numeric), $4)
     ON CONFLICT (token_address, wallet) DO UPDATE SET
       balance       = GREATEST(0, holder_balances.balance + $3::numeric),
       updated_block = GREATEST(holder_balances.updated_block, $4)`,
    [tokenAddress.toLowerCase(), wallet.toLowerCase(), delta.toString(), blockNumber.toString()]
  );
}

/** Returns true if this event was already processed (idempotency guard). */
async function markProcessed(pool: Pool, eventId: string): Promise<boolean> {
  const res = await pool.query(
    `INSERT INTO processed_transfer_events (event_id) VALUES ($1)
     ON CONFLICT (event_id) DO NOTHING`,
    [eventId]
  );
  return res.rowCount === 0; // already existed → duplicate
}

class PositionProcessor extends BaseProcessor {
  get channel() { return EVENT_CHANNELS.transfer; }

  async handle(event: DecodedEvent): Promise<void> {
    if (event.eventType !== "ERC20Transfer") return;
    const e = event as ERC20TransferEvent;

    // Skip if already processed (protects against scanner re-scans)
    const duplicate = await markProcessed(this.pool, e.id);
    if (duplicate) {
      logger.debug({ id: e.id }, "Skipping duplicate transfer event");
      return;
    }

    const token = e.tokenAddress.toLowerCase();
    const from  = e.from.toLowerCase();
    const to    = e.to.toLowerCase();

    // Mint: from == zero — only credit receiver
    // Burn: to == zero  — only debit sender
    // Transfer: update both
    if (from !== ZERO) {
      await upsertBalance(this.pool, token, from, -e.value, e.blockNumber);
    }
    if (to !== ZERO) {
      await upsertBalance(this.pool, token, to, e.value, e.blockNumber);
    }

    // Backfill maker on the corresponding trade (same txHash, same token)
    // For a buy: tokens flow TO the buyer (recipient = to)
    // For a sell: tokens flow FROM the seller (sender = from)
    if (from !== ZERO && to !== ZERO) {
      await this.pool.query(
        `UPDATE trades SET
           sender    = CASE WHEN is_buy = false AND sender    IS NULL THEN $3 ELSE sender    END,
           recipient = CASE WHEN is_buy = true  AND recipient IS NULL THEN $4 ELSE recipient END
         WHERE tx_hash = $1 AND token_address = $2`,
        [e.transactionHash, token, from, to]
      );
    }

    // Invalidate cached holder data for this token
    await invalidate(this.publisher, KEYS.apiTokenDetail(token));
    await invalidate(this.publisher, KEYS.apiHolders(token, 0));

    logger.debug({ token, from, to, value: e.value.toString() }, "Holder balance updated");
  }
}

new PositionProcessor(
  process.env.REDIS_URL    ?? "redis://localhost:6379",
  process.env.POSTGRES_URL!
).start().catch((err) => { console.error("Fatal:", err); process.exit(1); });
