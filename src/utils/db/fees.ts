import type { Pool } from "pg";

// ── Fee distributions ─────────────────────────────────────────────────────────

export interface FeeDistributionRow {
  id:             string;
  blockNumber:    bigint;
  blockTimestamp: bigint;
  txHash:         string;
  tokenAddress:   string;
  poolId:         string;
  totalFeeEth:    bigint;
  creatorFeeEth:  bigint;
  protocolFeeEth: bigint;
  feeReceiver:    string;
  chainId:        number;
}

export async function insertFeeDistribution(
  pool: Pool, fee: FeeDistributionRow
): Promise<void> {
  await pool.query(
    `INSERT INTO fee_distributions (
       id, block_number, block_timestamp, tx_hash,
       token_address, pool_id,
       total_fee_eth, creator_fee_eth, protocol_fee_eth,
       fee_receiver, chain_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (id) DO NOTHING`,
    [
      fee.id,
      fee.blockNumber.toString(),
      fee.blockTimestamp.toString(),
      fee.txHash,
      fee.tokenAddress.toLowerCase(),
      fee.poolId,
      fee.totalFeeEth.toString(),
      fee.creatorFeeEth.toString(),
      fee.protocolFeeEth.toString(),
      fee.feeReceiver.toLowerCase(),
      fee.chainId,
    ]
  );
}

export async function deleteFeeDistributionsAboveBlock(
  pool: Pool, blockNumber: bigint
): Promise<void> {
  await pool.query(
    "DELETE FROM fee_distributions WHERE block_number > $1",
    [blockNumber.toString()]
  );
}

// ── Fees claimed ──────────────────────────────────────────────────────────────

export interface FeesClaimedRow {
  id:             string;
  blockNumber:    bigint;
  blockTimestamp: bigint;
  txHash:         string;
  tokenAddress:   string;
  claimant:       string;
  amountEth:      bigint;
  chainId:        number;
}

export async function insertFeesClaimed(
  pool: Pool, row: FeesClaimedRow
): Promise<void> {
  await pool.query(
    `INSERT INTO fees_claimed (id, block_number, block_timestamp, tx_hash, token_address, claimant, amount_eth, chain_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (id) DO NOTHING`,
    [
      row.id,
      row.blockNumber.toString(),
      row.blockTimestamp.toString(),
      row.txHash,
      row.tokenAddress.toLowerCase(),
      row.claimant.toLowerCase(),
      row.amountEth.toString(),
      row.chainId,
    ]
  );
}