import type { Pool } from "pg";

export interface TokenEntry {
  tokenAddress:    string;
  poolId:          string;
  creator:         string;
  nftId:           bigint;
  pmAddress:       string;
  discoveredBlock: bigint;
  totalSupply?:    bigint;
  name?:           string | null;
  symbol?:         string | null;
}

export async function registerToken(pool: Pool, entry: TokenEntry): Promise<void> {
  await pool.query(
    `INSERT INTO token_registry (token_address, pool_id, creator, nft_id, pm_address, discovered_block, total_supply, name, symbol)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (token_address) DO NOTHING`,
    [
      entry.tokenAddress.toLowerCase(),
      entry.poolId,
      (entry.creator ?? "0x0000000000000000000000000000000000000000").toLowerCase(),
      entry.nftId.toString(),
      entry.pmAddress.toLowerCase(),
      entry.discoveredBlock.toString(),
      entry.totalSupply != null ? entry.totalSupply.toString() : null,
      entry.name ?? null,
      entry.symbol ?? null,
    ]
  );
}

export async function getAllTokenAddresses(pool: Pool): Promise<string[]> {
  const res = await pool.query<{ token_address: string }>(
    "SELECT token_address FROM token_registry"
  );
  return res.rows.map((r) => r.token_address);
}

/** Returns a map of poolId → tokenAddress (all lowercase) for the poolIdToToken cache. */
export async function getAllPoolMappings(pool: Pool): Promise<Map<string, string>> {
  const res = await pool.query<{ pool_id: string; token_address: string }>(
    "SELECT pool_id, token_address FROM token_registry"
  );
  const map = new Map<string, string>();
  for (const r of res.rows) {
    map.set(r.pool_id.toLowerCase(), r.token_address.toLowerCase());
  }
  return map;
}

/** Look up a token address by pool id (case-insensitive). */
export async function getTokenByPoolId(pool: Pool, poolId: string): Promise<string | null> {
  const res = await pool.query<{ token_address: string }>(
    "SELECT token_address FROM token_registry WHERE pool_id = $1 LIMIT 1",
    [poolId.toLowerCase()]
  );
  return res.rows[0]?.token_address ?? null;
}

export async function upsertRoyaltyMembers(
  pool:         Pool,
  tokenAddress: string,
  members:      Array<{ recipient: string; share: bigint }>,
): Promise<void> {
  if (!members.length) return;
  const addr = tokenAddress.toLowerCase();
  const values: unknown[] = [];
  const placeholders: string[] = [];
  for (let i = 0; i < members.length; i++) {
    const off = i * 3;
    placeholders.push(`($${off + 1}, $${off + 2}, $${off + 3})`);
    values.push(addr, members[i].recipient.toLowerCase(), members[i].share.toString());
  }
  await pool.query(
    `INSERT INTO royalty_members (token_address, recipient, share)
     VALUES ${placeholders.join(", ")}
     ON CONFLICT (token_address, recipient) DO UPDATE SET share = EXCLUDED.share`,
    values,
  );
}

// ── API read queries ──────────────────────────────────────────────────────────

export async function updateTokenMetadata(
  pool:         Pool,
  tokenAddress: string,
  fields: {
    description?: string | null;
    website?:     string | null;
    twitter?:     string | null;
    telegram?:    string | null;
  },
): Promise<void> {
  const updates: string[] = [];
  const values:  unknown[] = [];
  let idx = 1;

  if ("description" in fields) { updates.push(`description = $${idx++}`); values.push(fields.description ?? null); }
  if ("website"     in fields) { updates.push(`website     = $${idx++}`); values.push(fields.website     ?? null); }
  if ("twitter"     in fields) { updates.push(`twitter     = $${idx++}`); values.push(fields.twitter     ?? null); }
  if ("telegram"    in fields) { updates.push(`telegram    = $${idx++}`); values.push(fields.telegram    ?? null); }

  if (!updates.length) return;
  values.push(tokenAddress.toLowerCase());
  await pool.query(
    `UPDATE token_registry SET ${updates.join(", ")} WHERE token_address = $${idx}`,
    values,
  );
}

export interface HourDataPoint {
  periodStartUnix: string;
  volumeEth:       string;
  openPriceEth:    string;
  closePriceEth:   string;
}

