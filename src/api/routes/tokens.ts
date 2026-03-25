import type { FastifyPluginAsync } from "fastify";
import type { Pool } from "pg";
import { KEYS, getEthUsdRate, type RedisClient } from "../../clients/redis";
import { withCache } from "../cache";
import {
  getTokenList, getTokenDetail, getTokenTrades, updateTokenMetadata,
  type TokenListRow, type TokenDetailRow,
} from "../../utils/db/tokens";
import { getTokenHolders }  from "../../utils/db/holders";
import { ethPriceToUsd, formatUsd } from "../../utils/math";
import { RESOLUTIONS }      from "../../utils/constants";
import { getTokenCandles }  from "../../utils/db/tokens";

interface Opts { pool: Pool; redis: RedisClient; }

// ── Sort options ──────────────────────────────────────────────────────────────

const SORT_OPTIONS = new Set(["marketCap", "volume", "trades", "newest"] as const);
type SortOption = "marketCap" | "volume" | "trades" | "newest";

// ── Shared shape builders ─────────────────────────────────────────────────────

/** Convert a raw wei bigint string to a human-readable ETH decimal string. */
function weiToEth(wei: string | null | undefined): string | null {
  if (wei == null) return null;
  try {
    const n = BigInt(wei);
    if (n === 0n) return "0";
    const WAD = 10n ** 18n;
    const whole = n / WAD;
    const frac  = n % WAD;
    if (frac === 0n) return whole.toString();
    return `${whole}.${frac.toString().padStart(18, "0").replace(/0+$/, "")}`;
  } catch { return null; }
}

interface HourDataPoint {
  periodStartUnix: number;
  volumeETH:       string;
  volumeUSD:       string | null;
  openPriceETH:    string | null;
  closePriceETH:   string | null;
}

interface TrendingToken {
  tokenAddress:                   string;
  image:                          string;
  symbol:                         string | null;
  name:                           string | null;
  priceETH:                       string | null;
  priceUSD:                       string | null;
  twentyFourHourChangePercentage: number | null;
  twentyFourHourVolume:           string;
  twentyFourHourVolumeUSD:        string | null;
  tradeCount24h:                  number;
  holderCount:                    number;
  feesEarned:                     string;
  feesEarnedUSD:                  string | null;
  marketCapETH:                   string | null;
  marketCapUSD:                   string | null;
  discoveredAt:                   string;
  royaltyMembers:                 Array<{ address: string; percentage: number }>;
  hourData:                       HourDataPoint[];
}

function buildRoyaltyMembers(
  members: Array<{ recipient: string; share: string }>,
  creator: string,
): Array<{ address: string; percentage: number }> {
  if (!members.length) return [{ address: creator, percentage: 100 }];
  const totalShares = members.reduce((s, m) => s + BigInt(m.share), 0n);
  return members.map((m) => ({
    address:    m.recipient,
    percentage: totalShares > 0n
      ? Number(BigInt(m.share) * 10000n / totalShares) / 100
      : 0,
  }));
}

function buildHourData(
  hourData: TokenListRow["hourData"],
  ethUsdRate: bigint | null,
  currentPriceEth: string | null,
): HourDataPoint[] {
  const points = hourData.map((h) => ({
    periodStartUnix: Number(h.periodStartUnix),
    volumeETH:       weiToEth(h.volumeEth) ?? "0",
    volumeUSD:       ethUsdRate
      ? formatUsd(ethPriceToUsd(BigInt(h.volumeEth), ethUsdRate))
      : null,
    openPriceETH:    weiToEth(h.openPriceEth),
    closePriceETH:   weiToEth(h.closePriceEth),
  }));

  // Append synthetic "now" entry so charts always extend to current moment
  if (currentPriceEth) {
    points.push({
      periodStartUnix: Math.floor(Date.now() / 1000),
      volumeETH:       "0",
      volumeUSD:       "0",
      openPriceETH:    weiToEth(currentPriceEth),
      closePriceETH:   weiToEth(currentPriceEth),
    });
  }

  return points;
}

