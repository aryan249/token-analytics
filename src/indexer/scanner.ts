import {
    createPublicClient,
    webSocket,
    http,
    parseAbiItem,
    type Log,
    type Hash,
  } from "viem";
  import { base }             from "viem/chains";
  import type { Pool }        from "pg";
  import type { RedisClient } from "../clients/redis";

  import { STATIC_CONTRACT_SET, EARLIEST_DEPLOY_BLOCK } from "../contracts/contracts";
  import { WATCHED_TOPICS }                              from "../abis/abis";
  import { readCheckpoint, writeCheckpoint, insertBlockHeader } from "../utils/db/checkpoint";
  import { getAllTokenAddresses, getAllPoolMappings } from "../utils/db/tokens";
  import { EVENT_CHANNELS, UI_STREAMS, PUBSUB_CHANNELS, STREAM_MAX_LEN } from "../clients/redis";
  import { detectAndRecover } from "./reorg";
  import { decodeLog }        from "../utils/decoder";
  import type { RawLog, BlockHeader, DecodedEvent, ManagerDeployedEvent, PoolCreatedEvent } from "../types/events";
  import { config }           from "../config/config";
  import { logger }           from "../utils/logger";
  import { getBucketTime, ALL_RESOLUTIONS } from "../utils/math";
  import type { PoolSwapEvent, CandleResolution } from "../types/events";

  // Parsed ABI event used for topic-only getLogs (no address filter)
  const MANAGER_INITIALIZED_FEE_SPLIT_EVENT = parseAbiItem(
    "event ManagerInitialized(address _owner, (uint256 creatorShare, uint256 ownerShare, (address recipient, uint256 share)[] recipientShares) _params)"
  );

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
    private readonly client;     // WS — used only for watchBlocks
    private readonly httpClient; // HTTP — used for getLogs (WS silently breaks on address arrays)
    private readonly pool:  Pool;
    private readonly redisClients: RedisClient[];

    private pendingBlocks:     Map<bigint, PendingBlock> = new Map();
    private knownTokens:       Set<string> = new Set();
    private poolIdToToken:     Map<string, string> = new Map();
    private dynamicManagers:   Set<string> = new Set();
    private blocksSinceRefresh = 0;
    private readonly REFRESH_INTERVAL = 50;

    private unsubscribe: (() => void) | null = null;

    constructor(pool: Pool, redisClients: RedisClient[]) {
      const httpUrl = config.alchemyWsUrl.replace(/^wss?:\/\//, "https://");
      this.client = createPublicClient({
        chain:     base,
        transport: webSocket(config.alchemyWsUrl, {
          timeout:    30_000,
          retryCount: 5,
          retryDelay: 2_000,
        }),
      });
      this.httpClient = createPublicClient({ chain: base, transport: http(httpUrl) });
      this.pool  = pool;
      this.redisClients = redisClients;
    }

    async start(): Promise<void> {
      await this.refreshKnownState();

      // Verify recent blocks are in Redis — replay any gaps from Redis crash
      await this.verifyAndReplayGaps();

      const startBlock  = await this.resolveStartBlock();
      const currentHead = await this.client.getBlockNumber();

      if (startBlock < currentHead) {
        await this.catchUp(startBlock, currentHead);
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

      // Signal readiness + liveness to K8s probes via /tmp files
      const fs = await import("fs");
      fs.writeFileSync("/tmp/indexer-ready", "");
      setInterval(() => { try { fs.writeFileSync("/tmp/indexer-alive", ""); } catch {} }, 30_000);
      fs.writeFileSync("/tmp/indexer-alive", "");

      logger.info("WebSocket subscription active");
    }

    stop(): void {
      this.unsubscribe?.();
      logger.info("Scanner stopped");
    }

    // ── New head ──────────────────────────────────────────────────────────────

    private async onNewHead(block: PendingBlock): Promise<void> {
      this.pendingBlocks.set(block.number, block);

      // Cap pending blocks to prevent memory leak on deep reorgs
      if (this.pendingBlocks.size > 100) {
        const oldest = [...this.pendingBlocks.keys()].sort((a, b) => (a < b ? -1 : 1))[0];
        this.pendingBlocks.delete(oldest);
        logger.warn({ dropped: oldest.toString(), size: this.pendingBlocks.size }, "Dropped old pending block");
      }

      await this.drainPendingBlocks();

      this.blocksSinceRefresh++;
      if (this.blocksSinceRefresh >= this.REFRESH_INTERVAL) {
        await this.refreshKnownState();
        this.blocksSinceRefresh = 0;
      }
    }

    // ── Drain pending blocks (process immediately — reorgs handled by detectAndRecover)

    private async drainPendingBlocks(): Promise<void> {
      const ready = [...this.pendingBlocks.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1));

      for (const [, block] of ready) {
        try {
          await this.processConfirmedBlock(block);
          this.pendingBlocks.delete(block.number);
        } catch (err) {
          logger.error({ err, block: block.number.toString() }, "Error processing block");
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

      const tokensBefore = new Set(this.knownTokens);
      let logs      = await this.fetchLogsForBlock(block.number, block.timestamp);
      const firstPass = this.decodeLogs(logs);
      this.updateDynamicManagers(firstPass);
      this.updatePoolMappings(firstPass);

      // Re-fetch logs for newly discovered tokens to pick up their ERC20 Transfers
      const newTokens = [...this.knownTokens].filter((t) => !tokensBefore.has(t));
      if (newTokens.length > 0) {
        const tsMap = new Map([[block.number, block.timestamp]]);
        const extra = await this.fetchLogsForAddresses(block.number, block.number, tsMap, newTokens);
        if (extra.length > 0) {
          const seen = new Set(logs.map((l) => `${l.blockNumber}:${l.logIndex}`));
          for (const l of extra) {
            const key = `${l.blockNumber}:${l.logIndex}`;
            if (!seen.has(key)) { seen.add(key); logs.push(l); }
          }
          logs.sort((a, b) => a.logIndex - b.logIndex);
        }
      }

      const decoded   = this.decodeLogs(logs);
      const publishedIds = await this.publishToChannels(decoded);

      // Record what was published for gap detection on restart
      await this.recordPublishLedger(block.number, publishedIds);

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
        const e = decodeLog(log, config.chainId, this.poolIdToToken, this.dynamicManagers, this.knownTokens);
        if (e) events.push(e);
      }
      return events;
    }

    /** When ManagerDeployed is decoded, add the new manager to the dynamic set. */
    private updateDynamicManagers(events: DecodedEvent[]): void {
      for (const e of events) {
        if (e.eventType === "ManagerDeployed") {
          const m = (e as ManagerDeployedEvent).manager.toLowerCase();
          if (!this.dynamicManagers.has(m)) {
            if (this.dynamicManagers.size >= 50_000) {
              logger.warn({ size: this.dynamicManagers.size }, "Dynamic managers cap reached, skipping");
              continue;
            }
            this.dynamicManagers.add(m);
            logger.info({ manager: m }, "Dynamic manager discovered");
          }
        }
      }
    }

    /** When PoolCreated is decoded, immediately update poolIdToToken so subsequent
     *  swaps in the same or next batch resolve the token address correctly. */
    private updatePoolMappings(events: DecodedEvent[]): void {
      for (const e of events) {
        if (e.eventType === "PoolCreated") {
          const ev = e as PoolCreatedEvent;
          const poolId = ev.poolId.toLowerCase();
          const token  = ev.tokenAddress.toLowerCase();
          if (!this.poolIdToToken.has(poolId)) {
            this.poolIdToToken.set(poolId, token);
            this.knownTokens.add(token);
            logger.info({ poolId, token }, "Pool mapping discovered inline");
          }
        }
      }
    }

    /** Publish events to Redis streams + Pub/Sub. Returns stream IDs per stream (from primary Redis). */
    private async publishToChannels(events: DecodedEvent[]): Promise<Map<string, string[]>> {
      const streamCmds: { stream: string; data: string }[] = [];
      const pubsubCmds: { channel: string; data: string }[] = [];

      for (const event of events) {
        const stream = this.routeToChannel(event);
        if (!stream) continue;
        streamCmds.push({ stream, data: JSON.stringify(event, bigIntReplacer) });

        // Fast-path: publish candle tips directly for PoolSwap events.
        if (event.eventType === "PoolSwap") {
          const e = event as PoolSwapEvent;
          if (e.tokenAddress && e.priceEth !== 0n) {
            for (const resolution of ALL_RESOLUTIONS) {
              const bucketTime = getBucketTime(e.blockTimestamp, resolution as CandleResolution);
              const data = JSON.stringify({
                type:         "candle",
                tokenAddress: e.tokenAddress,
                resolution,
                bucketTime:   bucketTime.toString(),
                closeEth:     e.priceEth.toString(),
                volumeEth:    e.volumeEth.toString(),
              });
              streamCmds.push({ stream: UI_STREAMS.candles, data });
              pubsubCmds.push({ channel: PUBSUB_CHANNELS.candles, data });
            }
          }
        }

        // Fan-out meta events (PoolCreated, etc.) so all gateway pods see new tokens
        if (stream === EVENT_CHANNELS.meta) {
          pubsubCmds.push({ channel: PUBSUB_CHANNELS.meta, data: JSON.stringify(event, bigIntReplacer) });
        }
      }

      const idsByStream = new Map<string, string[]>();
      if (streamCmds.length === 0) return idsByStream;

      // Pipeline all xAdds + publishes into one round trip per Redis instance
      const trimOpts = { TRIM: { strategy: "MAXLEN" as const, strategyModifier: "~" as const, threshold: STREAM_MAX_LEN } };
      const results = await Promise.all(
        this.redisClients.map(redis => {
          const pipeline = redis.multi();
          for (const cmd of streamCmds) {
            pipeline.xAdd(cmd.stream, "*", { data: cmd.data }, trimOpts);
          }
          for (const cmd of pubsubCmds) {
            pipeline.publish(cmd.channel, cmd.data);
          }
          return pipeline.exec();
        })
      );

      // Extract stream IDs from primary Redis (first client) response
      if (results[0]) {
        const primaryResults = results[0] as unknown[];
        for (let i = 0; i < streamCmds.length; i++) {
          const streamId = primaryResults[i] as string | null;
          if (streamId) {
            const ids = idsByStream.get(streamCmds[i].stream) ?? [];
            ids.push(streamId);
            idsByStream.set(streamCmds[i].stream, ids);
          }
        }
      }

      return idsByStream;
    }

    private routeToChannel(event: DecodedEvent): string | null {
      switch (event.eventType) {
        case "PoolSwap":
        case "PoolStateUpdated":
          return EVENT_CHANNELS.swap;
        case "PoolFeesDistributed":
        case "FeeEscrowDeposit":
        case "FeeEscrowWithdrawal":
          return EVENT_CHANNELS.fees;
        case "PoolCreated":
        case "FairLaunchCreated":
        case "FairLaunchEnded":
        case "ManagerDeployed":
        case "ManagerInitializedFeeSplit":
          return EVENT_CHANNELS.meta;
        case "ChainlinkAnswerUpdated":
          return EVENT_CHANNELS.price;
        case "ERC20Transfer":
          return EVENT_CHANNELS.transfer;
        default:
          return null;
      }
    }

    // ── Catch-up ──────────────────────────────────────────────────────────────

    private async catchUp(fromBlock: bigint, toBlock: bigint): Promise<void> {
      logger.info({ from: fromBlock.toString(), to: toBlock.toString() }, "Catching up");
      const BATCH = BigInt(config.batchSize);

      // Max concurrent RPC requests for block headers during catch-up
      const HEADER_CONCURRENCY = 10;

      for (let start = fromBlock; start <= toBlock; start += BATCH) {
        const end = start + BATCH - 1n < toBlock ? start + BATCH - 1n : toBlock;

        // Fetch block headers in parallel (capped concurrency to avoid rate limits)
        const timestampMap = new Map<bigint, bigint>();
        const blockNumbers: bigint[] = [];
        for (let n = start; n <= end; n++) blockNumbers.push(n);

        for (let i = 0; i < blockNumbers.length; i += HEADER_CONCURRENCY) {
          const chunk = blockNumbers.slice(i, i + HEADER_CONCURRENCY);
          const headers = await Promise.all(chunk.map(n => this.fetchBlockHeader(n)));
          await Promise.all(headers.map(h => insertBlockHeader(this.pool, h, config.chainId)));
          for (const h of headers) timestampMap.set(h.blockNumber, h.blockTimestamp);
        }

        const tokensBefore = new Set(this.knownTokens);
        const logs = await this.fetchLogsWithTimestamps(start, end, timestampMap);
        // First pass: extract pool/manager mappings so swaps in the same batch resolve correctly
        const firstPass = this.decodeLogs(logs);
        this.updateDynamicManagers(firstPass);
        this.updatePoolMappings(firstPass);

        // If new tokens were discovered in this batch, re-fetch logs to pick up
        // their ERC20 Transfer events (weren't in the address filter initially)
        const newTokens = [...this.knownTokens].filter((t) => !tokensBefore.has(t));
        let allLogs = logs;
        if (newTokens.length > 0) {
          const extraLogs = await this.fetchLogsForAddresses(start, end, timestampMap, newTokens);
          if (extraLogs.length > 0) {
            const seen = new Set(allLogs.map((l) => `${l.blockNumber}:${l.logIndex}`));
            for (const l of extraLogs) {
              const key = `${l.blockNumber}:${l.logIndex}`;
              if (!seen.has(key)) { seen.add(key); allLogs.push(l); }
            }
            allLogs.sort((a, b) => a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : a.logIndex - b.logIndex);
          }
        }

        // Second pass: re-decode with updated mappings (fixes null tokenAddress on same-batch swaps)
        const decoded = this.decodeLogs(allLogs);
        const publishedIds = await this.publishToChannels(decoded);
        await this.recordPublishLedger(end, publishedIds);
        await writeCheckpoint(this.pool, config.chainId, end, "0x" as Hash);

        logger.info({ from: start.toString(), to: end.toString() }, "Catch-up batch done");
      }
    }

    // ── Log fetching ──────────────────────────────────────────────────────────

    private async fetchLogsForBlock(blockNumber: bigint, timestamp: bigint): Promise<RawLog[]> {
      return this.fetchLogsWithTimestamps(blockNumber, blockNumber, new Map([[blockNumber, timestamp]]));
    }

    private async fetchLogsWithTimestamps(
      fromBlock:    bigint,
      toBlock:      bigint,
      timestampMap: Map<bigint, bigint>,
    ): Promise<RawLog[]> {
      const addresses = [
        ...STATIC_CONTRACT_SET,
        ...this.dynamicManagers,
        ...this.knownTokens,   // ERC-20 token contracts for Transfer event tracking
      ] as `0x${string}`[];

      // Alchemy Free tier: max 10 blocks per eth_getLogs request.
      const LOGS_CHUNK = 10n;
      const allKnownLogs:      Awaited<ReturnType<typeof this.httpClient.getLogs>> = [];
      const allManagerInitLogs: Awaited<ReturnType<typeof this.httpClient.getLogs>> = [];

      for (let chunkStart = fromBlock; chunkStart <= toBlock; chunkStart += LOGS_CHUNK) {
        const chunkEnd = chunkStart + LOGS_CHUNK - 1n < toBlock ? chunkStart + LOGS_CHUNK - 1n : toBlock;

        const [knownChunk, managerInitChunk] = await Promise.all([
          withRetry(
            () => this.httpClient.getLogs({ fromBlock: chunkStart, toBlock: chunkEnd, address: addresses }),
            `getLogs-known-${chunkStart}`
          ),
          // Secondary fetch: ManagerInitializedFeeSplit by topic only (no address filter).
          // Required because the manager contract is deployed + initialized in the SAME tx
          // as ManagerDeployed, so its address isn't in dynamicManagers yet when we fetch.
          withRetry(
            () => this.httpClient.getLogs({
              fromBlock: chunkStart, toBlock: chunkEnd,
              event: MANAGER_INITIALIZED_FEE_SPLIT_EVENT,
            }),
            `getLogs-manager-init-${chunkStart}`
          ),
        ]);

        allKnownLogs.push(...knownChunk);
        allManagerInitLogs.push(...managerInitChunk);
      }

      // Merge, dedup by blockNumber+logIndex (manager init logs may overlap with known logs)
      const seen = new Set(allKnownLogs.map((l) => `${l.blockNumber}:${l.logIndex}`));
      const merged = [...allKnownLogs];
      for (const l of allManagerInitLogs) {
        const key = `${l.blockNumber}:${l.logIndex}`;
        if (!seen.has(key)) { seen.add(key); merged.push(l); }
      }

      return merged
        .map((l) => toRawLog(l, timestampMap.get(l.blockNumber!) ?? 0n))
        .filter((l) => l.topics.length > 0 && WATCHED_TOPICS.has(l.topics[0] as `0x${string}`));
    }

    private async fetchLogsForAddresses(
      fromBlock:    bigint,
      toBlock:      bigint,
      timestampMap: Map<bigint, bigint>,
      addresses:    string[],
    ): Promise<RawLog[]> {
      const LOGS_CHUNK = 10n;
      const allLogs: Awaited<ReturnType<typeof this.httpClient.getLogs>> = [];
      for (let chunkStart = fromBlock; chunkStart <= toBlock; chunkStart += LOGS_CHUNK) {
        const chunkEnd = chunkStart + LOGS_CHUNK - 1n < toBlock ? chunkStart + LOGS_CHUNK - 1n : toBlock;
        const chunk = await withRetry(
          () => this.httpClient.getLogs({
            fromBlock: chunkStart, toBlock: chunkEnd,
            address: addresses as `0x${string}`[],
          }),
          `getLogs-new-tokens-${chunkStart}`
        );
        allLogs.push(...chunk);
      }
      return allLogs
        .map((l) => toRawLog(l, timestampMap.get(l.blockNumber!) ?? 0n))
        .filter((l) => l.topics.length > 0 && WATCHED_TOPICS.has(l.topics[0] as `0x${string}`));
    }

    // ── Publish ledger + gap verification ──────────────────────────────────

    /** Record which stream IDs were published for a block — used for gap detection. */
    private async recordPublishLedger(blockNumber: bigint, idsByStream: Map<string, string[]>): Promise<void> {
      for (const [stream, ids] of idsByStream) {
        await this.pool.query(
          `INSERT INTO publish_ledger (block_number, stream, event_count, stream_ids)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (block_number, stream) DO UPDATE SET
             event_count = $3, stream_ids = $4, published_at = NOW()`,
          [blockNumber.toString(), stream, ids.length, ids],
        );
      }
    }

    /**
     * On startup, verify that the last REPLAY_DEPTH blocks' events still exist in Redis.
     * If any are missing (Redis crashed), re-fetch and re-publish those blocks.
     * Safe because all processor writes are idempotent (ON CONFLICT).
     */
    private async verifyAndReplayGaps(): Promise<void> {
      const REPLAY_DEPTH = 100; // check last 100 blocks
      const cp = await readCheckpoint(this.pool, config.chainId);
      if (!cp || cp.lastFinalizedBlock <= 0n) return;

      const fromBlock = cp.lastFinalizedBlock - BigInt(REPLAY_DEPTH);
      if (fromBlock <= 0n) return;

      // Get ledger entries for recent blocks
      const ledger = await this.pool.query<{
        block_number: string; stream: string; event_count: number; stream_ids: string[];
      }>(
        `SELECT block_number, stream, event_count, stream_ids
         FROM publish_ledger WHERE block_number > $1
         ORDER BY block_number ASC`,
        [fromBlock.toString()],
      );

      if (ledger.rows.length === 0) return;

      // Check if the stream IDs still exist in Redis (spot-check first and last per stream)
      const primaryRedis = this.redisClients[0];
      const missingBlocks = new Set<bigint>();

      for (const row of ledger.rows) {
        if (row.stream_ids.length === 0) continue;
        // Spot-check: verify the last stream ID for this block+stream exists
        const lastId = row.stream_ids[row.stream_ids.length - 1];
        try {
          const found = await primaryRedis.xRange(row.stream, lastId, lastId);
          if (found.length === 0) {
            missingBlocks.add(BigInt(row.block_number));
          }
        } catch {
          // Stream might not exist at all — block is definitely missing
          missingBlocks.add(BigInt(row.block_number));
        }
      }

      if (missingBlocks.size === 0) {
        logger.info({ checked: ledger.rows.length }, "Publish ledger verified — no gaps");
        return;
      }

      logger.warn({ missingBlocks: missingBlocks.size }, "Detected missing events in Redis — replaying");

      // Re-fetch and re-publish missing blocks
      for (const blockNum of [...missingBlocks].sort((a, b) => (a < b ? -1 : 1))) {
        try {
          const header = await this.fetchBlockHeader(blockNum);
          const logs = await this.fetchLogsForBlock(blockNum, header.blockTimestamp);
          const decoded = this.decodeLogs(logs);
          const ids = await this.publishToChannels(decoded);
          await this.recordPublishLedger(blockNum, ids);
          logger.info({ block: blockNum.toString(), events: decoded.length }, "Replayed missing block");
        } catch (err) {
          logger.error({ err, block: blockNum.toString() }, "Failed to replay block — will retry next startup");
        }
      }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private async fetchBlockHeader(blockNumber: bigint): Promise<BlockHeader> {
      const b = await withRetry(
        () => this.httpClient.getBlock({ blockNumber, includeTransactions: false }),
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

    private async refreshKnownState(): Promise<void> {
      const [addrs, poolMap] = await Promise.all([
        getAllTokenAddresses(this.pool),
        getAllPoolMappings(this.pool),
      ]);
      this.knownTokens   = new Set(addrs);
      this.poolIdToToken = poolMap;
      logger.debug(
        { tokens: this.knownTokens.size, pools: this.poolIdToToken.size },
        "Known state refreshed"
      );
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
