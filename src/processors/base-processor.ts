import type { Pool } from "pg";
import { makePool } from "../clients/postgres";
import { makeRedisClient, type RedisClient } from "../clients/redis";
import { bootstrapSchema } from "../utils/db/schema";
import { logger } from "../utils/logger";
import { bigIntReviver } from "../utils/math";
import { eventsProcessed, eventProcessingDuration, deadLetterTotal, errorsTotal } from "../utils/metrics";
import type { DecodedEvent } from "../types/events";


const BLOCK_TIMEOUT = 5000;
const CLAIM_IDLE_MS = 30_000;
const CLAIM_INTERVAL_MS = 10_000;
const MAX_DELIVERIES = 5;

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
    this.readLoop().catch((err) => { logger.fatal({ err, stream: this.channel }, "Read loop crashed"); process.exit(1); });
    this.claimLoop().catch((err) => {
      logger.error({ err, stream: this.channel }, "Claim loop crashed — restarting");
      if (this.running) this.claimLoop().catch(() => {});
    });

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

  /** Persist a failed message to Postgres dead-letter queue for later inspection/replay. */
  private async deadLetter(messageId: string, data: string, error: string, attempts: number): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO dead_letter_queue (stream, message_id, data, error, attempts)
         VALUES ($1, $2, $3::jsonb, $4, $5)`,
        [this.channel, messageId, data, error, attempts],
      );
      deadLetterTotal.inc({ stream: this.channel });
      logger.warn({ stream: this.channel, messageId, attempts }, "Message persisted to dead-letter queue");
    } catch (err) {
      logger.error({ err, messageId }, "Failed to write to dead-letter queue — message lost");
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
            let handled = false;
            const timerEnd = eventProcessingDuration.startTimer({ processor: this.groupName, event_type: "unknown" });
            let eventType = "unknown";
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                const event = JSON.parse(message.data, bigIntReviver) as DecodedEvent;
                eventType = event.eventType ?? "unknown";
                await this.handle(event);
                await this.consumer.xAck(this.channel, this.groupName, id);
                eventsProcessed.inc({ processor: this.groupName, event_type: eventType, status: "ok" });
                timerEnd({ processor: this.groupName, event_type: eventType });
                handled = true;
                break;
              } catch (err) {
                if (attempt === 3) {
                  logger.error({ err, stream: this.channel, messageId: id, attempt }, "Handle failed after retries");
                  eventsProcessed.inc({ processor: this.groupName, event_type: eventType, status: "error" });
                  errorsTotal.inc({ source: this.groupName, type: "handle_failed" });
                } else {
                  logger.warn({ stream: this.channel, messageId: id, attempt }, "Handle retry");
                  await new Promise((r) => setTimeout(r, 1000 * attempt));
                }
              }
            }
            if (!handled) {
              timerEnd({ processor: this.groupName, event_type: eventType });
              // Leave unacked — claimLoop will pick it up later or dead-letter after MAX_DELIVERIES
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
          if (entry.deliveriesCounter > MAX_DELIVERIES) {
            // Read the message data before ACK so we can persist it
            const messages = await this.consumer.xRange(this.channel, entry.id, entry.id);
            const data = messages[0]?.message?.data ?? "{}";
            const errMsg = `Exceeded ${MAX_DELIVERIES} delivery attempts`;

            await this.deadLetter(entry.id, data, errMsg, entry.deliveriesCounter);
            await this.consumer.xAck(this.channel, this.groupName, entry.id);
            continue;
          }
          const claimed = await this.consumer.xClaim(
            this.channel, this.groupName, this.consumerName, CLAIM_IDLE_MS, [entry.id],
          );
          if (claimed.length) {
            logger.debug({ messageId: entry.id }, "Claimed stale message");
          }
        }
      } catch (err) {
        logger.error({ err, stream: this.channel }, "Claim loop error");
      }
    }
  }
}
