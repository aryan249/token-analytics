import type { FastifyPluginAsync } from "fastify";
import type { Pool } from "pg";
import { KEYS, type RedisClient } from "../../clients/redis";
import { withCache } from "../cache";
import { getTokenList, getTokenCandles } from "../../utils/db/tokens";
import { RESOLUTIONS } from "../../utils/constants";

interface Opts { pool: Pool; redis: RedisClient; }

export const tokenRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
  const { pool, redis } = opts;

  // GET /tokens?limit=50&offset=0
  // Full list cached once; limit/offset applied in code after cache hit.
  app.get<{ Querystring: { limit?: string; offset?: string } }>(
    "/",
    async (req, reply) => {
      const limit  = Math.min(Number(req.query.limit  ?? 50),  200);
      const offset = Math.max(Number(req.query.offset ?? 0),   0);

      const all  = await withCache(redis, KEYS.apiTokenList(), 30, () => getTokenList(pool));
      return reply.send(all.slice(offset, offset + limit));
    },
  );

  // GET /tokens/:address/candles?resolution=1h&from=<unix>&to=<unix>
  // All candles for address+resolution cached once; from/to filtering applied in code.
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

      const to   = req.query.to   ? BigInt(req.query.to)   : BigInt(Math.floor(Date.now() / 1000));
      const from = req.query.from ? BigInt(req.query.from)  : to - 86400n;

      const all      = await withCache(redis, KEYS.apiCandles(address, resolution), 30, () => getTokenCandles(pool, address, resolution));
      const filtered = all.filter((c) => BigInt(c.bucketTime) >= from && BigInt(c.bucketTime) <= to);
      return reply.send(filtered);
    },
  );
};
