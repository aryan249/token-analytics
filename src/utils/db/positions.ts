import type { Pool }     from "pg";
import type { Position } from "../../types/events";

export async function upsertPosition(pool: Pool, position: Position): Promise<void> {
  await pool.query(
    `INSERT INTO positions (wallet_address, token_address, balance, cost_basis_eth, realized_pnl_eth, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (wallet_address, token_address) DO UPDATE SET
       balance          = $3,
       cost_basis_eth   = $4,
       realized_pnl_eth = $5,
       updated_at       = NOW()`,
    [
      position.walletAddress.toLowerCase(),
      position.tokenAddress.toLowerCase(),
      position.balance.toString(),
      position.costBasisEth.toString(),
      position.realizedPnlEth.toString(),
    ]
  );
}

export async function getPosition(
  pool: Pool, walletAddress: string, tokenAddress: string
): Promise<Position | null> {
  const res = await pool.query<{
    balance:          string;
    cost_basis_eth:   string;
    realized_pnl_eth: string;
  }>(
    `SELECT balance, cost_basis_eth, realized_pnl_eth
     FROM positions WHERE wallet_address = $1 AND token_address = $2`,
    [walletAddress.toLowerCase(), tokenAddress.toLowerCase()]
  );
  if ((res.rowCount ?? 0) === 0) return null;
  const row = res.rows[0];
  return {
    walletAddress:  walletAddress.toLowerCase(),
    tokenAddress:   tokenAddress.toLowerCase(),
    balance:        BigInt(row.balance),
    costBasisEth:   BigInt(row.cost_basis_eth),
    realizedPnlEth: BigInt(row.realized_pnl_eth),
  };
}

export async function deletePositionsAboveBlock(
  pool: Pool, blockNumber: bigint
): Promise<void> {
  // Delete only the wallet-token positions whose state was changed by reorg'd
  // trades. The indexer replay will reconstruct them from the canonical chain.
  await pool.query(
    `DELETE FROM positions
     WHERE (wallet_address, token_address) IN (
       SELECT DISTINCT
         CASE WHEN is_buy THEN recipient ELSE sender END,
         token_address
       FROM trades
       WHERE block_number > $1
     )`,
    [blockNumber.toString()]
  );
}

// ── API read queries ──────────────────────────────────────────────────────────

export interface WalletPositionRow {
  tokenAddress:     string;
  balance:          string;
  costBasisEth:     string;
  realizedPnlEth:   string;
  wacEth:           string;
  currentPriceEth:  string | null;
  unrealizedPnlEth: string;
  updatedAt:        string;
}

export async function getWalletPositions(
  pool: Pool, walletAddress: string
): Promise<WalletPositionRow[]> {
  const res = await pool.query<{
    token_address: string; balance: string; cost_basis_eth: string;
    realized_pnl_eth: string; wac_eth: string;
    current_price_eth: string | null; unrealized_pnl_eth: string;
    updated_at: string;
  }>(
    `SELECT
       p.token_address,
       p.balance::text,
       p.cost_basis_eth::text,
       p.realized_pnl_eth::text,
       CASE WHEN p.balance > 0
         THEN (p.cost_basis_eth * 1000000000000000000 / p.balance)::text
         ELSE '0' END AS wac_eth,
       c.close_eth::text AS current_price_eth,
       CASE WHEN p.balance > 0 AND c.close_eth IS NOT NULL
         THEN (c.close_eth * p.balance / 1000000000000000000 - p.cost_basis_eth)::text
         ELSE '0' END AS unrealized_pnl_eth,
       p.updated_at::text
     FROM positions p
     LEFT JOIN LATERAL (
       SELECT close_eth FROM candles
       WHERE token_address = p.token_address AND resolution = '1m'
       ORDER BY bucket_time DESC LIMIT 1
     ) c ON true
     WHERE p.wallet_address = $1 AND p.balance > 0
     ORDER BY p.updated_at DESC`,
    [walletAddress.toLowerCase()]
  );
  return res.rows.map((r) => ({
    tokenAddress:     r.token_address,
    balance:          r.balance,
    costBasisEth:     r.cost_basis_eth,
    realizedPnlEth:   r.realized_pnl_eth,
    wacEth:           r.wac_eth,
    currentPriceEth:  r.current_price_eth,
    unrealizedPnlEth: r.unrealized_pnl_eth,
    updatedAt:        r.updated_at,
  }));
}