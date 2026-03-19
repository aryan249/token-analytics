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