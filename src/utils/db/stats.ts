import type { Pool } from "pg";

export interface PlatformStats {
  totalTokens:    number;
  totalTrades:    number;
  totalVolumeETH: string;
  totalFeesETH:   string;
  totalHolders:   number;
}

export interface TopFeeEarner {
  wallet:     string;
  earnedEth:  string;
}

export async function getPlatformStats(pool: Pool): Promise<PlatformStats> {
  const res = await pool.query<{
    total_tokens:  string;
    total_trades:  string;
    total_volume:  string;
    total_fees:    string;
    total_holders: string;
  }>(`
    SELECT
      (SELECT COUNT(*)::text FROM token_registry) AS total_tokens,
      t.total_trades,
      t.total_volume,
      COALESCE(f.total_fees, '0')   AS total_fees,
      COALESCE(h.total_holders, '0') AS total_holders
    FROM
      (SELECT COUNT(*)::text AS total_trades,
              COALESCE(SUM(ABS(amount0_eth)), 0)::text AS total_volume
       FROM trades) t,
      (SELECT SUM(creator_amount + protocol_amount)::text AS total_fees
       FROM fee_distributions) f,
      (SELECT COUNT(DISTINCT wallet)::text AS total_holders
       FROM holder_balances WHERE balance > 0) h
  `);

  const r = res.rows[0];
  return {
    totalTokens:    Number(r.total_tokens),
    totalTrades:    Number(r.total_trades),
    totalVolumeETH: r.total_volume,
    totalFeesETH:   r.total_fees,
    totalHolders:   Number(r.total_holders),
  };
}

export async function getTopFeeEarners24h(pool: Pool, limit = 10): Promise<TopFeeEarner[]> {
  const res = await pool.query<{ wallet: string; earned_eth: string }>(`
    WITH dist_24h AS (
      SELECT fd.token_address, SUM(fd.creator_amount) AS creator_amount
      FROM fee_distributions fd
      WHERE fd.block_timestamp >= EXTRACT(EPOCH FROM NOW() - INTERVAL '24 hours')
      GROUP BY fd.token_address
    ),
    member_totals AS (
      SELECT token_address, SUM(share) AS total_share
      FROM royalty_members GROUP BY token_address
    )
    SELECT
      COALESCE(rm.recipient, tr.creator) AS wallet,
      FLOOR(SUM(
        CASE
          WHEN mt.total_share > 0 AND rm.share IS NOT NULL
            THEN d.creator_amount * rm.share / mt.total_share
          ELSE d.creator_amount
        END
      ))::text AS earned_eth
    FROM dist_24h d
    JOIN token_registry tr ON tr.token_address = d.token_address
    LEFT JOIN royalty_members rm ON rm.token_address = d.token_address
    LEFT JOIN member_totals mt ON mt.token_address = d.token_address
    GROUP BY COALESCE(rm.recipient, tr.creator)
    ORDER BY SUM(
      CASE
        WHEN mt.total_share > 0 AND rm.share IS NOT NULL
          THEN d.creator_amount * rm.share / mt.total_share
        ELSE d.creator_amount
      END
    ) DESC
    LIMIT $1
  `, [limit]);

  return res.rows.map((r) => ({ wallet: r.wallet, earnedEth: r.earned_eth }));
}
