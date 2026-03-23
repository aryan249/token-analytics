import type { Pool } from "pg";

export interface HolderRow {
  wallet:      string;
  balance:     string;
  balanceUSD:  string | null;
  percentage:  string;
}

export async function getTokenHolders(
  pool:        Pool,
  tokenAddress: string,
  limit:        number,
  offset:       number,
  ethUsdRate?:  bigint | null,
  priceEth?:    bigint | null,
  totalSupply?: bigint | null,
): Promise<{ holders: HolderRow[]; total: number }> {
  const addr = tokenAddress.toLowerCase();

  const pmRes = await pool.query<{ pm_address: string }>(
    `SELECT pm_address FROM token_registry WHERE token_address = $1 LIMIT 1`,
    [addr]
  );
  const pmAddress = pmRes.rows[0]?.pm_address ?? "";

  const [countRes, rowsRes] = await Promise.all([
    pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM holder_balances WHERE token_address = $1 AND balance > 0 AND wallet != $2`,
      [addr, pmAddress]
    ),
    pool.query<{ wallet: string; balance: string }>(
      `SELECT wallet, balance::text
       FROM holder_balances
       WHERE token_address = $1 AND balance > 0 AND wallet != $2
       ORDER BY balance DESC
       LIMIT $3 OFFSET $4`,
      [addr, pmAddress, limit, offset]
    ),
  ]);

  const total = Number(countRes.rows[0]?.count ?? 0);

  const holders: HolderRow[] = rowsRes.rows.map((r) => {
    const bal = BigInt(r.balance);

    let balanceUSD: string | null = null;
    if (priceEth && ethUsdRate) {
      // valueETH (wei) = balance * priceEth / 1e18
      // valueUSD       = valueETH * ethUsdRate / 1e26  (rate has 8 decimals, ETH has 18)
      const valueEthWei = bal * priceEth / (10n ** 18n);
      const usdCents    = valueEthWei * ethUsdRate * 100n / (10n ** 26n);
      balanceUSD = (Number(usdCents) / 100).toFixed(2);
    }

    let percentage = "0.0000";
    if (totalSupply && totalSupply > 0n) {
      const pctBps = bal * 1_000_000n / totalSupply; // basis-points × 100
      percentage = (Number(pctBps) / 10000).toFixed(4);
    }

    return { wallet: r.wallet, balance: r.balance, balanceUSD, percentage };
  });

  return { holders, total };
}

export async function getHolderCount(pool: Pool, tokenAddress: string): Promise<number> {
  const res = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM holder_balances WHERE token_address = $1 AND balance > 0`,
    [tokenAddress.toLowerCase()]
  );
  return Number(res.rows[0]?.count ?? 0);
}
