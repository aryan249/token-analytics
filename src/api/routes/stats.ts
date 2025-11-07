import type { FastifyPluginAsync } from "fastify";
import type { Pool } from "pg";
import { KEYS, getEthUsdRate, type RedisClient } from "../../clients/redis";
import { withCache }       from "../cache";
import { getPlatformStats, getTopFeeEarners24h } from "../../utils/db/stats";
import { ethPriceToUsd, formatUsd, weiToEth } from "../../utils/math";


interface Opts { pool: Pool; redis: RedisClient; }

export const statsRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
  const { pool, redis } = opts;

  // GET /stats
  app.get("/", async (_req, reply) => {
    const data = await withCache(redis, KEYS.apiStats(), 10, async () => {
      const [stats, topEarners, ethUsdRate] = await Promise.all([
        getPlatformStats(pool),
        getTopFeeEarners24h(pool),
        getEthUsdRate(redis),
      ]);

      return {
        totalTokens:    stats.totalTokens,
        totalTrades:    stats.totalTrades,
        totalHolders:   stats.totalHolders,
        totalVolumeETH: weiToEth(stats.totalVolumeETH) ?? "0",
        totalVolumeUSD: ethUsdRate
          ? formatUsd(ethPriceToUsd(BigInt(stats.totalVolumeETH), ethUsdRate)) : null,
        totalFeesETH:   weiToEth(stats.totalFeesETH) ?? "0",
        totalFeesUSD:   ethUsdRate
          ? formatUsd(ethPriceToUsd(BigInt(stats.totalFeesETH), ethUsdRate)) : null,
        topFeeEarners24h: topEarners.map((e) => ({
          wallet:      e.wallet,
          earnedETH:   e.earnedEth,
          earnedUSD:   ethUsdRate
            ? formatUsd(ethPriceToUsd(BigInt(e.earnedEth), ethUsdRate)) : null,
        })),
      };
    });

    return reply.send(data);
  });

  // ── GET /stats/top-earners ───────────────────────────────────────────────────
  app.get<{ Querystring: { sort?: string; limit?: string } }>(
    "/top-earners",
    async (req, reply) => {
      const limit = Math.min(Number(req.query.limit ?? 10), 100);

      const data = await withCache(redis, `${KEYS.apiStats()}:top-earners:${limit}`, 15, async () => {
        const [rows, ethUsdRate] = await Promise.all([
          pool.query<{ token_address: string; symbol: string | null; lifetime_fees_eth: string }>(
            `SELECT
               tr.token_address,
               tr.symbol,
               COALESCE(SUM(fd.creator_amount), 0)::text AS lifetime_fees_eth
             FROM token_registry tr
             LEFT JOIN fee_distributions fd ON fd.token_address = tr.token_address
             GROUP BY tr.token_address, tr.symbol
             ORDER BY SUM(COALESCE(fd.creator_amount, 0)) DESC
             LIMIT $1`,
            [limit],
          ),
          getEthUsdRate(redis),
        ]);

        return {
          data: rows.rows.map((r) => {
            const feesEthDecimal = weiToEth(r.lifetime_fees_eth) ?? "0";
            const feesUSD = ethUsdRate
              ? formatUsd(ethPriceToUsd(BigInt(r.lifetime_fees_eth), ethUsdRate)) : null;
            return {
              tokenAddress:    r.token_address,
              symbol:          r.symbol,
              imageUrl:        `https://i.flaunch.gg/token/${r.token_address}`,
              lifetimeFeesETH: feesEthDecimal,
              lifetimeFeesUSD: feesUSD,
            };
          }),
        };
      });

      return reply.send(data);
    },
  );
};