export interface TokenListRow {
  tokenAddress:    string;
  poolId:          string;
  creator:         string;
  nftId:           string;
  name:            string | null;
  symbol:          string | null;
  totalSupply:     string | null;
  description:     string | null;
  website:         string | null;
  twitter:         string | null;
  telegram:        string | null;
  discoveredAt:    string;
  lastPriceEth:    string | null;
  vol24hEth:       string;
  tradeCount24h:   number;
  holderCount:     number;
  mcapEth:         string | null;
  sparkline:       string[];
  feesEarnedEth:   string;
  price24hOpenEth: string | null;
  hourData:        HourDataPoint[];
  royaltyMembers:  Array<{ recipient: string; share: string }>;
}

export async function getTokenList(pool: Pool): Promise<TokenListRow[]> {
  const since24h = Math.floor(Date.now() / 1000) - 86400;
  const res = await pool.query<{
    token_address: string; pool_id: string; creator: string;
    nft_id: string; name: string | null; symbol: string | null;
    total_supply: string | null; discovered_at: string;
    description: string | null; website: string | null;
    twitter: string | null; telegram: string | null;
    last_price_eth: string | null; mcap_eth: string | null;
    vol_24h_eth: string; trade_count_24h: number;
    holder_count: string;
    sparkline: string[] | null;
    fees_earned_eth: string;
    price_24h_open_eth: string | null;
    hour_data: HourDataPoint[] | null;
    royalty_members: Array<{ recipient: string; share: string }> | null;
  }>(
    `WITH
     -- Latest 1m candle price per token (single scan of candles, not per-row)
     latest_price AS (
       SELECT DISTINCT ON (token_address)
         token_address, close_eth
       FROM candles
       WHERE resolution = '1m'
       ORDER BY token_address, bucket_time DESC
     ),
     -- Pool state fallback price
     pool_price AS (
       SELECT DISTINCT ON (token_address)
         token_address,
         CASE WHEN sqrt_price_x96 > 0
           THEN FLOOR((2^192)::numeric / (sqrt_price_x96 * sqrt_price_x96) * 1e18)
           ELSE NULL END AS derived_price
       FROM pool_state
       ORDER BY token_address
     ),
     -- 24h volume + trade count from 1h candles (single grouped scan)
     stats_24h AS (
       SELECT token_address,
         COALESCE(SUM(volume_eth), 0)::text AS vol_24h_eth,
         COALESCE(SUM(trade_count), 0)::int AS trade_count_24h
       FROM candles
       WHERE resolution = '1h' AND bucket_time >= $1
       GROUP BY token_address
     ),
     -- Holder counts (single grouped scan)
     holders AS (
       SELECT hb.token_address, COUNT(*)::int AS holder_count
       FROM holder_balances hb
       JOIN token_registry tr ON tr.token_address = hb.token_address
       WHERE hb.balance > 0 AND hb.wallet != tr.pm_address
       GROUP BY hb.token_address
     ),
     -- Lifetime fees per token (single grouped scan)
     fees AS (
       SELECT token_address, SUM(creator_amount)::text AS fees_earned_eth
       FROM fee_distributions
       GROUP BY token_address
     ),
     -- 24h open price (first 1h candle in window)
     open_24h AS (
       SELECT DISTINCT ON (token_address)
         token_address, open_eth
       FROM candles
       WHERE resolution = '1h' AND bucket_time >= $1
       ORDER BY token_address, bucket_time ASC
     ),
     -- Sparkline + hour data: last 24 1h candles per token
     hourly AS (
       SELECT token_address, bucket_time, open_eth, close_eth, volume_eth,
         ROW_NUMBER() OVER (PARTITION BY token_address ORDER BY bucket_time DESC) AS rn
       FROM candles
       WHERE resolution = '1h'
     ),
     hour_agg AS (
       SELECT token_address,
         array_agg(close_eth::text ORDER BY bucket_time ASC) AS sparkline,
         json_agg(
           json_build_object(
             'periodStartUnix', bucket_time::text,
             'volumeEth',       volume_eth::text,
             'openPriceEth',    open_eth::text,
             'closePriceEth',   close_eth::text
           ) ORDER BY bucket_time ASC
         ) AS hour_data
       FROM hourly
       WHERE rn <= 24
       GROUP BY token_address
     ),
     -- Royalty members per token
     royalties AS (
       SELECT token_address,
         json_agg(json_build_object('recipient', recipient, 'share', share::text)) AS royalty_members
       FROM royalty_members
       GROUP BY token_address
     )
     SELECT
       tr.token_address,
       tr.pool_id,
       tr.creator,
       tr.nft_id::text,
       tr.name,
       tr.symbol,
       tr.total_supply::text,
       tr.description,
       tr.website,
       tr.twitter,
       tr.telegram,
       tr.discovered_at,
       COALESCE(lp.close_eth::text, pp.derived_price::text, tr.initial_price_eth::text) AS last_price_eth,
       -- Pre-compute mcap in SQL to avoid per-token BigInt math in application code
       CASE WHEN tr.total_supply IS NOT NULL AND COALESCE(lp.close_eth, pp.derived_price, tr.initial_price_eth) IS NOT NULL
         THEN (COALESCE(lp.close_eth, pp.derived_price, tr.initial_price_eth) * tr.total_supply / 1e18)::text
         ELSE NULL END AS mcap_eth,
       COALESCE(s.vol_24h_eth, '0')       AS vol_24h_eth,
       COALESCE(s.trade_count_24h, 0)     AS trade_count_24h,
       COALESCE(h.holder_count, 0)        AS holder_count,
       COALESCE(ha.sparkline, '{}')       AS sparkline,
       COALESCE(f.fees_earned_eth, '0')   AS fees_earned_eth,
       COALESCE(o.open_eth::text, tr.initial_price_eth::text) AS price_24h_open_eth,
       ha.hour_data,
       r.royalty_members
     FROM token_registry tr
     LEFT JOIN latest_price lp ON lp.token_address = tr.token_address
     LEFT JOIN pool_price   pp ON pp.token_address = tr.token_address
     LEFT JOIN stats_24h     s ON s.token_address  = tr.token_address
     LEFT JOIN holders       h ON h.token_address  = tr.token_address
     LEFT JOIN fees          f ON f.token_address   = tr.token_address
     LEFT JOIN open_24h      o ON o.token_address  = tr.token_address
     LEFT JOIN hour_agg     ha ON ha.token_address = tr.token_address
     LEFT JOIN royalties     r ON r.token_address  = tr.token_address
     ORDER BY tr.discovered_at DESC`,
    [since24h]
  );
  return res.rows.map((r) => ({
    tokenAddress:    r.token_address,
    poolId:          r.pool_id,
    creator:         r.creator,
    nftId:           r.nft_id,
    name:            r.name,
    symbol:          r.symbol,
    totalSupply:     r.total_supply,
    description:     r.description,
    website:         r.website,
    twitter:         r.twitter,
    telegram:        r.telegram,
    discoveredAt:    r.discovered_at,
    lastPriceEth:    r.last_price_eth,
    vol24hEth:       r.vol_24h_eth,
    tradeCount24h:   r.trade_count_24h,
    holderCount:     Number(r.holder_count),
    mcapEth:         r.mcap_eth,
    sparkline:       r.sparkline ?? [],
    feesEarnedEth:   r.fees_earned_eth,
    price24hOpenEth: r.price_24h_open_eth,
    hourData:        r.hour_data ?? [],
    royaltyMembers:  r.royalty_members ?? [],
  }));
}

