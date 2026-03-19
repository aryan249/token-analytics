import type { FastifyPluginAsync } from "fastify";
import type { Pool } from "pg";
import { KEYS, type RedisClient } from "../../clients/redis";
import { withCache } from "../cache";
import { getWalletPositions } from "../../utils/db/positions";
import { getWalletRoyalties } from "../../utils/db/fees";

interface Opts { pool: Pool; redis: RedisClient; }

export const userRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
  const { pool, redis } = opts;

  // GET /users/:wallet/positions
  app.get<{ Params: { wallet: string } }>(
    "/:wallet/positions",
    async (req, reply) => {
      const wallet = req.params.wallet.toLowerCase();
      const data   = await withCache(
        redis,
        KEYS.apiPositions(wallet),
        30,
        () => getWalletPositions(pool, wallet),
      );
      return reply.send(data);
    },
  );

  // GET /users/:wallet/royalties
  app.get<{ Params: { wallet: string } }>(
    "/:wallet/royalties",
    async (req, reply) => {
      const wallet = req.params.wallet.toLowerCase();
      const data   = await withCache(
        redis,
        KEYS.apiRoyalties(wallet),
        60,
        () => getWalletRoyalties(pool, wallet),
      );
      return reply.send(data);
    },
  );
};
