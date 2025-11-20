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
  await pool.query(
    `UPDATE positions SET balance = 0, cost_basis_eth = 0, realized_pnl_eth = 0
     WHERE token_address IN (
       SELECT DISTINCT token_address FROM trades WHERE block_number > $1
     )`,
    [blockNumber.toString()]
  );
}