import type { Pool } from "pg";
import { makePool } from "../clients/postgres";
import { makeRedisClient, type RedisClient } from "../clients/redis";
import { bootstrapSchema } from "../utils/db/schema";
import { logger } from "../utils/logger";
import type { DecodedEvent } from "../types/events";

function bigIntReviver(_k: string, v: unknown): unknown {
  return typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v;
}

const BLOCK_TIMEOUT = 5000;
const CLAIM_IDLE_MS = 30_000;
const CLAIM_INTERVAL_MS = 10_000;

export abstract class BaseProcessor {
  protected readonly redisUrl: string;
  protected readonly pool: Pool;
  protected publisher!: RedisClient;

  private consumer!: RedisClient;
  private running = false;

  constructor(redisUrl: string, postgresUrl: string) {
    this.redisUrl = redisUrl;
    this.pool = makePool(postgresUrl);
  }

  abstract get channel(): string;
  abstract get groupName(): string;
  abstract handle(event: DecodedEvent): Promise<void>;

  protected get consumerName(): string {
    return `${this.groupName}-${process.pid}`;
  }

  async start(): Promise<void> {
    await bootstrapSchema(this.pool);
    logger.info({ stream: this.channel, group: this.groupName }, "Schema ready");

    this.publisher = await makeRedisClient(this.redisUrl);
    this.consumer = await makeRedisClient(this.redisUrl);

    await this.ensureConsumerGroup(this.channel, this.groupName);

    this.running = true;
    this.readLoop();
    this.claimLoop();

    logger.info(
      { stream: this.channel, group: this.groupName, consumer: this.consumerName },
      "Processor listening on stream",
    );
  }

  stop(): void {
    this.running = false;
  }

  private async ensureConsumerGroup(stream: string, group: string): Promise<void> {
    try {
      await this.consumer.xGroupCreate(stream, group, "0", { MKSTREAM: true });
      logger.info({ stream, group }, "Consumer group created");
    } catch (err: any) {
      if (err?.message?.includes("BUSYGROUP")) {
        logger.debug({ stream, group }, "Consumer group already exists");
      } else {
        throw err;
      }
    }
  }

  private async readLoop(): Promise<void> {
    while (this.running) {
      try {
        const results = await this.consumer.xReadGroup(
          this.groupName,
          this.consumerName,
          [{ key: this.channel, id: ">" }],
          { COUNT: 10, BLOCK: BLOCK_TIMEOUT },
        );

        if (!results) continue;

        for (const { messages } of results) {
          for (const { id, message } of messages) {
            try {
              const event = JSON.parse(message.data, bigIntReviver) as DecodedEvent;
              await this.handle(event);
              await this.consumer.xAck(this.channel, this.groupName, id);
            } catch (err) {
              logger.error({ err, stream: this.channel, messageId: id }, "Handle error");
            }
          }
        }
      } catch (err) {
        logger.error({ err, stream: this.channel }, "Stream read error");
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  private async claimLoop(): Promise<void> {
    while (this.running) {
      await new Promise((r) => setTimeout(r, CLAIM_INTERVAL_MS));
      try {
        const pending = await this.consumer.xPending(this.channel, this.groupName);
        if (!pending || pending.pending === 0) continue;

        const stale = await this.consumer.xPendingRange(
          this.channel, this.groupName, "-", "+", 10,
        );

        for (const entry of stale) {
          if (entry.millisecondsSinceLastDelivery < CLAIM_IDLE_MS) continue;
          if (entry.deliveryCount > 5) {
            await this.consumer.xAck(this.channel, this.groupName, entry.id);
            logger.warn({ messageId: entry.id, deliveries: entry.deliveryCount }, "Dead-lettered message");
            continue;
          }
          const claimed = await this.consumer.xClaim(
            this.channel, this.groupName, this.consumerName, CLAIM_IDLE_MS, [entry.id],
          );
          if (claimed.length) {
            logger.debug({ messageId: entry.id }, "Claimed stale message");
          }
        }
      } catch { /* non-fatal */ }
    }
  }
}
