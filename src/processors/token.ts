// src/processors/token.ts

import "dotenv/config";
import { createPublicClient, http, type Address } from "viem";
import { base }                                   from "viem/chains";
import { registerToken }                          from "../utils/db/tokens";
import { EVENT_CHANNELS }                         from "../clients/redis";
import { ERC20_METADATA_ABI }                     from "../abis/abis";
import { BaseProcessor }                          from "./base-processor";
import { logger }                                 from "../utils/logger";
import type { DecodedEvent, PoolCreatedEvent }    from "../types/events";

const rpcUrl = (process.env.ALCHEMY_WS_URL ?? "").replace(/^wss?:\/\//, "https://");
const rpcClient = createPublicClient({ chain: base, transport: http(rpcUrl) });

async function fetchTokenMetadata(
  tokenAddress: Address,
): Promise<{ name: string | null; symbol: string | null }> {
  try {
    const [name, symbol] = await Promise.all([
      rpcClient.readContract({ address: tokenAddress, abi: ERC20_METADATA_ABI, functionName: "name" }),
      rpcClient.readContract({ address: tokenAddress, abi: ERC20_METADATA_ABI, functionName: "symbol" }),
    ]);
    return { name: name as string, symbol: symbol as string };
  } catch (err) {
    logger.warn({ err, token: tokenAddress }, "Could not fetch token metadata");
    return { name: null, symbol: null };
  }
}

class TokenProcessor extends BaseProcessor {
  get channel() { return EVENT_CHANNELS.meta; }

  async handle(event: DecodedEvent): Promise<void> {
    if (event.eventType !== "PoolCreated") return;
    const e = event as PoolCreatedEvent;

    // Use name/symbol from event params for v1/v1.1 PMs; fallback to on-chain call for AnyPM
    let name   = e.name   || null;
    let symbol = e.symbol || null;

    if (!name || !symbol) {
      const meta = await fetchTokenMetadata(e.tokenAddress);
      name   = name   ?? meta.name;
      symbol = symbol ?? meta.symbol;
    }

    await registerToken(this.pool, {
      tokenAddress:    e.tokenAddress,
      poolId:          e.poolId,
      creator:         e.creator,
      nftId:           e.tokenId,
      pmAddress:       e.contractAddress,
      discoveredBlock: e.blockNumber,
      name,
      symbol,
    });

    logger.info(
      { token: e.tokenAddress, name, symbol, creator: e.creator, pmVersion: e.pmVersion },
      "Token registered"
    );
  }
}

new TokenProcessor(
  process.env.REDIS_URL    ?? "redis://localhost:6379",
  process.env.POSTGRES_URL!
).start().catch((err) => { console.error("Fatal:", err); process.exit(1); });
