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
      entry.creator.toLowerCase(),
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

// ── API read queries ──────────────────────────────────────────────────────────

export interface TokenListRow {
  tokenAddress: string;
  poolId:       string;
  creator:      string;
  nftId:        string;
  name:         string | null;
  symbol:       string | null;
  totalSupply:  string | null;
  discoveredAt: string;
  lastPriceEth: string | null;
  vol24hEth:    string;
  mcapEth:      string | null;
  sparkline:    string[];
}

export async function getTokenList(pool: Pool): Promise<TokenListRow[]> {
  const since24h = Math.floor(Date.now() / 1000) - 86400;
  const res = await pool.query<{
    token_address: string; pool_id: string; creator: string;
    nft_id: string; name: string | null; symbol: string | null;
    total_supply: string | null; discovered_at: string;
    last_price_eth: string | null; vol_24h_eth: string;
    sparkline: string[] | null;
  }>(
    `SELECT
       tr.token_address,
       tr.pool_id,
       tr.creator,
       tr.nft_id::text,
       tr.name,
       tr.symbol,
       tr.total_supply::text,
       tr.discovered_at,
       (SELECT close_eth::text
        FROM candles
        WHERE token_address = tr.token_address AND resolution = '1m'
        ORDER BY bucket_time DESC LIMIT 1) AS last_price_eth,
       COALESCE((
         SELECT SUM(volume_eth)::text
         FROM candles
         WHERE token_address = tr.token_address
           AND resolution = '1h'
           AND bucket_time >= $1
       ), '0') AS vol_24h_eth,
       COALESCE((
         SELECT array_agg(close_eth::text ORDER BY bucket_time ASC)
         FROM (
           SELECT close_eth, bucket_time FROM candles
           WHERE token_address = tr.token_address AND resolution = '1h'
           ORDER BY bucket_time DESC LIMIT 24
         ) s
       ), '{}') AS sparkline
     FROM token_registry tr
     ORDER BY tr.discovered_at DESC`,
    [since24h]
  );
  return res.rows.map((r) => ({
    tokenAddress: r.token_address,
    poolId:       r.pool_id,
    creator:      r.creator,
    nftId:        r.nft_id,
    name:         r.name,
    symbol:       r.symbol,
    totalSupply:  r.total_supply,
    discoveredAt: r.discovered_at,
    lastPriceEth: r.last_price_eth,
    vol24hEth:    r.vol_24h_eth,
    mcapEth:      r.last_price_eth != null && r.total_supply != null
      ? (BigInt(r.last_price_eth) * BigInt(r.total_supply) / (10n ** 18n)).toString()
      : null,
    sparkline:    r.sparkline ?? [],
  }));
}

export async function getTokenCandles(
  pool:       Pool,
  address:    string,
  resolution: string,
): Promise<Array<{
  bucketTime: string; openEth: string; highEth: string;
  lowEth: string; closeEth: string; volumeEth: string; tradeCount: number;
}>> {
  const res = await pool.query<{
    bucket_time: string; open_eth: string; high_eth: string;
    low_eth: string; close_eth: string; volume_eth: string; trade_count: number;
  }>(
    `SELECT bucket_time::text, open_eth::text, high_eth::text,
            low_eth::text, close_eth::text, volume_eth::text, trade_count
     FROM candles
     WHERE token_address = $1
       AND resolution    = $2
     ORDER BY bucket_time ASC`,
    [address.toLowerCase(), resolution]
  );
  return res.rows.map((r) => ({
    bucketTime: r.bucket_time, openEth:  r.open_eth,  highEth:   r.high_eth,
    lowEth:     r.low_eth,     closeEth: r.close_eth, volumeEth: r.volume_eth,
    tradeCount: r.trade_count,
  }));
}
