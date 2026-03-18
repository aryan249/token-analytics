import type { Pool } from "pg";
import type { Candle } from "../../types/events";

export async function upsertCandle(pool: Pool, candle: Candle): Promise<void> {
  await pool.query(
    `INSERT INTO candles (
       token_address, resolution, bucket_time,
       open_eth, high_eth, low_eth, close_eth, volume_eth, trade_count
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (token_address, resolution, bucket_time) DO UPDATE SET
       high_eth    = GREATEST(candles.high_eth, $5),
       low_eth     = LEAST(candles.low_eth, $6),
       close_eth   = $7,
       volume_eth  = candles.volume_eth + $8,
       trade_count = candles.trade_count + $9`,
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
  await pool.query(
    `DELETE FROM candles
     WHERE (token_address, resolution, bucket_time) IN (
       SELECT DISTINCT t.token_address, c.resolution, c.bucket_time
       FROM trades t
       JOIN candles c ON c.token_address = t.token_address
       WHERE t.block_number > $1
     )`,
    [blockNumber.toString()]
  );
}