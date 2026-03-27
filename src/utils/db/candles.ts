import type { Pool } from "pg";
import type { Candle } from "../../types/events";

export async function upsertCandle(pool: Pool, candle: Candle): Promise<void> {
  await pool.query(
    `INSERT INTO candles (
       token_address, resolution, bucket_time,
       open_eth, high_eth, low_eth, close_eth, volume_eth, trade_count
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (token_address, resolution, bucket_time) DO UPDATE SET
       high_eth    = GREATEST(candles.high_eth, EXCLUDED.high_eth),
       low_eth     = LEAST(candles.low_eth, EXCLUDED.low_eth),
       close_eth   = EXCLUDED.close_eth,
       volume_eth  = candles.volume_eth + EXCLUDED.volume_eth,
       trade_count = candles.trade_count + EXCLUDED.trade_count`,
    [
      candle.tokenAddress.toLowerCase(),
      candle.resolution,
      candle.bucketTime.toString(),
      candle.openEth.toString(),
      candle.highEth.toString(),
      candle.lowEth.toString(),
      candle.closeEth.toString(),
      candle.volumeEth.toString(),
      candle.tradeCount,
    ]
  );
}

/** Batch upsert multiple candles in a single query (1 round trip for all resolutions). */
export async function upsertCandleBatch(pool: Pool, candles: Candle[]): Promise<void> {
  if (candles.length === 0) return;

  // Build a multi-row VALUES clause: ($1,$2,...,$9), ($10,$11,...,$18), ...
  const values: unknown[] = [];
  const rows: string[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const offset = i * 9;
    rows.push(`($${offset+1},$${offset+2},$${offset+3},$${offset+4},$${offset+5},$${offset+6},$${offset+7},$${offset+8},$${offset+9})`);
    values.push(
      c.tokenAddress.toLowerCase(), c.resolution, c.bucketTime.toString(),
      c.openEth.toString(), c.highEth.toString(), c.lowEth.toString(),
      c.closeEth.toString(), c.volumeEth.toString(), c.tradeCount,
    );
  }

  await pool.query(
    `INSERT INTO candles (
       token_address, resolution, bucket_time,
       open_eth, high_eth, low_eth, close_eth, volume_eth, trade_count
     ) VALUES ${rows.join(",")}
     ON CONFLICT (token_address, resolution, bucket_time) DO UPDATE SET
       high_eth    = GREATEST(candles.high_eth, EXCLUDED.high_eth),
       low_eth     = LEAST(candles.low_eth, EXCLUDED.low_eth),
       close_eth   = EXCLUDED.close_eth,
       volume_eth  = candles.volume_eth + EXCLUDED.volume_eth,
       trade_count = candles.trade_count + EXCLUDED.trade_count`,
    values,
  );
}

export async function deleteCandlesAboveBlock(
  pool: Pool, blockNumber: bigint
): Promise<void> {
  // Find the floor of the earliest affected trade's timestamp at 1m resolution
  // (the smallest bucket size), then delete all candle buckets that start at or
  // after that boundary for any token touched by the reorg'd trades.
  await pool.query(
    `DELETE FROM candles
     WHERE token_address IN (
       SELECT DISTINCT token_address FROM trades WHERE block_number > $1
     )
     AND bucket_time >= (
       SELECT (MIN(block_timestamp) / 60) * 60
       FROM trades WHERE block_number > $1
     )`,
    [blockNumber.toString()]
  );
}