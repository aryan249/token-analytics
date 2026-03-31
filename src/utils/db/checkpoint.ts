import type { Pool }           from "pg";
import type { Hash }           from "viem";
import type { SyncCheckpoint, BlockHeader } from "../../types/events";

// ── Sync checkpoint ───────────────────────────────────────────────────────────

export async function readCheckpoint(
  pool: Pool, chainId: number
): Promise<SyncCheckpoint | null> {
  const res = await pool.query<{
    last_finalized_block: string;
    last_finalized_hash:  string;
    updated_at:           Date;
  }>(
    `SELECT last_finalized_block, last_finalized_hash, updated_at
     FROM sync_checkpoints WHERE chain_id = $1`,
    [chainId]
  );
  if ((res.rowCount ?? 0) === 0) return null;
  const row = res.rows[0];
  return {
    chainId,
    lastFinalizedBlock: BigInt(row.last_finalized_block),
    lastFinalizedHash:  row.last_finalized_hash as Hash,
    updatedAt:          row.updated_at,
  };
}

export async function writeCheckpoint(
  pool: Pool, chainId: number, block: bigint, blockHash: Hash
): Promise<void> {
  await pool.query(
    `INSERT INTO sync_checkpoints (chain_id, last_finalized_block, last_finalized_hash, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (chain_id) DO UPDATE
       SET last_finalized_block = $2,
           last_finalized_hash  = $3,
           updated_at           = NOW()`,
    [chainId, block.toString(), blockHash]
  );
}

// ── Block headers ─────────────────────────────────────────────────────────────

export async function insertBlockHeader(
  pool: Pool, header: BlockHeader, chainId: number
): Promise<void> {
  await pool.query(
    `INSERT INTO block_headers (block_number, block_hash, parent_hash, block_timestamp, chain_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (block_number) DO NOTHING`,
    [
      header.blockNumber.toString(),
      header.blockHash,
      header.parentHash,
      header.blockTimestamp.toString(),
      chainId,
    ]
  );
}

export async function getBlockHeader(
  pool: Pool, blockNumber: bigint
): Promise<BlockHeader | null> {
  const res = await pool.query<{
    block_number:    string;
    block_hash:      string;
    parent_hash:     string;
    block_timestamp: string;
  }>(
    `SELECT block_number, block_hash, parent_hash, block_timestamp
     FROM block_headers WHERE block_number = $1`,
    [blockNumber.toString()]
  );
  if ((res.rowCount ?? 0) === 0) return null;
  const row = res.rows[0];
  return {
    blockNumber:    BigInt(row.block_number),
    blockHash:      row.block_hash as Hash,
    parentHash:     row.parent_hash as Hash,
    blockTimestamp: BigInt(row.block_timestamp),
  };
}

export async function deleteBlockHeadersAbove(
  pool: Pool, blockNumber: bigint
): Promise<void> {
  await pool.query(
    "DELETE FROM block_headers WHERE block_number > $1",
    [blockNumber.toString()]
  );
}