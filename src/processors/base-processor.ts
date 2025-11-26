import { createClient, type RedisClientType } from "redis";
import type { Pool } from "pg";
import { makePool } from "../clients/postgres";
import { makeRedisClient, type RedisClient } from "../clients/redis";
import { bootstrapSchema } from "../utils/db/schema";
import { logger } from "../utils/logger";
import type { DecodedEvent } from "../types/events";

function bigIntReviver(_k: string, v: unknown): unknown {
  return typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v;
}

export abstract class BaseProcessor {
  protected readonly redisUrl:    string;
  protected readonly postgresUrl: string;

  // Pool is created once and shared across all handle() calls
  protected readonly pool: Pool;
  // Publisher for sending updates to the WebSocket gateway via Redis pub/sub
  protected publisher!: RedisClient;

  constructor(redisUrl: string, postgresUrl: string) {
    this.redisUrl    = redisUrl;
    this.postgresUrl = postgresUrl;
    this.pool        = makePool(postgresUrl);
  }

  abstract get channel(): string;
  abstract handle(event: DecodedEvent): Promise<void>;

  async start(): Promise<void> {
    // Ensure all tables exist before subscribing — processor is self-sufficient
    await bootstrapSchema(this.pool);
    logger.info({ channel: this.channel }, "Schema ready");

    // Publisher for outbound updates to the WS gateway
    this.publisher = await makeRedisClient(this.redisUrl);

    // Subscriber needs its own dedicated connection — subscribe mode is exclusive
    const sub = createClient({ url: this.redisUrl }) as RedisClientType;
    sub.on("error",        (err) => logger.error({ err }, "Redis subscriber error"));
    sub.on("reconnecting", ()    => logger.warn("Redis subscriber reconnecting"));
    await sub.connect();

    await sub.subscribe(this.channel, async (message) => {
      try {
        const event = JSON.parse(message, bigIntReviver) as DecodedEvent;
        await this.handle(event);
      } catch (err) {
        logger.error({ err, channel: this.channel }, "Processor handle error");
      }
    });

    logger.info({ channel: this.channel }, "Processor subscribed and waiting");
  }
}