function buildTrendingToken(r: TokenListRow, ethUsdRate: bigint | null): TrendingToken {
  const priceEthWei = r.lastPriceEth;
  const mcapEthWei  = r.mcapEth;

  const priceETH  = weiToEth(priceEthWei);
  const mcapETH   = weiToEth(mcapEthWei);
  const vol24hETH = weiToEth(r.vol24hEth) ?? "0";
  const feesETH   = weiToEth(r.feesEarnedEth) ?? "0";

  const priceUSD  = priceEthWei && ethUsdRate
    ? formatUsd(ethPriceToUsd(BigInt(priceEthWei), ethUsdRate)) : null;
  const mcapUSD   = mcapEthWei && ethUsdRate
    ? formatUsd(ethPriceToUsd(BigInt(mcapEthWei), ethUsdRate)) : null;
  const vol24hUSD = ethUsdRate
    ? formatUsd(ethPriceToUsd(BigInt(r.vol24hEth), ethUsdRate)) : null;
  const feesUSD   = ethUsdRate
    ? formatUsd(ethPriceToUsd(BigInt(r.feesEarnedEth), ethUsdRate)) : null;

  let change24h: number | null = null;
  if (priceEthWei && r.price24hOpenEth) {
    try {
      const current = Number(BigInt(priceEthWei));
      const open    = Number(BigInt(r.price24hOpenEth));
      if (open > 0) change24h = (current - open) / open * 100;
    } catch { /* ignore */ }
  }

  return {
    tokenAddress:                   r.tokenAddress,
    image:                          `https://i.flaunch.gg/token/${r.tokenAddress}`,
    symbol:                         r.symbol,
    name:                           r.name,
    priceETH,
    priceUSD,
    twentyFourHourChangePercentage: change24h,
    twentyFourHourVolume:           vol24hETH,
    twentyFourHourVolumeUSD:        vol24hUSD,
    tradeCount24h:                  r.tradeCount24h,
    holderCount:                    r.holderCount,
    feesEarned:                     feesETH,
    feesEarnedUSD:                  feesUSD,
    marketCapETH:                   mcapETH,
    marketCapUSD:                   mcapUSD,
    discoveredAt:                   r.discoveredAt,
    royaltyMembers:                 buildRoyaltyMembers(r.royaltyMembers, r.creator),
    hourData:                       buildHourData(r.hourData, ethUsdRate, priceEthWei),
  };
}

