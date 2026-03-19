import "dotenv/config";
import { EVENT_CHANNELS, setEthUsdRate } from "../clients/redis";
import { BaseProcessor }                                   from "./base-processor";
import { logger }                                          from "../utils/logger";
import type { DecodedEvent, ChainlinkAnswerUpdatedEvent }  from "../types/events";

class PriceProcessor extends BaseProcessor {
  get channel() { return EVENT_CHANNELS.price; }

  async handle(event: DecodedEvent): Promise<void> {
    if (event.eventType !== "ChainlinkAnswerUpdated") return;
    const e = event as ChainlinkAnswerUpdatedEvent;

    // current has 8 decimals — e.g. 300000000000 = $3000.00000000
    await setEthUsdRate(this.publisher, e.current);

    // Human readable: divide by 1e8
    const usd = Number(e.current) / 1e8;
    logger.info({ rate: `$${usd.toFixed(2)}`, raw: e.current.toString() }, "ETH/USD rate updated");
  }
}

new PriceProcessor(
  process.env.REDIS_URL    ?? "redis://localhost:6379",
  process.env.POSTGRES_URL!
).start().catch((err) => { console.error("Fatal:", err); process.exit(1); });