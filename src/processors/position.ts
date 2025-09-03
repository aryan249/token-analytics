// Tracks holder balances by processing ERC-20 Transfer events.

import "dotenv/config";
import { EVENT_CHANNELS, KEYS }  from "../clients/redis";
import { invalidate }            from "../api/cache";
import { BaseProcessor }         from "./base-processor";
import { logger }                from "../utils/logger";
import type { DecodedEvent, ERC20TransferEvent } from "../types/events";

const ZERO = "0x0000000000000000000000000000000000000000";

class PositionProcessor extends BaseProcessor {
  get channel() { return EVENT_CHANNELS.transfer; }
  get groupName() { return "position-processor"; }

  async handle(event: DecodedEvent): Promise<void> {
    if (event.eventType !== "ERC20Transfer") return;
    const e = event as ERC20TransferEvent;

    const token = e.tokenAddress.toLowerCase();
    const from  = e.from.toLowerCase();
    const to    = e.to.toLowerCase();

    // Wrap in transaction: idempotency check + balance updates + trade backfill
    // must be atomic — if balance updates succeed but trade backfill fails,
    // we'd have inconsistent state
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Skip if already processed (protects against scanner re-scans)
      const res = await client.query(
        `INSERT INTO processed_transfer_events (event_id) VALUES ($1)
         ON CONFLICT (event_id) DO NOTHING`,
        [e.id]
      );
      if (res.rowCount === 0) {
        await client.query("ROLLBACK");
        logger.debug({ id: e.id }, "Skipping duplicate transfer event");
        return;
      }

      // Mint: from == zero — only credit receiver
      // Burn: to == zero  — only debit sender
      // Transfer: update both
      if (from !== ZERO) {
        await client.query(
          `INSERT INTO holder_balances (token_address, wallet, balance, updated_block)
           VALUES ($1, $2, GREATEST(0, $3::numeric), $4)
           ON CONFLICT (token_address, wallet) DO UPDATE SET
             balance       = GREATEST(0, holder_balances.balance + $3::numeric),
             updated_block = GREATEST(holder_balances.updated_block, $4)`,
          [token, from, (-e.value).toString(), e.blockNumber.toString()]
        );
      }
      if (to !== ZERO) {
        await client.query(
          `INSERT INTO holder_balances (token_address, wallet, balance, updated_block)
           VALUES ($1, $2, GREATEST(0, $3::numeric), $4)
           ON CONFLICT (token_address, wallet) DO UPDATE SET
             balance       = GREATEST(0, holder_balances.balance + $3::numeric),
             updated_block = GREATEST(holder_balances.updated_block, $4)`,
          [token, to, e.value.toString(), e.blockNumber.toString()]
        );
      }

      // Backfill maker on the corresponding trade (same txHash, same token)
      if (from !== ZERO && to !== ZERO) {
        await client.query(
          `UPDATE trades SET
             sender    = CASE WHEN is_buy = false AND sender    IS NULL THEN $3 ELSE sender    END,
             recipient = CASE WHEN is_buy = true  AND recipient IS NULL THEN $4 ELSE recipient END
           WHERE tx_hash = $1 AND token_address = $2`,
          [e.transactionHash, token, from, to]
        );
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    // Invalidate cached holder data for this token (outside transaction — fire-and-forget)
    await invalidate(this.publisher, KEYS.apiTokenDetail(token));
    await invalidate(this.publisher, KEYS.apiHolders(token, 0));

    logger.debug({ token, from, to, value: e.value.toString() }, "Holder balance updated");
  }
}

new PositionProcessor(
  process.env.REDIS_URL    ?? "redis://localhost:6379",
  process.env.POSTGRES_URL!
).start().catch((err) => { console.error("Fatal:", err); process.exit(1); });