function sortTokens(tokens: TrendingToken[], sort: SortOption): TrendingToken[] {
  const sorted = [...tokens];
  switch (sort) {
    case "marketCap":
      return sorted.sort((a, b) => {
        if (!a.marketCapETH && !b.marketCapETH) return 0;
        if (!a.marketCapETH) return 1;
        if (!b.marketCapETH) return -1;
        return parseFloat(b.marketCapETH) - parseFloat(a.marketCapETH);
      });
    case "volume":
      return sorted.sort((a, b) =>
        parseFloat(b.twentyFourHourVolume) - parseFloat(a.twentyFourHourVolume)
      );
    case "trades":
      return sorted.sort((a, b) => b.tradeCount24h - a.tradeCount24h);
    case "newest":
      return sorted.sort((a, b) => new Date(b.discoveredAt).getTime() - new Date(a.discoveredAt).getTime());
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

export const tokenRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
  const { pool, redis } = opts;

  // ── GET /tokens ─────────────────────────────────────────────────────────────
  app.get<{ Querystring: { sort?: string; limit?: string; offset?: string } }>(
    "/",
    async (req, reply) => {
      const sortParam = req.query.sort ?? "marketCap";
      if (!SORT_OPTIONS.has(sortParam as SortOption)) {
        return reply.status(400).send({ error: `sort must be one of: ${[...SORT_OPTIONS].join(", ")}` });
      }
      const sort   = sortParam as SortOption;
      const limit  = Math.min(Number(req.query.limit  ?? 50) || 50, 200);
      const offset = Math.max(Number(req.query.offset ?? 0)  || 0,  0);

      let all: TrendingToken[];
      const cached = await redis.get(KEYS.apiTokenList());
      if (cached !== null) {
        all = JSON.parse(cached) as TrendingToken[];
      } else {
        const [rows, ethUsdRate] = await Promise.all([
          getTokenList(pool),
          getEthUsdRate(redis),
        ]);
        all = rows.map((r) => buildTrendingToken(r, ethUsdRate));
        await redis.setEx(KEYS.apiTokenList(), 5, JSON.stringify(all));
      }

      return reply.send(sortTokens(all, sort).slice(offset, offset + limit));
    },
  );

  // ── GET /tokens/:address ─────────────────────────────────────────────────────
  app.get<{ Params: { address: string } }>(
    "/:address",
    async (req, reply) => {
      const address = req.params.address.toLowerCase();

      const data = await withCache(redis, KEYS.apiTokenDetail(address), 5, async () => {
        const [row, ethUsdRate] = await Promise.all([
          getTokenDetail(pool, address),
          getEthUsdRate(redis),
        ]);
        if (!row) return null;

        const base  = buildTrendingToken(row as TokenListRow, ethUsdRate);
        const detail = row as TokenDetailRow;

        return {
          ...base,
          description: detail.description,
          website:     detail.website,
          twitter:     detail.twitter,
          telegram:    detail.telegram,
          poolId:    detail.poolId,
          pmAddress: detail.pmAddress,
          fairLaunch: detail.fairLaunchEndsAt ? {
            endsAt:   detail.fairLaunchEndsAt,
            endedAt:  detail.fairLaunchEndedAt,
            revenue:  detail.fairLaunchRevenue,
            supply:   detail.fairLaunchSupply,
            revenueUSD: detail.fairLaunchRevenue && ethUsdRate
              ? formatUsd(ethPriceToUsd(BigInt(detail.fairLaunchRevenue), ethUsdRate)) : null,
          } : null,
        };
      });

      if (!data) return reply.status(404).send({ error: "Token not found" });
      return reply.send(data);
    },
  );

  // ── GET /tokens/:address/candles ─────────────────────────────────────────────
  app.get<{
    Params:      { address: string };
    Querystring: { resolution?: string; from?: string; to?: string };
  }>(
    "/:address/candles",
    async (req, reply) => {
      const address    = req.params.address.toLowerCase();
      const resolution = req.query.resolution ?? "1h";

      if (!RESOLUTIONS.has(resolution)) {
        return reply.status(400).send({ error: `resolution must be one of: ${[...RESOLUTIONS].join(", ")}` });
      }

      const ethUsdRate = await getEthUsdRate(redis);
      const all = await withCache(redis, KEYS.apiCandles(address, resolution), 10, () =>
        getTokenCandles(pool, address, resolution)
      );

      // Enrich with USD prices
      const enriched = all.map((c) => ({
        ...c,
        openUSD:  ethUsdRate ? formatUsd(ethPriceToUsd(BigInt(c.openEth),  ethUsdRate)) : null,
        highUSD:  ethUsdRate ? formatUsd(ethPriceToUsd(BigInt(c.highEth),  ethUsdRate)) : null,
        lowUSD:   ethUsdRate ? formatUsd(ethPriceToUsd(BigInt(c.lowEth),   ethUsdRate)) : null,
        closeUSD: ethUsdRate ? formatUsd(ethPriceToUsd(BigInt(c.closeEth), ethUsdRate)) : null,
        volumeUSD: ethUsdRate ? formatUsd(ethPriceToUsd(BigInt(c.volumeEth), ethUsdRate)) : null,
      }));

      if (req.query.from || req.query.to) {
        const to   = req.query.to   ? BigInt(req.query.to)   : BigInt(Math.floor(Date.now() / 1000));
        const from = req.query.from ? BigInt(req.query.from) : 0n;
        return reply.send(enriched.filter((c) => BigInt(c.bucketTime) >= from && BigInt(c.bucketTime) <= to));
      }

      return reply.send(enriched);
    },
  );

  // ── GET /tokens/:address/trades ──────────────────────────────────────────────
  app.get<{
    Params:      { address: string };
    Querystring: { limit?: string; offset?: string };
  }>(
    "/:address/trades",
    async (req, reply) => {
      const address = req.params.address.toLowerCase();
      const limit   = Math.min(Number(req.query.limit  ?? 50), 200);
      const offset  = Math.max(Number(req.query.offset ?? 0),  0);

      const [result, ethUsdRate] = await Promise.all([
        getTokenTrades(pool, address, limit, offset),
        getEthUsdRate(redis),
      ]);

      const trades = result.trades.map((t) => ({
        ...t,
        amountETH: weiToEth(t.amountETH) ?? t.amountETH,
        priceETH:  weiToEth(t.priceETH)  ?? t.priceETH,
        feeETH:    weiToEth(t.feeETH),
        amountUSD: ethUsdRate && t.amountETH
          ? formatUsd(ethPriceToUsd(BigInt(t.amountETH), ethUsdRate)) : null,
        priceUSD: ethUsdRate && t.priceETH
          ? formatUsd(ethPriceToUsd(BigInt(t.priceETH), ethUsdRate)) : null,
      }));

      return reply.send({ trades, total: result.total, limit, offset });
    },
  );

  // ── PATCH /tokens/:address/metadata ──────────────────────────────────────────
  app.patch<{
    Params: { address: string };
    Body:   { creator: string; description?: string; website?: string; twitter?: string; telegram?: string };
  }>(
    "/:address/metadata",
    async (req, reply) => {
      const address = req.params.address.toLowerCase();
      const { creator, description, website, twitter, telegram } = req.body ?? {};

      if (!creator) return reply.status(400).send({ error: "creator address required" });

      // Verify the caller is the token's creator
      const row = await pool.query<{ creator: string }>(
        "SELECT creator FROM token_registry WHERE token_address = $1 LIMIT 1",
        [address],
      );
      if (!row.rows.length) return reply.status(404).send({ error: "Token not found" });
      if (row.rows[0].creator.toLowerCase() !== creator.toLowerCase()) {
        return reply.status(403).send({ error: "Only the token creator can update metadata" });
      }

      await updateTokenMetadata(pool, address, { description, website, twitter, telegram });

      // Bust cache so next fetch reflects the update
      await redis.del(KEYS.apiTokenDetail(address));
      await redis.del(KEYS.apiTokenList());

      return reply.status(204).send();
    },
  );

  // ── GET /tokens/:address/holders ─────────────────────────────────────────────
  app.get<{
    Params:      { address: string };
    Querystring: { limit?: string; offset?: string };
  }>(
    "/:address/holders",
    async (req, reply) => {
      const address = req.params.address.toLowerCase();
      const limit   = Math.min(Number(req.query.limit  ?? 50), 200);
      const offset  = Math.max(Number(req.query.offset ?? 0),  0);

      const [ethUsdRate, tokenRow] = await Promise.all([
        getEthUsdRate(redis),
        getTokenDetail(pool, address),
      ]);

      const priceEth   = tokenRow?.lastPriceEth  ? BigInt(tokenRow.lastPriceEth) : null;
      const totalSupply = tokenRow?.totalSupply  ? BigInt(tokenRow.totalSupply)  : null;

      const result = await getTokenHolders(pool, address, limit, offset, ethUsdRate, priceEth, totalSupply);
      return reply.send({ holders: result.holders, total: result.total, limit, offset });
    },
  );
};
