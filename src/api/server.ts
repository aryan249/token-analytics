import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { makePool } from "../clients/postgres";
import { makeRedisClient } from "../clients/redis";
import { bootstrapSchema } from "../utils/db/schema";
import { logger } from "../utils/logger";
import { tokenRoutes } from "./routes/tokens";
import { userRoutes } from "./routes/users";

async function main(): Promise<void> {
  const pgUrl      = process.env.POSTGRES_URL!;
  // Route GET requests to a read replica if configured, otherwise use primary
  const pgReadUrl  = process.env.POSTGRES_READ_URL ?? pgUrl;
  const redisUrl   = process.env.REDIS_URL ?? "redis://localhost:6379";
  const port       = Number(process.env.API_PORT ?? 3000);

  const writePool = makePool(pgUrl);
  const readPool  = makePool(pgReadUrl);
  const redis     = await makeRedisClient(redisUrl);

  // Ensure schema exists (uses write pool; idempotent)
  await bootstrapSchema(writePool);

  const app = Fastify({ logger: false });

  await app.register(cors, { origin: true });

  // Health check
  app.get("/health", async () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
  }));

  await app.register(tokenRoutes, { pool: readPool, redis, prefix: "/tokens" });
  await app.register(userRoutes,  { pool: readPool, redis, prefix: "/users"  });

  await app.listen({ port, host: "0.0.0.0" });
  logger.info({ port }, "API server listening");
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
