import type { FastifyPluginAsync } from "fastify";
import type { Pool } from "pg";
import { KEYS, getEthUsdRate, type RedisClient } from "../../clients/redis";
import { withCache } from "../cache";
import { getWalletRoyalties }  from "../../utils/db/fees";
import { getWalletActivity }   from "../../utils/db/activity";
import { ethPriceToUsd, formatUsd } from "../../utils/math";

function weiToEth(wei: string | bigint | null | undefined): string | null {
  if (wei == null) return null;
  try {
    const n = typeof wei === "bigint" ? wei : BigInt(wei);
    if (n === 0n) return "0";
    const WAD = 10n ** 18n;
    const whole = n / WAD;
    const frac  = n % WAD;
    if (frac === 0n) return whole.toString();
    return `${whole}.${frac.toString().padStart(18, "0").replace(/0+$/, "")}`;
  } catch { return null; }
}

interface Opts { pool: Pool; redis: RedisClient; }

const ADDR_RE = /^0x[a-f0-9]{40}$/;

export const userRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
  const { pool, redis } = opts;

  app.addHook("preHandler", async (req, reply) => {
    const wallet = (req.params as any)?.wallet;
    if (wallet && !ADDR_RE.test(wallet.toLowerCase())) {
      return reply.status(400).send({ error: "Invalid wallet address" });
    }
  });

  // ── GET /users/:wallet/positions ──────────────────────────────────────────────
  // Positions from holder_balances (current token holdings)
  app.get<{ Params: { wallet: string }; Querystring: { limit?: string; offset?: string } }>(
    "/:wallet/positions",
    async (req, reply) => {
      const wallet = req.params.wallet.toLowerCase();
      const limit  = Math.min(Number(req.query.limit ?? 50) || 50, 200);
      const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);

      const [ethUsdRate, result] = await Promise.all([
        getEthUsdRate(redis),
        pool.query<{
          token_address: string; name: string | null; symbol: string | null;
          total_supply: string | null; balance: string; price_eth: string | null;
          cost_basis_eth: string | null; realized_pnl_eth: string | null;
          total: string;
        }>(`
          SELECT
            hb.token_address,
            tr.name, tr.symbol, tr.total_supply::text,
            hb.balance::text,
            c.close_eth::text AS price_eth,
            p.cost_basis_eth::text,
            p.realized_pnl_eth::text,
            COUNT(*) OVER () ::text AS total
          FROM holder_balances hb
          JOIN token_registry tr ON tr.token_address = hb.token_address
          LEFT JOIN LATERAL (
            SELECT close_eth FROM candles
            WHERE token_address = hb.token_address AND resolution = '1m'
            ORDER BY bucket_time DESC LIMIT 1
          ) c ON true
          LEFT JOIN positions p
            ON p.wallet_address = hb.wallet AND p.token_address = hb.token_address
          WHERE hb.wallet = $1 AND hb.balance > 0
          ORDER BY (hb.balance * COALESCE(c.close_eth, 0)) DESC
          LIMIT $2 OFFSET $3
        `, [wallet, limit, offset]),
      ]);

      const total = Number(result.rows[0]?.total ?? 0);

      const WAD = 10n ** 18n;
      const positions = result.rows.map((r) => {
        const bal       = BigInt(r.balance);
        const priceEth  = r.price_eth ? BigInt(r.price_eth) : null;
        const supply    = r.total_supply ? BigInt(r.total_supply) : null;

        const valueEthWei      = priceEth ? (bal * priceEth / WAD) : null;
        const costBasisWei     = r.cost_basis_eth ? BigInt(r.cost_basis_eth) : null;
        const realizedPnlWei   = r.realized_pnl_eth ? BigInt(r.realized_pnl_eth) : null;
        const unrealizedPnlWei = valueEthWei != null && costBasisWei != null
          ? valueEthWei - costBasisWei : null;

        const valueETH         = weiToEth(valueEthWei);
        const valueUSD         = valueEthWei && ethUsdRate
          ? formatUsd(Number(valueEthWei * ethUsdRate * 100n / (10n ** 26n)) / 100) : null;
        const priceUSD         = priceEth && ethUsdRate
          ? formatUsd(ethPriceToUsd(priceEth, ethUsdRate)) : null;
        const pctOfSupply      = supply && supply > 0n
          ? (Number(bal) / Number(supply) * 100).toFixed(4) : null;
        const unrealizedPnlUSD = unrealizedPnlWei != null && ethUsdRate
          ? ethPriceToUsd(unrealizedPnlWei < 0n ? -unrealizedPnlWei : unrealizedPnlWei, ethUsdRate)
            * (unrealizedPnlWei < 0n ? -1 : 1) : null;
        const realizedPnlUSD   = realizedPnlWei != null && ethUsdRate
          ? ethPriceToUsd(realizedPnlWei < 0n ? -realizedPnlWei : realizedPnlWei, ethUsdRate)
            * (realizedPnlWei < 0n ? -1 : 1) : null;

        return {
          tokenAddress:    r.token_address,
          name:            r.name,
          symbol:          r.symbol,
          image:           `https://i.flaunch.gg/token/${r.token_address}`,
          balance:         r.balance,
          valueETH,
          valueUSD,
          priceETH:        weiToEth(r.price_eth),
          priceUSD,
          pctOfSupply,
          costBasisETH:    weiToEth(r.cost_basis_eth),
          unrealizedPnlETH: weiToEth(unrealizedPnlWei),
          unrealizedPnlUSD: unrealizedPnlUSD != null ? formatUsd(unrealizedPnlUSD) : null,
          realizedPnlETH:  r.realized_pnl_eth,
          realizedPnlUSD:  realizedPnlUSD != null ? formatUsd(realizedPnlUSD) : null,
        };
      });

      return reply.send({ positions, total, limit, offset });
    },
  );

  // ── GET /users/:wallet/royalties ──────────────────────────────────────────────
  app.get<{ Params: { wallet: string } }>(
    "/:wallet/royalties",
    async (req, reply) => {
      const wallet = req.params.wallet.toLowerCase();

      const data = await withCache(
        redis, KEYS.apiRoyalties(wallet), 15,
        async () => {
          const [summary, ethUsdRate] = await Promise.all([
            getWalletRoyalties(pool, wallet),
            getEthUsdRate(redis),
          ]);

          const byToken = summary.byToken.map((t) => ({
            ...t,
            earnedUSD:   ethUsdRate
              ? formatUsd(ethPriceToUsd(BigInt(t.earnedEth),   ethUsdRate)) : null,
            claimedUSD:  ethUsdRate
              ? formatUsd(ethPriceToUsd(BigInt(t.claimedEth),  ethUsdRate)) : null,
            claimableUSD: ethUsdRate
              ? formatUsd(ethPriceToUsd(BigInt(t.claimableEth), ethUsdRate)) : null,
            marketCapUSD: t.marketCapETH && ethUsdRate
              ? formatUsd(ethPriceToUsd(BigInt(t.marketCapETH), ethUsdRate)) : null,
          }));

          return {
            totalEarnedEth:   summary.totalEarnedEth,
            totalClaimedEth:  summary.totalClaimedEth,
            claimableEth:     summary.claimableEth,
            totalEarnedUSD:   ethUsdRate
              ? formatUsd(ethPriceToUsd(BigInt(summary.totalEarnedEth), ethUsdRate)) : null,
            byToken,
          };
        },
      );

      return reply.send(data);
    },
  );

  // ── GET /users/:wallet/activity ───────────────────────────────────────────────
  app.get<{ Params: { wallet: string }; Querystring: { limit?: string; offset?: string } }>(
    "/:wallet/activity",
    async (req, reply) => {
      const wallet = req.params.wallet.toLowerCase();
      const limit  = Math.min(Number(req.query.limit ?? 50) || 50, 200);
      const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);

      const [result, ethUsdRate] = await Promise.all([
        getWalletActivity(pool, wallet, limit, offset),
        getEthUsdRate(redis),
      ]);

      const items = result.items.map((item) => ({
        ...item,
        amountUSD: ethUsdRate && item.amountETH && item.amountETH !== "0"
          ? formatUsd(ethPriceToUsd(BigInt(item.amountETH), ethUsdRate)) : null,
        priceUSD: ethUsdRate && item.priceETH
          ? formatUsd(ethPriceToUsd(BigInt(item.priceETH), ethUsdRate)) : null,
      }));

      return reply.send({ items, total: result.total, limit, offset });
    },
  );
};