// ── Token detail ──────────────────────────────────────────────────────────────

export interface TokenDetailRow extends TokenListRow {
  pmAddress:        string;
  fairLaunchEndsAt: string | null;
  fairLaunchEndedAt: string | null;
  fairLaunchRevenue: string | null;
  fairLaunchSupply:  string | null;
}

export async function getTokenDetail(pool: Pool, tokenAddress: string): Promise<TokenDetailRow | null> {
  const since24h = Math.floor(Date.now() / 1000) - 86400;
  const addr = tokenAddress.toLowerCase();

  const res = await pool.query<{
    token_address: string; pool_id: string; creator: string; pm_address: string;
    nft_id: string; name: string | null; symbol: string | null;
    total_supply: string | null; discovered_at: string;
    description: string | null; website: string | null;
    twitter: string | null; telegram: string | null;
    last_price_eth: string | null; vol_24h_eth: string; trade_count_24h: number;
    holder_count: string; fees_earned_eth: string; price_24h_open_eth: string | null;
    sparkline: string[] | null; hour_data: HourDataPoint[] | null;
    royalty_members: Array<{ recipient: string; share: string }> | null;
    fl_ends_at: string | null; fl_ended_at: string | null;
    fl_revenue: string | null; fl_supply: string | null;
  }>(
    `SELECT
       tr.token_address, tr.pool_id, tr.creator, tr.pm_address,
       tr.nft_id::text, tr.name, tr.symbol, tr.total_supply::text,
       tr.description, tr.website, tr.twitter, tr.telegram,
       tr.discovered_at,
       COALESCE(
         (SELECT close_eth::text FROM candles
          WHERE token_address = tr.token_address AND resolution = '1m'
          ORDER BY bucket_time DESC LIMIT 1),
         (SELECT CASE WHEN ps.sqrt_price_x96 > 0
           THEN FLOOR((2^192)::numeric / (ps.sqrt_price_x96 * ps.sqrt_price_x96) * 1e18)::text
           ELSE NULL END
          FROM pool_state ps WHERE ps.token_address = tr.token_address LIMIT 1),
         tr.initial_price_eth::text
       ) AS last_price_eth,
       COALESCE((SELECT SUM(volume_eth)::text FROM candles
         WHERE token_address = tr.token_address AND resolution = '1h' AND bucket_time >= $2), '0') AS vol_24h_eth,
       COALESCE((SELECT SUM(trade_count) FROM candles
         WHERE token_address = tr.token_address AND resolution = '1h' AND bucket_time >= $2), 0)::int AS trade_count_24h,
       COALESCE((SELECT COUNT(*) FROM holder_balances
         WHERE token_address = tr.token_address AND balance > 0
           AND wallet != tr.pm_address), 0)::int AS holder_count,
       COALESCE((SELECT SUM(creator_amount)::text FROM fee_distributions
         WHERE token_address = tr.token_address), '0') AS fees_earned_eth,
       COALESCE(
         (SELECT open_eth::text FROM candles
          WHERE token_address = tr.token_address AND resolution = '1h' AND bucket_time >= $2
          ORDER BY bucket_time ASC LIMIT 1),
         tr.initial_price_eth::text
       ) AS price_24h_open_eth,
       COALESCE((SELECT array_agg(close_eth::text ORDER BY bucket_time ASC)
         FROM (SELECT close_eth, bucket_time FROM candles
               WHERE token_address = tr.token_address AND resolution = '1h'
               ORDER BY bucket_time DESC LIMIT 24) s), '{}') AS sparkline,
       (SELECT json_agg(json_build_object(
           'periodStartUnix', h.bucket_time::text, 'volumeEth', h.volume_eth::text,
           'openPriceEth', h.open_eth::text, 'closePriceEth', h.close_eth::text
         ) ORDER BY h.bucket_time ASC)
        FROM (SELECT bucket_time, volume_eth, open_eth, close_eth FROM candles
              WHERE token_address = tr.token_address AND resolution = '1h'
              ORDER BY bucket_time DESC LIMIT 24) h) AS hour_data,
       (SELECT json_agg(json_build_object('recipient', rm.recipient, 'share', rm.share::text))
        FROM royalty_members rm WHERE rm.token_address = tr.token_address) AS royalty_members,
       fl.ends_at::text  AS fl_ends_at,
       fl.ended_at::text AS fl_ended_at,
       fl.revenue::text  AS fl_revenue,
       fl.supply::text   AS fl_supply
     FROM token_registry tr
     LEFT JOIN fair_launch_info fl ON fl.pool_id = tr.pool_id
     WHERE tr.token_address = $1`,
    [addr, since24h]
  );

  if (res.rows.length === 0) return null;
  const r = res.rows[0];
  return {
    tokenAddress:      r.token_address,
    poolId:            r.pool_id,
    creator:           r.creator,
    pmAddress:         r.pm_address,
    nftId:             r.nft_id,
    name:              r.name,
    symbol:            r.symbol,
    totalSupply:       r.total_supply,
    description:       r.description,
    website:           r.website,
    twitter:           r.twitter,
    telegram:          r.telegram,
    discoveredAt:      r.discovered_at,
    lastPriceEth:      r.last_price_eth,
    vol24hEth:         r.vol_24h_eth,
    tradeCount24h:     r.trade_count_24h,
    holderCount:       Number(r.holder_count),
    mcapEth:           r.last_price_eth != null && r.total_supply != null
      ? (BigInt(r.last_price_eth) * BigInt(r.total_supply) / (10n ** 18n)).toString() : null,
    sparkline:         r.sparkline ?? [],
    feesEarnedEth:     r.fees_earned_eth,
    price24hOpenEth:   r.price_24h_open_eth,
    hourData:          r.hour_data ?? [],
    royaltyMembers:    r.royalty_members ?? [],
    fairLaunchEndsAt:  r.fl_ends_at,
    fairLaunchEndedAt: r.fl_ended_at,
    fairLaunchRevenue: r.fl_revenue,
    fairLaunchSupply:  r.fl_supply,
  };
}

