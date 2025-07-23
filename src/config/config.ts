// src/indexer/config.ts

import { z } from "zod";
import "dotenv/config";

const Schema = z.object({
  alchemyWsUrl:      z.string().url(),
  postgresUrl:       z.string().url(),
  redisUrl:          z.string().url().default("redis://localhost:6379"),
  chainId:           z.coerce.number().int().positive().default(8453),
  confirmationDepth: z.coerce.number().int().min(1).default(3),
  batchSize:         z.coerce.number().int().min(1).max(500).default(50),
  startBlock:        z.coerce.bigint().default(0n),
  logLevel:          z.enum(["trace","debug","info","warn","error"]).default("info"),
  nodeEnv:           z.enum(["development","staging","production"]).default("development"),
});

export type Config = z.infer<typeof Schema>;

function load(): Config {
  const result = Schema.safeParse({
    alchemyWsUrl:      process.env.ALCHEMY_WS_URL,
    postgresUrl:       process.env.POSTGRES_URL,
    redisUrl:          process.env.REDIS_URL,
    chainId:           process.env.CHAIN_ID,
    confirmationDepth: process.env.CONFIRMATION_DEPTH,
    batchSize:         process.env.BATCH_SIZE,
    startBlock:        process.env.START_BLOCK,
    logLevel:          process.env.LOG_LEVEL,
    nodeEnv:           process.env.NODE_ENV,
  });

  if (!result.success) {
    const msg = result.error.issues.map((e) => `  • ${e.path.join(".")}: ${e.message}`).join("\n");
    throw new Error(`Invalid config:\n${msg}`);
  }

  return result.data;
}

export const config = load();