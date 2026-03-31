import type { Pool } from "pg";

export interface ActivityItem {
  type:           "buy" | "sell" | "launch" | "fee_claim";
  txHash:         string | null;
  blockTimestamp: string;
  token: {
    address: string;
    name:    string | null;
    symbol:  string | null;
    image:   string;
  };
  amountETH:      string;
  amountUSD:      string | null;
  priceETH:       string | null;
}

export async function getWalletActivity(
  pool:          Pool,
  walletAddress: string,
  limit:         number,
  offset:        number,
): Promise<{ items: ActivityItem[]; total: number }> {
  const wallet = walletAddress.toLowerCase();

  // Unified activity: launches + fee claims + trades (buy/sell by sender/recipient)
  const res = await pool.query<{
    type:            string;
    tx_hash:         string | null;
    block_timestamp: string;
    token_address:   string;
    name:            string | null;
    symbol:          string | null;
    amount_eth:      string;
    price_eth:       string | null;
  }>(`
    SELECT * FROM (
      -- Token launches (wallet is the creator)
      SELECT
        'launch'                    AS type,
        NULL                        AS tx_hash,
        EXTRACT(EPOCH FROM tr.discovered_at)::bigint::text AS block_timestamp,
        tr.token_address,
        tr.name,
        tr.symbol,
        '0'                         AS amount_eth,
        NULL                        AS price_eth
      FROM token_registry tr
      WHERE tr.creator = $1

      UNION ALL

      -- Fee claims (wallet is the recipient of escrow withdrawal)
      SELECT
        'fee_claim'                 AS type,
        fw.tx_hash,
        fw.block_timestamp::text,
        fw.token                    AS token_address,
        tr.name,
        tr.symbol,
        fw.amount::text             AS amount_eth,
        NULL                        AS price_eth
      FROM fee_escrow_withdrawals fw
      JOIN token_registry tr ON tr.token_address = fw.token
      WHERE fw.recipient = $1

      UNION ALL

      -- Buys (wallet is the recipient in a buy trade)
      SELECT
        'buy'                       AS type,
        t.tx_hash,
        t.block_timestamp::text,
        t.token_address,
        tr.name,
        tr.symbol,
        ABS(t.amount0_eth)::text    AS amount_eth,
        t.price_eth::text           AS price_eth
      FROM trades t
      JOIN token_registry tr ON tr.token_address = t.token_address
      WHERE t.recipient = $1 AND t.is_buy = true

      UNION ALL

      -- Sells (wallet is the sender in a sell trade)
      SELECT
        'sell'                      AS type,
        t.tx_hash,
        t.block_timestamp::text,
        t.token_address,
        tr.name,
        tr.symbol,
        ABS(t.amount0_eth)::text    AS amount_eth,
        t.price_eth::text           AS price_eth
      FROM trades t
      JOIN token_registry tr ON tr.token_address = t.token_address
      WHERE t.sender = $1 AND t.is_buy = false
    ) combined
    ORDER BY block_timestamp::numeric DESC
    LIMIT $2 OFFSET $3
  `, [wallet, limit, offset]);

  // Count total (re-run without limit for accurate total)
  const countRes = await pool.query<{ count: string }>(`
    SELECT COUNT(*)::text AS count FROM (
      SELECT tr.token_address FROM token_registry tr WHERE tr.creator = $1
      UNION ALL
      SELECT fw.token FROM fee_escrow_withdrawals fw WHERE fw.recipient = $1
      UNION ALL
      SELECT t.token_address FROM trades t WHERE t.recipient = $1 AND t.is_buy = true
      UNION ALL
      SELECT t.token_address FROM trades t WHERE t.sender = $1 AND t.is_buy = false
    ) x
  `, [wallet]);

  const total = Number(countRes.rows[0]?.count ?? 0);

  const items: ActivityItem[] = res.rows.map((r) => ({
    type:           r.type as ActivityItem["type"],
    txHash:         r.tx_hash,
    blockTimestamp: r.block_timestamp,
    token: {
      address: r.token_address,
      name:    r.name,
      symbol:  r.symbol,
      image:   `https://i.flaunch.gg/token/${r.token_address}`,
    },
    amountETH: r.amount_eth,
    amountUSD: null,  // enriched in route handler when ethUsdRate available
    priceETH:  r.price_eth,
  }));

  return { items, total };
}
