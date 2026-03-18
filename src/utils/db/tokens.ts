import type { Pool } from "pg";

export interface TokenEntry {
  tokenAddress:    string;
  poolId:          string;
  creator:         string;
  nftId:           bigint;
  pmAddress:       string;
  discoveredBlock: bigint;
}

export async function registerToken(pool: Pool, entry: TokenEntry): Promise<void> {
  await pool.query(
    `INSERT INTO token_registry (token_address, pool_id, creator, nft_id, pm_address, discovered_block)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (token_address) DO NOTHING`,
    [
      entry.tokenAddress.toLowerCase(),
      entry.poolId,
      entry.creator.toLowerCase(),
      entry.nftId.toString(),
      entry.pmAddress.toLowerCase(),
      entry.discoveredBlock.toString(),
    ]
  );
}

export async function getAllTokenAddresses(pool: Pool): Promise<string[]> {
  const res = await pool.query<{ token_address: string }>(
    "SELECT token_address FROM token_registry"
  );
  return res.rows.map((r) => r.token_address);
}