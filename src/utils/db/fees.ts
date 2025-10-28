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
    tokenAddress:  string;
    name:          string | null;
    symbol:        string | null;
    image:         string;
    earnedEth:     string;
    claimedEth:    string;
    claimableEth:  string;
    feeSharePct:   string;
    marketCapETH:  string | null;
  }>;
}

export async function getWalletRoyalties(
  pool: Pool, walletAddress: string
): Promise<WalletRoyaltySummary> {
  const wallet = walletAddress.toLowerCase();

  // Only tokens where this wallet is creator OR royalty_members recipient
  const res = await pool.query<{
    token_address: string; name: string | null; symbol: string | null;
    earned_eth: string; claimed_eth: string;
    total_supply: string | null; last_price_eth: string | null;
    wallet_share: string | null; total_shares: string | null;
  }>(
    `WITH
     latest_price AS (
       SELECT DISTINCT ON (token_address)
         token_address, close_eth
       FROM candles
       WHERE resolution = '1m'
       ORDER BY token_address, bucket_time DESC
     ),
     share_totals AS (
       SELECT token_address, SUM(share)::text AS total_shares
       FROM royalty_members
       GROUP BY token_address
     )
     SELECT
       tr.token_address,
       tr.name,
       tr.symbol,
       COALESCE(d.earned_eth, '0')  AS earned_eth,
       COALESCE(c.claimed_eth, '0') AS claimed_eth,
       tr.total_supply::text,
       lp.close_eth::text AS last_price_eth,
       rm_me.share::text AS wallet_share,
       st.total_shares
     FROM (
       SELECT DISTINCT token_address FROM token_registry WHERE creator = $1
       UNION
       SELECT DISTINCT token_address FROM royalty_members WHERE recipient = $1
     ) owned
     JOIN token_registry tr ON tr.token_address = owned.token_address
     LEFT JOIN (
       SELECT token_address, SUM(creator_amount)::text AS earned_eth
       FROM fee_distributions GROUP BY token_address
     ) d ON d.token_address = tr.token_address
     LEFT JOIN (
       SELECT token AS token_address, SUM(amount)::text AS claimed_eth
       FROM fee_escrow_withdrawals WHERE recipient = $1 GROUP BY token
     ) c ON c.token_address = tr.token_address
     LEFT JOIN royalty_members rm_me
       ON rm_me.token_address = tr.token_address AND rm_me.recipient = $1
     LEFT JOIN latest_price lp ON lp.token_address = tr.token_address
     LEFT JOIN share_totals st ON st.token_address = tr.token_address`,
    [wallet]
  );

  const byToken = res.rows.map((r) => {
    // For royalty members, scale earned by their share fraction.
    // For creators (no royalty_members row), they receive 100% of creator_amount.
    let earned = BigInt(r.earned_eth);
    if (r.wallet_share && r.total_shares) {
      const ws = BigInt(r.wallet_share);
      const ts = BigInt(r.total_shares);
      if (ts > 0n) earned = earned * ws / ts;
    }

    const claimed   = BigInt(r.claimed_eth);
    const claimable = earned > claimed ? earned - claimed : 0n;

    const mcapEth = r.last_price_eth && r.total_supply
      ? (BigInt(r.last_price_eth) * BigInt(r.total_supply) / (10n ** 18n)).toString()
      : null;

    let feeSharePct = "100.00"; // creator owns 100% by default
    if (r.wallet_share && r.total_shares) {
      const ws = BigInt(r.wallet_share);
      const ts = BigInt(r.total_shares);
      feeSharePct = ts > 0n ? (Number(ws * 10000n / ts) / 100).toFixed(2) : "0.00";
    }

    return {
      tokenAddress:  r.token_address,
      name:          r.name,
      symbol:        r.symbol,
      image:         `https://i.flaunch.gg/token/${r.token_address}`,
      earnedEth:     earned.toString(),
      claimedEth:    r.claimed_eth,
      claimableEth:  claimable.toString(),
      feeSharePct,
      marketCapETH:  mcapEth,
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
