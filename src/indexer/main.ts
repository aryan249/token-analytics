import "dotenv/config";
import { config }          from "../config/config";
import { logger }          from "../utils/logger";
import { Scanner }         from "./scanner";
import { makePool }        from "../clients/postgres";
import { bootstrapSchema } from "../utils/db/schema";
import { makeRedisClient } from "../clients/redis";

async function main() {
  logger.info({ chainId: config.chainId, nodeEnv: config.nodeEnv }, "Indexer starting");

  const pool = makePool(config.postgresUrl);
  await bootstrapSchema(pool);

  const primaryRedis = await makeRedisClient(config.redisUrl);
  const replicaClients = await Promise.all(
    config.redisReplicaUrls.map(url => makeRedisClient(url))
  );
  const allRedisClients = [primaryRedis, ...replicaClients];
  logger.info({ regions: allRedisClients.length }, "Connected to Redis instances");

  const scanner = new Scanner(pool, allRedisClients);

  let shuttingDown = false;
  async function shutdown(sig: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ sig }, "Shutting down");
    scanner.stop();
    await Promise.all(allRedisClients.map(c => c.quit()));
    await pool.end();
    process.exit(0);
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT",  () => void shutdown("SIGINT"));
  process.on("uncaughtException",  (err)    => { logger.fatal({ err },    "Uncaught exception");  void shutdown("uncaughtException"); });
  process.on("unhandledRejection", (reason) => { logger.fatal({ reason }, "Unhandled rejection"); void shutdown("unhandledRejection"); });

  await scanner.start();
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });