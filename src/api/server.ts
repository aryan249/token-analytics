import "dotenv/config";
import path            from "path";
import crypto          from "crypto";
import Fastify         from "fastify";
import cors            from "@fastify/cors";
import rateLimit       from "@fastify/rate-limit";
import fastifyStatic   from "@fastify/static";
import websocketPlugin from "@fastify/websocket";
import Redis           from "ioredis";
import { createPublicClient, http, parseAbi } from "viem";
import { base } from "viem/chains";
import { makePool }          from "../clients/postgres";
import { makeRedisClient, getEthUsdRate, setEthUsdRate, type RedisClient } from "../clients/redis";
import { bootstrapSchema }   from "../utils/db/schema";
import { logger }            from "../utils/logger";
import { tokenRoutes }       from "./routes/tokens";
import { userRoutes }        from "./routes/users";
import { statsRoutes }       from "./routes/stats";
import { authRoutes, jwtAuthHook } from "./auth";
import { gatewayPlugin }     from "../ws/gateway";

const CHAINLINK_ADDRESS = "0x57d2d46Fc7ff2A7142d479F2f59e1E3F95447077";
const CHAINLINK_READ_ABI = parseAbi(["function latestAnswer() view returns (int256)"]);

async function seedEthUsdRate(redis: RedisClient, rpcUrl: string): Promise<void> {
  const existing = await getEthUsdRate(redis);
  if (existing !== null) return;

  try {
    const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
    const answer = await client.readContract({
      address: CHAINLINK_ADDRESS as `0x${string}`,
      abi:     CHAINLINK_READ_ABI,
      functionName: "latestAnswer",
    });
    await setEthUsdRate(redis, answer as bigint);
    logger.info({ rate: `$${(Number(answer) / 1e8).toFixed(2)}` }, "ETH/USD rate seeded from Chainlink");
  } catch (err) {
    logger.warn({ err }, "Failed to seed ETH/USD rate from Chainlink — USD prices will be null until indexer updates");
  }
}

async function main(): Promise<void> {
  const pgUrl     = process.env.POSTGRES_URL!;
  const pgReadUrl = process.env.POSTGRES_READ_URL ?? pgUrl;
  const redisUrl  = process.env.REDIS_URL ?? "redis://localhost:6379";
  const rpcUrl    = process.env.RPC_URL ?? process.env.ALCHEMY_WS_URL?.replace(/^wss?:\/\//, "https://") ?? "";
  const port      = Number(process.env.API_PORT ?? 3000);
  const jwtSecret = process.env.JWT_SECRET ?? "";
  const jwtExpiry = process.env.JWT_EXPIRY ?? "24h";

  const writePool = makePool(pgUrl);
  const readPool  = makePool(pgReadUrl);
  const redis     = await makeRedisClient(redisUrl);

  await bootstrapSchema(writePool);
  if (rpcUrl) await seedEthUsdRate(redis, rpcUrl);

  const app = Fastify({ logger: false });

  // Global error handler
  app.setErrorHandler((err, req, reply) => {
    if (err.statusCode === 429) {
      return reply.status(429).send({ error: err.message });
    }
    logger.error({ err, url: req.url, method: req.method, requestId: req.id }, "Unhandled route error");
    reply.status(err.statusCode ?? 500).send({ error: err.message ?? "Internal server error" });
  });

  // Request ID + logging
  app.addHook("onRequest", async (req) => {
    (req as any).requestId = req.id ?? crypto.randomUUID();
  });

  await app.register(cors, { origin: true });
  await app.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
    allowList: ["127.0.0.1"],
    keyGenerator: (req) => req.ip,
    redis: new Redis(redisUrl),
  });
  await app.register(websocketPlugin, { options: { maxPayload: 256 } });

  // JWT auth hook
  if (jwtSecret) {
    app.addHook("onRequest", jwtAuthHook(jwtSecret));
    logger.info("JWT authentication enabled");
  }

  // Health
  app.get("/health", async () => ({
    status:    "ok",
    timestamp: new Date().toISOString(),
    wsClients: 0,
  }));

  // Auth routes (public)
  if (jwtSecret) {
    await app.register(authRoutes, { redis, jwtSecret, jwtExpiry, prefix: "/auth" });
  }

  // REST routes
  await app.register(tokenRoutes,  { pool: readPool, redis, prefix: "/tokens" });
  await app.register(userRoutes,   { pool: readPool, redis, prefix: "/users"  });
  await app.register(statsRoutes,  { pool: readPool, redis, prefix: "/stats"  });

  // Static frontend
  await app.register(fastifyStatic, {
    root:   path.join(__dirname, "../../public"),
    prefix: "/",
    decorateReply: false,
  });

  // WebSocket gateway
  await app.register(gatewayPlugin, { redisUrl, pool: readPool });

  await app.listen({ port, host: "0.0.0.0" });
  logger.info({ port }, "API + WebSocket server listening");

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down API server");
    await app.close();
    await redis.quit();
    await readPool.end();
    await writePool.end();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT",  () => void shutdown("SIGINT"));
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
