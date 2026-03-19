import type { Pool } from "pg";

// ── Fee distributions ─────────────────────────────────────────────────────────

export interface FeeDistributionRow {
  id:               string;
  blockNumber:      bigint;
  blockTimestamp:   bigint;
  txHash:           string;
  tokenAddress:     string;
  poolId:           string;
  donateAmount:     bigint;
  creatorAmount:    bigint;
  bidWallAmount:    bigint;
  governanceAmount: bigint;
  protocolAmount:   bigint;
  chainId:          number;
}

export async function insertFeeDistribution(
  pool: Pool, fee: FeeDistributionRow
): Promise<void> {
  await pool.query(
    `INSERT INTO fee_distributions (
       id, block_number, block_timestamp, tx_hash,
       token_address, pool_id,
       donate_amount, creator_amount, bid_wall_amount, governance_amount, protocol_amount,
       chain_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (id) DO NOTHING`,
    [
      fee.id,
      fee.blockNumber.toString(),
      fee.blockTimestamp.toString(),
      fee.txHash,
      fee.tokenAddress.toLowerCase(),
      fee.poolId,
      fee.donateAmount.toString(),
      fee.creatorAmount.toString(),
      fee.bidWallAmount.toString(),
      fee.governanceAmount.toString(),
      fee.protocolAmount.toString(),
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

// ── Fee escrow withdrawals ────────────────────────────────────────────────────

export interface FeeEscrowWithdrawalRow {
  id:             string;
  blockNumber:    bigint;
  blockTimestamp: bigint;
  txHash:         string;
  sender:         string;
  recipient:      string;
  token:          string;
  amount:         bigint;
  chainId:        number;
}

export async function insertFeeEscrowWithdrawal(
  pool: Pool, row: FeeEscrowWithdrawalRow
): Promise<void> {
  await pool.query(
    `INSERT INTO fee_escrow_withdrawals (id, block_number, block_timestamp, tx_hash, sender, recipient, token, amount, chain_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (id) DO NOTHING`,
    [
      row.id,
      row.blockNumber.toString(),
      row.blockTimestamp.toString(),
      row.txHash,
      row.sender.toLowerCase(),
      row.recipient.toLowerCase(),
      row.token.toLowerCase(),
      row.amount.toString(),
      row.chainId,
    ]
  );
}

export async function deleteFeeEscrowWithdrawalsAboveBlock(
  pool: Pool, blockNumber: bigint
): Promise<void> {
  await pool.query(
    "DELETE FROM fee_escrow_withdrawals WHERE block_number > $1",
    [blockNumber.toString()]
  );
}

// ── API read queries ──────────────────────────────────────────────────────────

export interface WalletRoyaltySummary {
  totalEarnedEth:  string;
  totalClaimedEth: string;
  claimableEth:    string;
  byToken: Array<{
    tokenAddress: string;
    earnedEth:    string;
    claimedEth:   string;
    claimableEth: string;
  }>;
}

export async function getWalletRoyalties(
  pool: Pool, walletAddress: string
): Promise<WalletRoyaltySummary> {
  const wallet = walletAddress.toLowerCase();

  // Per-token breakdown: earned from fee_distributions (creator_amount), claimed from fee_escrow_withdrawals
  const res = await pool.query<{
    token_address: string; earned_eth: string; claimed_eth: string;
  }>(
    `SELECT
       t.token_address,
       COALESCE(d.earned_eth, '0') AS earned_eth,
       COALESCE(c.claimed_eth, '0') AS claimed_eth
     FROM (
       SELECT DISTINCT tr.token_address
       FROM fee_distributions fd
       JOIN token_registry tr ON tr.pool_id = fd.pool_id
       WHERE fd.creator_amount > 0
       UNION
       SELECT DISTINCT tr2.token_address
       FROM fee_escrow_withdrawals fw
       JOIN token_registry tr2 ON tr2.token_address = fw.token
       WHERE fw.recipient = $1
     ) t
     LEFT JOIN (
       SELECT tr.token_address, SUM(fd.creator_amount)::text AS earned_eth
       FROM fee_distributions fd
       JOIN token_registry tr ON tr.pool_id = fd.pool_id
       GROUP BY tr.token_address
     ) d ON d.token_address = t.token_address
     LEFT JOIN (
       SELECT fw.token AS token_address, SUM(fw.amount)::text AS claimed_eth
       FROM fee_escrow_withdrawals fw
       WHERE fw.recipient = $1 GROUP BY fw.token
     ) c ON c.token_address = t.token_address`,
    [wallet]
  );

  const byToken = res.rows.map((r) => {
    const earned    = BigInt(r.earned_eth);
    const claimed   = BigInt(r.claimed_eth);
    const claimable = earned > claimed ? earned - claimed : 0n;
    return {
      tokenAddress: r.token_address,
      earnedEth:    r.earned_eth,
      claimedEth:   r.claimed_eth,
      claimableEth: claimable.toString(),
    };
  });

  const totalEarned    = byToken.reduce((s, r) => s + BigInt(r.earnedEth),   0n);
  const totalClaimed   = byToken.reduce((s, r) => s + BigInt(r.claimedEth),  0n);
  const totalClaimable = totalEarned > totalClaimed ? totalEarned - totalClaimed : 0n;

  return {
    totalEarnedEth:  totalEarned.toString(),
    totalClaimedEth: totalClaimed.toString(),
    claimableEth:    totalClaimable.toString(),
    byToken,
  };
}
