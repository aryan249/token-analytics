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
import { registry, httpRequestDuration, httpRequestsTotal } from "../utils/metrics";
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
  app.setErrorHandler((err: any, req, reply) => {
    if (err.statusCode === 429) {
      return reply.status(429).send({ error: err.message });
    }
    logger.error({ err, url: req.url, method: req.method, requestId: req.id }, "Unhandled route error");
    return reply.status(err.statusCode ?? 500).send({ error: err.message ?? "Internal server error" });
  });

  // Request ID + metrics timing
  app.addHook("onRequest", async (req) => {
    (req as any).requestId = req.id ?? crypto.randomUUID();
    (req as any).startTime = process.hrtime.bigint();
  });
  app.addHook("onResponse", async (req, reply) => {
    const start = (req as any).startTime as bigint | undefined;
    if (start) {
      const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
      const route = req.routeOptions?.url ?? req.url.split("?")[0];
      httpRequestDuration.observe({ method: req.method, route, status_code: reply.statusCode }, durationSec);
      httpRequestsTotal.inc({ method: req.method, route, status_code: reply.statusCode });
    }
  });

  const rateLimitRedis = new Redis(redisUrl);
  const corsOrigin = process.env.CORS_ORIGIN ?? true;
  await app.register(cors, { origin: corsOrigin });
  await app.register(rateLimit, {
    max: 1000,
    timeWindow: "1 minute",
    allowList: ["127.0.0.1"],
    keyGenerator: (req) => req.ip,
    redis: rateLimitRedis,
  });
  await app.register(websocketPlugin, { options: { maxPayload: 256 } });

  // JWT auth hook
  if (jwtSecret) {
    app.addHook("onRequest", jwtAuthHook(jwtSecret));
    logger.info("JWT authentication enabled");
  }

  // Health — verify Redis + Postgres connectivity
  app.get("/health", async (_req, reply) => {
    const checks: Record<string, string> = {};
    let healthy = true;

    try {
      await redis.ping();
      checks.redis = "ok";
    } catch {
      checks.redis = "fail";
      healthy = false;
    }

    try {
      await readPool.query("SELECT 1");
      checks.postgres = "ok";
    } catch {
      checks.postgres = "fail";
      healthy = false;
    }

    const body = {
      status:    healthy ? "ok" : "degraded",
      timestamp: new Date().toISOString(),
      checks,
    };
    return reply.status(healthy ? 200 : 503).send(body);
  });

  // Prometheus metrics endpoint (internal — not exposed via ALB)
  app.get("/metrics", async (_req, reply) => {
    reply.header("content-type", registry.contentType);
    return reply.send(await registry.metrics());
  });

  // CSP + security headers on all responses
  app.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("X-XSS-Protection", "1; mode=block");
    reply.header("Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' https://i.flaunch.gg data:; connect-src 'self' wss: ws:; font-src 'self';");
  });

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
    await rateLimitRedis.quit();
    await redis.quit();
    await readPool.end();
    await writePool.end();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT",  () => void shutdown("SIGINT"));
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
