import "dotenv/config";
import { insertTrade }               from "../utils/db/trades";
import { EVENT_CHANNELS, publishTokenUpdate, getEthUsdRate, KEYS, makeRedisClient, type RedisClient } from "../clients/redis";
import { invalidate }                from "../api/cache";
import { BaseProcessor }             from "./base-processor";
import { ethPriceToUsd, bigIntReviver } from "../utils/math";
import { upsertPoolState, getPoolLiquidityEth } from "../utils/db/pool-state";
import { logger }                    from "../utils/logger";
import type { DecodedEvent, PoolSwapEvent, PoolStateUpdatedEvent, ERC20TransferEvent } from "../types/events";

const ZERO = "0x0000000000000000000000000000000000000000";
const TRANSFER_GROUP = "trade-transfer-reader";


class TradeProcessor extends BaseProcessor {
  get channel() { return EVENT_CHANNELS.swap; }
  get groupName() { return "trade-processor"; }

  private readonly makerCache = new Map<string, { from: string; to: string }>();
  private readonly pendingPoolState = new Map<string, PoolStateUpdatedEvent>();

  private transferReader!: RedisClient;

  async start(): Promise<void> {
    await super.start();
    this.transferReader = await makeRedisClient(this.redisUrl);
    const stream = EVENT_CHANNELS.transfer;
    try {
      await this.transferReader.xGroupCreate(stream, TRANSFER_GROUP, "0", { MKSTREAM: true });
    } catch (err: any) {
      if (!err?.message?.includes("BUSYGROUP")) throw err;
    }

    // Periodically flush buffered PoolStateUpdated events
    setInterval(() => {
      this.flushPendingPoolState().catch((err) => logger.debug({ err }, 'Flush pending pool state error'));
    }, 5_000);
  }

  private async drainTransfers(): Promise<void> {
    const stream = EVENT_CHANNELS.transfer;
    const consumer = `${TRANSFER_GROUP}-${process.pid}`;
    try {
      const results = await this.transferReader.xReadGroup(
        TRANSFER_GROUP, consumer,
        [{ key: stream, id: ">" }],
        { COUNT: 100, BLOCK: 100 },
      );
      if (!results) return;
      for (const { messages } of results) {
        for (const { id, message } of messages) {
          try {
            const e = JSON.parse(message.data, bigIntReviver) as ERC20TransferEvent;
            if (e.eventType === "ERC20Transfer") {
              const from = e.from.toLowerCase();
              const to   = e.to.toLowerCase();
              if (from !== ZERO && to !== ZERO) {
                this.makerCache.set(e.transactionHash.toLowerCase(), { from, to });
                if (this.makerCache.size > 2000) {
                  this.makerCache.delete(this.makerCache.keys().next().value!);
                }
              }
            }
          } catch (err) { logger.debug({ err }, "Ignored error"); }
          await this.transferReader.xAck(stream, TRANSFER_GROUP, id);
        }
      }
    } catch (err) { logger.debug({ err }, "Non-fatal error"); }
  }

  private async applyPoolState(e: PoolStateUpdatedEvent): Promise<boolean> {
    const res = await this.pool.query<{ token_address: string }>(
      `SELECT token_address FROM token_registry WHERE pool_id = $1 LIMIT 1`,
      [e.poolId.toLowerCase()]
    );
    if (!res.rows[0]) return false;

    const tokenAddress = res.rows[0].token_address;
    await upsertPoolState(
      this.pool,
      e.poolId,
      tokenAddress,
      e.liquidity,
      e.sqrtPriceX96,
      e.blockNumber,
    );
    // Store initial price on the first PoolStateUpdated (only if not yet set)
    if (e.sqrtPriceX96 > 0n) {
      const TWO_192 = 2n ** 192n;
      const WAD = 10n ** 18n;
      const initialPriceEth = TWO_192 * WAD / (e.sqrtPriceX96 * e.sqrtPriceX96);
      await this.pool.query(
        `UPDATE token_registry SET initial_price_eth = $1
         WHERE token_address = $2 AND initial_price_eth IS NULL`,
        [initialPriceEth.toString(), tokenAddress],
      );
    }
    return true;
  }

  /** Flush buffered PoolStateUpdated events whose tokens are now registered. */
  private async flushPendingPoolState(): Promise<void> {
    if (this.pendingPoolState.size === 0) return;
    for (const [poolId, e] of this.pendingPoolState) {
      if (await this.applyPoolState(e)) {
        this.pendingPoolState.delete(poolId);
        logger.info({ poolId }, "Flushed buffered PoolStateUpdated");
      }
    }
  }

