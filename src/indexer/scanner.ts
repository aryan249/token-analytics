import {
    createPublicClient,
    webSocket,
    type Log,
    type Hash,
  } from "viem";
  import { base }             from "viem/chains";
  import type { Pool }        from "pg";
  import type { RedisClient } from "../clients/redis";
  
  import { STATIC_CONTRACT_SET, EARLIEST_DEPLOY_BLOCK } from "../contracts/contracts";
  import { WATCHED_TOPICS }                              from "../abis/abis";
  import { readCheckpoint, writeCheckpoint, insertBlockHeader } from "../utils/db/checkpoint";
  import { getAllTokenAddresses }from "../utils/db/tokens";
  import { EVENT_CHANNELS }   from "../clients/redis";
  import { detectAndRecover } from "./reorg";
  import { decodeLog } from "../utils/decoder";
  import type { RawLog, BlockHeader, DecodedEvent } from "../types/events";
  import { config } from "../config/config";
  import { logger } from "../utils/logger";
  
  // ── Helpers ───────────────────────────────────────────────────────────────────
  
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  
  async function withRetry<T>(fn: () => Promise<T>, label: string, maxAttempts = 5): Promise<T> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try { return await fn(); } catch (err) {
        if (attempt === maxAttempts) throw err;
        await sleep(Math.min(500 * 2 ** (attempt - 1) + Math.random() * 300, 30_000));
        logger.warn({ label, attempt, err }, "Retrying");
      }
    }
    throw new Error("unreachable");
  }
  
  interface PendingBlock {
    number:     bigint;
    hash:       Hash;
    parentHash: Hash;
    timestamp:  bigint;
  }
  
  // ── Scanner ───────────────────────────────────────────────────────────────────
  
  export class Scanner {
    private readonly client;
    private readonly pool:    Pool;
    private readonly redis:   RedisClient;
  
    private pendingBlocks:      Map<bigint, PendingBlock> = new Map();
    private latestBlock:        bigint = 0n;
    private knownTokens:        Set<string> = new Set();
    private blocksSinceRefresh  = 0;
    private readonly REFRESH_INTERVAL = 50;
  
    private running     = false;
    private unsubscribe: (() => void) | null = null;
  
    constructor(pool: Pool, redis: RedisClient) {
      this.client = createPublicClient({
        chain:     base,
        transport: webSocket(config.alchemyWsUrl, {
          timeout:    30_000,
          retryCount: 5,
          retryDelay: 2_000,
        }),
      });
      this.pool  = pool;
      this.redis = redis;
    }
  
  
    async start(): Promise<void> {
      this.running = true;
      await this.refreshKnownTokens();
  
      const startBlock  = await this.resolveStartBlock();
      const currentHead = await this.client.getBlockNumber();
  
      if (startBlock < currentHead) {
        await this.catchUp(startBlock, currentHead - BigInt(config.confirmationDepth));
      }
  
      logger.info({ startBlock: startBlock.toString() }, "Subscribing to newHeads");
  
      this.unsubscribe = await this.client.watchBlocks({
        onBlock: (block) => {
          void this.onNewHead({
            number:     block.number,
            hash:       block.hash,
            parentHash: block.parentHash,
            timestamp:  block.timestamp,
          });
        },
        onError: (err) => logger.error({ err }, "newHeads subscription error"),
      });
  
      logger.info("WebSocket subscription active");
    }
  
    stop(): void {
      this.running = false;
      this.unsubscribe?.();
      logger.info("Scanner stopped");
    }
  
    // ── New head ──────────────────────────────────────────────────────────────
  
    private async onNewHead(block: PendingBlock): Promise<void> {
      this.latestBlock = block.number;
      this.pendingBlocks.set(block.number, block);
      await this.drainConfirmedBlocks();
  
      this.blocksSinceRefresh++;
      if (this.blocksSinceRefresh >= this.REFRESH_INTERVAL) {
        await this.refreshKnownTokens();
        this.blocksSinceRefresh = 0;
      }
    }
  
    // ── Drain confirmed blocks ────────────────────────────────────────────────
  
    private async drainConfirmedBlocks(): Promise<void> {
      const depth = BigInt(config.confirmationDepth);
      const confirmed = [...this.pendingBlocks.entries()]
        .filter(([n]) => this.latestBlock - n >= depth)
        .sort(([a], [b]) => (a < b ? -1 : 1));
  
      for (const [, block] of confirmed) {
        try {
          await this.processConfirmedBlock(block);
          this.pendingBlocks.delete(block.number);
        } catch (err) {
          logger.error({ err, block: block.number.toString() }, "Error processing confirmed block");
        }
      }
    }
  
    // ── Process one confirmed block ───────────────────────────────────────────
  
    private async processConfirmedBlock(block: PendingBlock): Promise<void> {
      const header: BlockHeader = {
        blockNumber:    block.number,
        blockHash:      block.hash,
        parentHash:     block.parentHash,
        blockTimestamp: block.timestamp,
      };
  
      const reorg = await detectAndRecover(
        this.pool, header, config.chainId,
        (n) => this.fetchBlockHeader(n)
      );
  
      if (reorg.detected) return;
  
      const logs    = await this.fetchLogsForBlock(block.number, block.timestamp);
      const decoded = this.decodeLogs(logs);
      await this.publishToChannels(decoded);
  
      await insertBlockHeader(this.pool, header, config.chainId);
      await writeCheckpoint(this.pool, config.chainId, block.number, block.hash);
  
      logger.info(
        { block: block.number.toString(), decoded: decoded.length },
        "Block confirmed and published"
      );
    }
  
    // ── Decode + route ────────────────────────────────────────────────────────
  
    private decodeLogs(logs: RawLog[]): DecodedEvent[] {
      const events: DecodedEvent[] = [];
      for (const log of logs) {
        const e = decodeLog(log, config.chainId, this.knownTokens);
        if (e) events.push(e);
      }
      return events;
    }
  
    private async publishToChannels(events: DecodedEvent[]): Promise<void> {
      for (const event of events) {
        const channel = this.routeToChannel(event);
        if (!channel) continue;
        await this.redis.publish(channel, JSON.stringify(event, bigIntReplacer));
      }
    }
  
    private routeToChannel(event: DecodedEvent): string | null {
      switch (event.eventType) {
        case "PoolSwap":
          return EVENT_CHANNELS.swap;
        case "PoolFeesDistributed":
        case "FeesClaimed":
          return EVENT_CHANNELS.fees;
        case "PoolCreated":
        case "FairLaunchCreated":
        case "BidWallUpdated":
          return EVENT_CHANNELS.meta;
        case "ChainlinkAnswerUpdated":
          return EVENT_CHANNELS.price;
        default:
          return null;
      }
    }
  
    // ── Catch-up ──────────────────────────────────────────────────────────────
  
    private async catchUp(fromBlock: bigint, toBlock: bigint): Promise<void> {
      logger.info({ from: fromBlock.toString(), to: toBlock.toString() }, "Catching up");
      const BATCH = BigInt(config.batchSize);
  
      for (let start = fromBlock; start <= toBlock; start += BATCH) {
        const end = start + BATCH - 1n < toBlock ? start + BATCH - 1n : toBlock;
  
        for (let n = start; n <= end; n++) {
          const h = await this.fetchBlockHeader(n);
          await insertBlockHeader(this.pool, h, config.chainId);
        }
  
        const logs    = await this.fetchLogs(start, end, 0n);
        const decoded = this.decodeLogs(logs);
        await this.publishToChannels(decoded);
        await writeCheckpoint(this.pool, config.chainId, end, "0x" as Hash);
  
        logger.info({ from: start.toString(), to: end.toString() }, "Catch-up batch done");
      }
    }
  
    // ── Log fetching ──────────────────────────────────────────────────────────
  
    private async fetchLogsForBlock(blockNumber: bigint, timestamp: bigint): Promise<RawLog[]> {
      return this.fetchLogs(blockNumber, blockNumber, timestamp);
    }
  
    private async fetchLogs(fromBlock: bigint, toBlock: bigint, timestamp: bigint): Promise<RawLog[]> {
      const results: RawLog[] = [];
  
      const staticLogs = await withRetry(
        () => this.client.getLogs({
          fromBlock,
          toBlock,
          address: [...STATIC_CONTRACT_SET] as `0x${string}`[],
        }),
        "getLogs-static"
      );
      results.push(...staticLogs.map((l) => toRawLog(l, timestamp)));
  
      const tokenAddrs = [...this.knownTokens] as `0x${string}`[];
      for (let i = 0; i < tokenAddrs.length; i += 200) {
        const tokenLogs = await withRetry(
          () => this.client.getLogs({
            fromBlock,
            toBlock,
            address: tokenAddrs.slice(i, i + 200),
            event: {
              type:   "event",
              name:   "Transfer",
              inputs: [
                { name: "from",  type: "address", indexed: true },
                { name: "to",    type: "address", indexed: true },
                { name: "value", type: "uint256",  indexed: false },
              ],
            },
          }),
          `getLogs-tokens-${i}`
        );
        results.push(...tokenLogs.map((l) => toRawLog(l, timestamp)));
      }
  
      return results.filter(
        (l) => l.topics.length > 0 && WATCHED_TOPICS.has(l.topics[0] as `0x${string}`)
      );
    }
  
    // ── Helpers ───────────────────────────────────────────────────────────────
  
    private async fetchBlockHeader(blockNumber: bigint): Promise<BlockHeader> {
      const b = await withRetry(
        () => this.client.getBlock({ blockNumber, includeTransactions: false }),
        `getBlock-${blockNumber}`
      );
      return {
        blockNumber:    b.number,
        blockHash:      b.hash,
        parentHash:     b.parentHash,
        blockTimestamp: b.timestamp,
      };
    }
  
    private async resolveStartBlock(): Promise<bigint> {
      if (config.startBlock > 0n) {
        logger.info({ block: config.startBlock.toString() }, "Using START_BLOCK override");
        return config.startBlock;
      }
      const cp = await readCheckpoint(this.pool, config.chainId);
      if (cp && cp.lastFinalizedBlock > 0n) {
        logger.info({ block: (cp.lastFinalizedBlock + 1n).toString() }, "Resuming from checkpoint");
        return cp.lastFinalizedBlock + 1n;
      }
      logger.info({ block: EARLIEST_DEPLOY_BLOCK.toString() }, "Cold start");
      return EARLIEST_DEPLOY_BLOCK;
    }
  
    private async refreshKnownTokens(): Promise<void> {
      const addrs = await getAllTokenAddresses(this.pool);
      this.knownTokens = new Set(addrs);
      logger.debug({ count: this.knownTokens.size }, "Known tokens refreshed");
    }
  }
  
  // ── Module helpers ────────────────────────────────────────────────────────────
  
  function toRawLog(log: Log, blockTimestamp: bigint): RawLog {
    return {
      address:         log.address.toLowerCase(),
      topics:          log.topics as string[],
      data:            log.data,
      blockNumber:     log.blockNumber!,
      blockHash:       log.blockHash as Hash,
      transactionHash: log.transactionHash as Hash,
      logIndex:        log.logIndex!,
      blockTimestamp,
    };
  }
  
  function bigIntReplacer(_k: string, v: unknown): unknown {
    return typeof v === "bigint" ? v.toString() + "n" : v;
  }