// ── Token trades ──────────────────────────────────────────────────────────────

export interface TradeRow {
  id:             string;
  txHash:         string;
  blockTimestamp: string;
  isBuy:          boolean;
  amountETH:      string;
  amountTokens:   string;
  priceETH:       string;
  priceUSD:       string | null;
  feeETH:         string | null;
  trader:         string | null;
  phase:          string | null;
}

export async function getTokenTrades(
  pool:         Pool,
  tokenAddress: string,
  limit:        number,
  offset:       number,
): Promise<{ trades: TradeRow[]; total: number }> {
  const addr = tokenAddress.toLowerCase();

  const [countRes, rowsRes] = await Promise.all([
    pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM trades WHERE token_address = $1`, [addr]
    ),
    pool.query<{
      id: string; tx_hash: string; block_timestamp: string; is_buy: boolean;
      amount0_eth: string; amount1_tokens: string; price_eth: string;
      price_usd: string | null; fee_eth: string | null;
      sender: string | null; recipient: string | null; phase: string | null;
    }>(
      `SELECT id, tx_hash, block_timestamp::text, is_buy,
              ABS(amount0_eth)::text AS amount0_eth, ABS(amount1_tokens)::text AS amount1_tokens,
              price_eth::text, price_usd::text, ABS(fee_eth)::text AS fee_eth,
              sender, recipient, phase
       FROM trades
       WHERE token_address = $1
       ORDER BY block_timestamp DESC, id DESC
       LIMIT $2 OFFSET $3`,
      [addr, limit, offset]
    ),
  ]);

  const total = Number(countRes.rows[0]?.count ?? 0);
  const trades: TradeRow[] = rowsRes.rows.map((r) => ({
    id:             r.id,
    txHash:         r.tx_hash,
    blockTimestamp: r.block_timestamp,
    isBuy:          r.is_buy,
    amountETH:      r.amount0_eth,
    amountTokens:   r.amount1_tokens,
    priceETH:       r.price_eth,
    priceUSD:       r.price_usd,
    feeETH:         r.fee_eth,
    trader:         r.is_buy ? r.recipient : r.sender,
    phase:          r.phase,
  }));

  return { trades, total };
}

const DEFAULT_BAR_COUNT = 300;

export async function getTokenCandles(
  pool:       Pool,
  address:    string,
  resolution: string,
  from?:      bigint,
  to?:        bigint,
  limit?:     number,
): Promise<Array<{
  bucketTime: string; openEth: string; highEth: string;
  lowEth: string; closeEth: string; volumeEth: string; tradeCount: number;
}>> {
  const params: string[] = [address.toLowerCase(), resolution];
  let where = `WHERE token_address = $1 AND resolution = $2`;

  if (from != null) {
    params.push(from.toString());
    where += ` AND bucket_time >= $${params.length}`;
  }
  if (to != null) {
    params.push(to.toString());
    where += ` AND bucket_time <= $${params.length}`;
  }

  const cap = Math.min(limit ?? DEFAULT_BAR_COUNT, 1000);

  // Fetch most recent `cap` candles, then return in ascending order
  const res = await pool.query<{
    bucket_time: string; open_eth: string; high_eth: string;
    low_eth: string; close_eth: string; volume_eth: string; trade_count: number;
  }>(
    `SELECT bucket_time::text, open_eth::text, high_eth::text,
            low_eth::text, close_eth::text, volume_eth::text, trade_count
     FROM (
       SELECT * FROM candles ${where}
       ORDER BY bucket_time DESC
       LIMIT ${cap}
     ) sub
     ORDER BY bucket_time ASC`,
    params
  );
  return res.rows.map((r) => ({
    bucketTime: r.bucket_time, openEth:  r.open_eth,  highEth:   r.high_eth,
    lowEth:     r.low_eth,     closeEth: r.close_eth, volumeEth: r.volume_eth,
    tradeCount: r.trade_count,
  }));
}
