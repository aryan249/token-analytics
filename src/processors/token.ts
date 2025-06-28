import "dotenv/config";
import { createPublicClient, http, type Address } from "viem";
import { base }                                   from "viem/chains";
import { registerToken, upsertRoyaltyMembers }    from "../utils/db/tokens";
import { EVENT_CHANNELS, PUBSUB_CHANNELS }        from "../clients/redis";
import { ERC20_METADATA_ABI }                     from "../abis/abis";
import { BaseProcessor }                          from "./base-processor";
import { logger }                                 from "../utils/logger";
import type { DecodedEvent, PoolCreatedEvent, ManagerInitializedFeeSplitEvent } from "../types/events";

const rpcUrl = (process.env.ALCHEMY_WS_URL ?? "").replace(/^wss?:\/\//, "https://");
const rpcClient = createPublicClient({ chain: base, transport: http(rpcUrl) });

const MAX_RPC_RETRIES = 3;
const RPC_RETRY_DELAY = 2000;

async function fetchTokenMetadata(
  tokenAddress: Address,
): Promise<{ name: string | null; symbol: string | null; totalSupply: bigint | null }> {
  for (let attempt = 1; attempt <= MAX_RPC_RETRIES; attempt++) {
    try {
      const [name, symbol, totalSupply] = await Promise.all([
        rpcClient.readContract({ address: tokenAddress, abi: ERC20_METADATA_ABI, functionName: "name" }),
        rpcClient.readContract({ address: tokenAddress, abi: ERC20_METADATA_ABI, functionName: "symbol" }),
        rpcClient.readContract({ address: tokenAddress, abi: ERC20_METADATA_ABI, functionName: "totalSupply" }),
      ]);
      return { name: name as string, symbol: symbol as string, totalSupply: totalSupply as bigint };
    } catch (err) {
      if (attempt === MAX_RPC_RETRIES) {
        logger.warn({ err, token: tokenAddress, attempts: attempt }, "Could not fetch token metadata after retries");
        return { name: null, symbol: null, totalSupply: null };
      }
      logger.debug({ token: tokenAddress, attempt }, "RPC retry for token metadata");
      await new Promise((r) => setTimeout(r, RPC_RETRY_DELAY * attempt));
    }
  }
  return { name: null, symbol: null, totalSupply: null };
}

class TokenProcessor extends BaseProcessor {
  get channel() { return EVENT_CHANNELS.meta; }
  get groupName() { return "token-processor"; }

  // txHash → tokenAddress for royalty linking (same transaction)
  private recentTxTokens = new Map<string, string>();

  async handle(event: DecodedEvent): Promise<void> {
    if (event.eventType === "PoolCreated") {
      const e = event as PoolCreatedEvent;

      let name   = e.name   || null;
      let symbol = e.symbol || null;
      let totalSupply: bigint | null = null;

      if (!name || !symbol) {
        const meta = await fetchTokenMetadata(e.tokenAddress);
        name        = name   ?? meta.name;
        symbol      = symbol ?? meta.symbol;
        totalSupply = meta.totalSupply;
      } else {
        const meta = await fetchTokenMetadata(e.tokenAddress);
        totalSupply = meta.totalSupply;
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
        totalSupply:     totalSupply ?? undefined,
      });

      // Publish resolved metadata so the WS gateway can update its tokenMetaMap
      // (totalSupply is fetched via RPC, not present in the original PoolCreated event)
      const metaMsg = JSON.stringify({
        eventType:   "TokenMetaUpdated",
        tokenAddress: e.tokenAddress,
        name,
        symbol,
        totalSupply:  totalSupply != null ? totalSupply.toString() + "n" : null,
      });
      await Promise.all([
        this.publisher.xAdd(EVENT_CHANNELS.meta, "*", { data: metaMsg }),
        this.publisher.publish(PUBSUB_CHANNELS.meta, metaMsg),
      ]);

      // Cache txHash so ManagerInitializedFeeSplit (same tx) can link to this token
      this.recentTxTokens.set(e.transactionHash, e.tokenAddress.toLowerCase());
      if (this.recentTxTokens.size > 1000) {
        // Evict oldest entry
        this.recentTxTokens.delete(this.recentTxTokens.keys().next().value!);
      }

      logger.info(
        { token: e.tokenAddress, name, symbol, creator: e.creator, pmVersion: e.pmVersion },
        "Token registered"
      );
      return;
    }

    if (event.eventType === "ManagerInitializedFeeSplit") {
      const e = event as ManagerInitializedFeeSplitEvent;
      if (!e.recipientShares.length) return;

      const tokenAddress = this.recentTxTokens.get(e.transactionHash);
      if (!tokenAddress) {
        logger.warn(
          { tx: e.transactionHash, manager: e.contractAddress },
          "ManagerInitializedFeeSplit: no matching PoolCreated in same tx — fee split manager was set after token creation; royalty_members not updated"
        );
        return;
      }

      await upsertRoyaltyMembers(this.pool, tokenAddress, e.recipientShares);
      logger.info(
        { token: tokenAddress, members: e.recipientShares.length },
        "Royalty members stored"
      );
    }
  }
}

new TokenProcessor(
  process.env.REDIS_URL    ?? "redis://localhost:6379",
  process.env.POSTGRES_URL!
).start().catch((err) => { console.error("Fatal:", err); process.exit(1); });