  async handle(event: DecodedEvent): Promise<void> {
    // Try to flush any buffered PoolStateUpdated events on every incoming event
    await this.flushPendingPoolState();

    // Track pool state (liquidity + price) from PoolStateUpdated
    if (event.eventType === "PoolStateUpdated") {
      const e = event as PoolStateUpdatedEvent;
      const applied = await this.applyPoolState(e);
      if (!applied) {
        // Token not registered yet (race with token processor) — buffer for retry
        this.pendingPoolState.set(e.poolId.toLowerCase(), e);
        if (this.pendingPoolState.size > 500) {
          // Evict oldest
          this.pendingPoolState.delete(this.pendingPoolState.keys().next().value!);
        }
        logger.debug({ poolId: e.poolId }, "PoolStateUpdated buffered — token not yet registered");
      }
      return;
    }

    if (event.eventType !== "PoolSwap") return;
    const e = event as PoolSwapEvent;
    if (!e.tokenAddress) return;

    // Drain pending transfers so makerCache is populated before we look up
    await this.drainTransfers();

    const txKey     = e.transactionHash.toLowerCase();
    const makerEntry = this.makerCache.get(txKey);
    const maker = makerEntry
      ? (e.isBuy ? makerEntry.to : makerEntry.from)
      : null;

    const [ethUsdRate, tokenRow, liquidityEth] = await Promise.all([
      getEthUsdRate(this.publisher),
      this.pool.query<{ name: string | null; symbol: string | null; total_supply: string | null }>(
        `SELECT name, symbol, total_supply::text FROM token_registry WHERE token_address = $1`,
        [e.tokenAddress.toLowerCase()]
      ),
      getPoolLiquidityEth(this.pool, e.tokenAddress),
    ]);
    const priceUsd  = ethUsdRate ? ethPriceToUsd(e.priceEth,  ethUsdRate) : null;
    const volumeUsd = ethUsdRate ? ethPriceToUsd(e.volumeEth, ethUsdRate) : null;
    const tr = tokenRow.rows[0];

    // marketCapETH = priceEth * totalSupply / 1e18
    let marketCapEth: string | null = null;
    if (tr?.total_supply) {
      try {
        marketCapEth = (e.priceEth * BigInt(tr.total_supply) / (10n ** 18n)).toString();
      } catch (err) { logger.debug({ err }, "Ignored error"); }
    }

    // Derive phase from which sub-pool was active
    const phase = e.ispAmount0 !== 0n ? "isp"
                : e.flAmount0  !== 0n ? "fl"
                : "swap";

    await insertTrade(this.pool, {
      id:             e.id,
      blockNumber:    e.blockNumber,
      blockHash:      e.blockHash,
      blockTimestamp: e.blockTimestamp,
      txHash:         e.transactionHash,
      tokenAddress:   e.tokenAddress,
      poolId:         e.poolId,
      amount0Eth:     e.totalAmount0,
      amount1Tokens:  e.totalAmount1,
      priceEth:       e.priceEth,
      priceUsd,
      feeEth:         e.totalFee0,
      phase,
      isBuy:          e.isBuy,
      chainId:        e.chainId,
    });

    // Backfill sender/recipient on the trade row for REST API
    if (maker) {
      await this.pool.query(
        `UPDATE trades SET
           sender    = CASE WHEN is_buy = false THEN $2 ELSE sender    END,
           recipient = CASE WHEN is_buy = true  THEN $2 ELSE recipient END
         WHERE id = $1`,
        [e.id, maker]
      );
    }

    await invalidate(this.publisher, KEYS.apiTokenList());
    await publishTokenUpdate(this.publisher, e.tokenAddress, {
      type:           "trade",
      id:             e.id,
      tokenAddress:   e.tokenAddress,
      name:           tr?.name        ?? null,
      symbol:         tr?.symbol      ?? null,
      totalSupply:    tr?.total_supply ?? null,
      priceEth:       e.priceEth.toString(),
      priceUsd:       priceUsd ?? 0,
      marketCapEth,
      liquidityEth,
      maker,
      isBuy:          e.isBuy,
      volumeEth:      e.volumeEth.toString(),
      volumeUsd:      volumeUsd ?? 0,
      txHash:         e.transactionHash,
      blockTimestamp: e.blockTimestamp.toString(),
    });

    logger.debug({ id: e.id, token: e.tokenAddress, maker }, "Trade written");
  }
}

new TradeProcessor(
  process.env.REDIS_URL    ?? "redis://localhost:6379",
  process.env.POSTGRES_URL!
).start().catch((err) => { console.error("Fatal:", err); process.exit(1); });
