import type { Pool } from "pg";

export async function upsertPoolState(
  pool:         Pool,
  poolId:       string,
  tokenAddress: string,
  liquidity:    bigint,
  sqrtPriceX96: bigint,
  blockNumber:  bigint,
): Promise<void> {
  await pool.query(
    `INSERT INTO pool_state (pool_id, token_address, liquidity, sqrt_price_x96, updated_block)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (pool_id) DO UPDATE SET
       liquidity      = EXCLUDED.liquidity,
       sqrt_price_x96 = EXCLUDED.sqrt_price_x96,
       updated_block  = GREATEST(pool_state.updated_block, EXCLUDED.updated_block)`,
    [poolId.toLowerCase(), tokenAddress.toLowerCase(),
     liquidity.toString(), sqrtPriceX96.toString(), blockNumber.toString()]
  );
}

export async function getPoolLiquidityEth(pool: Pool, tokenAddress: string): Promise<string | null> {
  const res = await pool.query<{ liquidity: string; sqrt_price_x96: string }>(
    `SELECT liquidity::text, sqrt_price_x96::text FROM pool_state WHERE token_address = $1 LIMIT 1`,
    [tokenAddress.toLowerCase()]
  );
  const row = res.rows[0];
  if (!row || BigInt(row.sqrt_price_x96) === 0n) return null;
  // ETH virtual reserves = L * 2^96 / sqrtPriceX96 (in wei)
  const Q96 = 2n ** 96n;
  const liquidityEth = BigInt(row.liquidity) * Q96 / BigInt(row.sqrt_price_x96);
  return liquidityEth.toString();
}
