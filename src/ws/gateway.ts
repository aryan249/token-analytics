// WebSocket gateway as a Fastify plugin — mounted by the main API server.
// Single connection, no subscriptions. Every client receives all events.
//
// Event types:
//   activity          — every trade (buy/sell) for any token
//   priceUpdate       — price + mcap on every trade
//   candle            — candle tip update for any token + resolution
//   sparklineUpdate   — last-24 1h closes updated whenever a 1h candle changes
//   coinFeeUpdate     — fee distribution for a token
//   protocolFeeUpdate — global protocol fee delta
//   tokenList         — full token list sorted by mcap (debounced 2s)
//   new_token         — new token launched

import { createClient }           from "redis";
import type { FastifyPluginAsync } from "fastify";
import type { WebSocket as WS }    from "@fastify/websocket";
import type { Pool }               from "pg";
import type { RedisClient }        from "../clients/redis";
import { KEYS, getEthUsdRate, EVENT_CHANNELS, makeRedisClient } from "../clients/redis";
import { verifyJwt }              from "../api/auth";
import { getTokenList }            from "../utils/db/tokens";
import { ethPriceToUsd, formatUsd } from "../utils/math";
import { logger }                  from "../utils/logger";

const WAD = 10n ** 18n;

/** Convert a raw wei bigint string to a human-readable ETH decimal string. */
function weiToEth(wei: string | null | undefined): string | null {
  if (wei == null) return null;
  try {
    const n = BigInt(wei);
    if (n === 0n) return "0";
    const whole = n / WAD;
    const frac  = n % WAD;
    if (frac === 0n) return whole.toString();
    return `${whole}.${frac.toString().padStart(18, "0").replace(/0+$/, "")}`;
  } catch { return null; }
}

// ── Connected clients with heartbeat ─────────────────────────────────────────

const HEARTBEAT_INTERVAL = 30_000;
const HEARTBEAT_TIMEOUT  = 10_000;

interface TrackedClient {
  ws:       WS;
  alive:    boolean;
  timer?:   ReturnType<typeof setTimeout>;
}

const clientMap = new Map<WS, TrackedClient>();

function broadcast(msg: object): void {
  if (clientMap.size === 0) return;
  const payload = JSON.stringify(msg);
  for (const [ws] of clientMap) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

function getClientCount(): number {
  return clientMap.size;
}

// ── Token metadata cache ──────────────────────────────────────────────────────

interface TokenMeta {
  name:        string | null;
  symbol:      string | null;
  totalSupply: string | null;
  mcapEth:     string | null;
  sparkline:   string[];          // last 24 × 1h closeEth values
}

const tokenMetaMap = new Map<string, TokenMeta>();
let   lastMetaLoad = 0;

async function refreshTokenMeta(reader: RedisClient): Promise<void> {
  if (Date.now() - lastMetaLoad < 60_000) return;
  try {
    const raw = await reader.get(KEYS.apiTokenList());
    if (!raw) return;
    const list = JSON.parse(raw) as Array<{
      tokenAddress: string; name: string | null; symbol: string | null;
      totalSupply: string | null; marketCapETH: string | null; sparkline: string[];
    }>;
    for (const t of list) {
      const addr = t.tokenAddress.toLowerCase();
      const existing = tokenMetaMap.get(addr);
      tokenMetaMap.set(addr, {
        name:        t.name,
        symbol:      t.symbol,
        totalSupply: t.totalSupply,
        mcapEth:     t.marketCapETH,
        // keep in-memory sparkline if we already have one (more up-to-date)
        sparkline:   existing?.sparkline.length ? existing.sparkline : (t.sparkline ?? []),
      });
    }
    lastMetaLoad = Date.now();
    logger.debug({ count: tokenMetaMap.size }, "Token meta refreshed");
  } catch { /* non-fatal */ }
}

// ── Full token list builder (mirrors REST API format) ────────────────────────

async function buildAndCacheTokenList(pool: Pool, writer: RedisClient): Promise<unknown[]> {
  const [rows, ethUsdRate] = await Promise.all([
    getTokenList(pool),
    getEthUsdRate(writer),
  ]);

  const list = rows.map((r) => {
    const priceWei  = r.lastPriceEth;
    const mcapWei   = r.mcapEth;
    const priceETH  = weiToEth(priceWei);
    const mcapETH   = weiToEth(mcapWei);
    const vol24hETH = weiToEth(r.vol24hEth) ?? "0";
    const feesETH   = weiToEth(r.feesEarnedEth) ?? "0";
    const priceUSD  = priceWei && ethUsdRate ? formatUsd(ethPriceToUsd(BigInt(priceWei), ethUsdRate)) : null;
    const mcapUSD   = mcapWei && ethUsdRate  ? formatUsd(ethPriceToUsd(BigInt(mcapWei),  ethUsdRate)) : null;
    const vol24hUSD = ethUsdRate ? formatUsd(ethPriceToUsd(BigInt(r.vol24hEth), ethUsdRate)) : null;
    const feesUSD   = ethUsdRate ? formatUsd(ethPriceToUsd(BigInt(r.feesEarnedEth), ethUsdRate)) : null;

    let change24h: number | null = null;
    if (priceWei && r.price24hOpenEth) {
      try {
        const cur = Number(BigInt(priceWei));
        const opn = Number(BigInt(r.price24hOpenEth));
        if (opn > 0) change24h = (cur - opn) / opn * 100;
      } catch { /* ignore */ }
    }

    const totalShares = r.royaltyMembers.reduce((s, m) => s + BigInt(m.share), 0n);
    const royaltyMembers = r.royaltyMembers.length
      ? r.royaltyMembers.map((m) => ({
          address:    m.recipient,
          percentage: totalShares > 0n ? Number(BigInt(m.share) * 10000n / totalShares) / 100 : 0,
        }))
      : [{ address: r.creator, percentage: 100 }];

    return {
      tokenAddress:                   r.tokenAddress,
      image:                          `https://i.flaunch.gg/token/${r.tokenAddress}`,
      symbol:                         r.symbol,
      name:                           r.name,
      priceETH,
      priceUSD,
      twentyFourHourChangePercentage: change24h,
      twentyFourHourVolume:           vol24hETH,
      twentyFourHourVolumeUSD:        vol24hUSD,
      tradeCount24h:                  r.tradeCount24h,
      holderCount:                    r.holderCount,
      feesEarned:                     feesETH,
      feesEarnedUSD:                  feesUSD,
      marketCapETH:                   mcapETH,
      marketCapUSD:                   mcapUSD,
      discoveredAt:                   r.discoveredAt,
      royaltyMembers,
      hourData: [
        ...r.hourData.map((h) => ({
          periodStartUnix: Number(h.periodStartUnix),
          volumeETH:       weiToEth(h.volumeEth) ?? "0",
          volumeUSD:       ethUsdRate ? formatUsd(ethPriceToUsd(BigInt(h.volumeEth), ethUsdRate)) : null,
          openPriceETH:    weiToEth(h.openPriceEth),
          closePriceETH:   weiToEth(h.closePriceEth),
        })),
        ...(priceWei ? [{
          periodStartUnix: Math.floor(Date.now() / 1000),
          volumeETH:       "0",
          volumeUSD:       "0",
          openPriceETH:    weiToEth(priceWei),
          closePriceETH:   weiToEth(priceWei),
        }] : []),
      ],
    };
  });

  await writer.setEx(KEYS.apiTokenList(), 30, JSON.stringify(list));
  return list;
}

// ── tokenList broadcast (debounced 2 s) ──────────────────────────────────────

let lastTokenListTs = 0;

function sortByMcap<T extends { marketCapETH?: string | null }>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    if (!a.marketCapETH && !b.marketCapETH) return 0;
    if (!a.marketCapETH) return 1;
    if (!b.marketCapETH) return -1;
    return parseFloat(b.marketCapETH) - parseFloat(a.marketCapETH);
  });
}

async function broadcastTokenList(reader: RedisClient, pool: Pool): Promise<void> {
  if (Date.now() - lastTokenListTs < 2_000) return;
  lastTokenListTs = Date.now();
  try {
    const raw = await reader.get(KEYS.apiTokenList());
    type ListItem = { tokenAddress: string; marketCapETH: string | null; sparkline: string[]; [k: string]: unknown };
    let list: ListItem[];
    if (!raw) {
      // Cache is cold — build full list from DB and warm the cache
      list = (await buildAndCacheTokenList(pool, reader)) as ListItem[];
    } else {
      list = JSON.parse(raw) as ListItem[];
      // Merge in-memory sparklines (more current than cached list)
      for (const t of list) {
        const meta = tokenMetaMap.get(t.tokenAddress.toLowerCase());
        if (meta?.sparkline.length) t.sparkline = meta.sparkline;
      }
    }
    broadcast({ type: "tokenList", data: sortByMcap(list) });
  } catch { /* non-fatal */ }
}

// ── Trade → activity + priceUpdate + tokenList ───────────────────────────────

function onTradeUpdate(token: string, raw: string, reader: RedisClient, pool: Pool): void {
  type T = {
    id?: string; txHash?: string; isBuy?: boolean;
    priceEth?: string; priceUsd?: number; volumeEth?: string; volumeUsd?: number;
    blockTimestamp?: string;
    name?: string | null; symbol?: string | null; totalSupply?: string | null;
    marketCapEth?: string | null; liquidityEth?: string | null; maker?: string | null;
  };
  let data: T;
  try { data = JSON.parse(raw) as T; } catch { return; }

  const addr = token.toLowerCase();
  // Use in-memory meta if available, otherwise fall back to fields embedded in the trade update
  let meta = tokenMetaMap.get(addr);
  if (!meta) {
    meta = { name: data.name ?? null, symbol: data.symbol ?? null, totalSupply: data.totalSupply ?? null, mcapEth: null, sparkline: [] };
    tokenMetaMap.set(addr, meta);
  } else {
    if (!meta.name   && data.name)        meta.name        = data.name;
    if (!meta.symbol && data.symbol)      meta.symbol      = data.symbol;
    if (!meta.totalSupply && data.totalSupply) meta.totalSupply = data.totalSupply;
  }

  // activity
  broadcast({
    type: "activity",
    data: {
      id:        data.id ?? `${data.txHash}-${Date.now()}`,
      type:      data.isBuy ? "buy" : "sell",
      coin: {
        address: addr,
        symbol:  meta?.symbol ?? null,
        name:    meta?.name   ?? null,
        image:   `https://i.flaunch.gg/token/${addr}`,
      },
      maker:     data.maker ?? null,
      amountUSD: formatUsd(data.volumeUsd ?? 0),
      timestamp: Number(data.blockTimestamp ?? 0),
      txHash:    data.txHash ?? null,
    },
  });

  // priceUpdate — prefer values pre-computed by trade processor
  // Compute mcap in wei for internal use, then convert to decimal for broadcast
  let mcapEthWei: string | null = data.marketCapEth ?? null;
  let marketCapUSD: string | null = null;
  if (!mcapEthWei && meta?.totalSupply && data.priceEth) {
    try {
      mcapEthWei = (BigInt(data.priceEth) * BigInt(meta.totalSupply) / WAD).toString();
    } catch { /* ignore */ }
  }
  if (mcapEthWei && data.priceUsd != null && meta?.totalSupply) {
    try {
      marketCapUSD = formatUsd(data.priceUsd * Number(BigInt(meta.totalSupply)) / Number(WAD));
    } catch { /* ignore */ }
  }
  const marketCapETH = weiToEth(mcapEthWei);
  if (meta && marketCapETH) meta.mcapEth = marketCapETH;

  broadcast({
    type: "priceUpdate",
    data: {
      coinAddress:  addr,
      priceETH:     weiToEth(data.priceEth) ?? "0",
      priceUSD:     formatUsd(data.priceUsd ?? 0),
      liquidityETH: weiToEth(data.liquidityEth),
      marketCapETH,
      marketCapUSD,
      timestamp:    Number(data.blockTimestamp ?? 0),
    },
  });

  refreshTokenMeta(reader).then(() => broadcastTokenList(reader, pool)).catch(() => {});
}

// ── Candle → candle event + sparklineUpdate (1h only) ────────────────────────

function onCandleUpdate(channel: string, raw: string): void {
  let data: { tokenAddress?: string; resolution?: string; closeEth?: string; [k: string]: unknown };
  try { data = JSON.parse(raw) as typeof data; } catch { return; }

  // Always broadcast the raw candle tip
  broadcast({ type: "candle", data });

  // For 1h candles, update the in-memory sparkline and broadcast sparklineUpdate
  const m = channel.match(/^candles:1h:(.+)$/);
  if (!m) return;

  const addr  = m[1].toLowerCase();
  const close = data.closeEth;
  if (!close) return;

  let meta = tokenMetaMap.get(addr);
  if (!meta) {
    meta = { name: null, symbol: null, totalSupply: null, mcapEth: null, sparkline: [] };
    tokenMetaMap.set(addr, meta);
  }

  // Append new close (converted to decimal ETH) and keep last 24 values
  const closeDecimal = weiToEth(close) ?? close;
  meta.sparkline.push(closeDecimal);
  if (meta.sparkline.length > 24) meta.sparkline = meta.sparkline.slice(-24);

  broadcast({
    type: "sparklineUpdate",
    data: { coinAddress: addr, sparkline: meta.sparkline },
  });
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export interface GatewayOpts {
  redisUrl: string;
  pool:     Pool;
}

export const gatewayPlugin: FastifyPluginAsync<GatewayOpts> = async (app, { redisUrl, pool }) => {
  const sub    = createClient({ url: redisUrl });
  const reader = createClient({ url: redisUrl }) as unknown as RedisClient;

  sub.on("error",    (err) => logger.error({ err }, "WS Redis sub error"));
  reader.on("error", (err) => logger.error({ err }, "WS Redis reader error"));
  await sub.connect();
  await reader.connect();

  // Seed tokenMetaMap from DB so the first tokenList broadcast has real data
  try {
    const rows = await getTokenList(pool);
    for (const r of rows) {
      const addr = r.tokenAddress.toLowerCase();
      tokenMetaMap.set(addr, {
        name:        r.name,
        symbol:      r.symbol,
        totalSupply: r.totalSupply,
        mcapEth:     weiToEth(r.mcapEth),
        sparkline:   (r.sparkline ?? []).map((s) => weiToEth(s) ?? s),
      });
    }
    logger.info({ count: tokenMetaMap.size }, "Token meta seeded from DB");
  } catch (err) {
    logger.warn({ err }, "Could not seed token meta from DB");
  }

  lastMetaLoad = 0;
  await refreshTokenMeta(reader);

  // updates:{token} → activity + priceUpdate + tokenList
  await sub.pSubscribe("updates:*", (msg, ch) => {
    onTradeUpdate(ch.replace(/^updates:/, ""), msg, reader, pool);
  });

  // candles:{res}:{token} → candle + sparklineUpdate (1h only)
  await sub.pSubscribe("candles:*", (msg, ch) => onCandleUpdate(ch, msg));

  // fees:coin:{token} → coinFeeUpdate
  await sub.pSubscribe("fees:coin:*", (msg) => {
    let data: unknown;
    try { data = JSON.parse(msg); } catch { return; }
    broadcast({ type: "coinFeeUpdate", data });
  });

  // fees:protocol → protocolFeeUpdate
  await sub.subscribe("fees:protocol", (msg) => {
    let data: unknown;
    try { data = JSON.parse(msg); } catch { return; }
    broadcast({ type: "protocolFeeUpdate", data });
  });

  // stream:meta → new_token + tokenList (read via consumer group)
  const metaStreamReader = await makeRedisClient(redisUrl);
  const META_GROUP    = "ws-gateway";
  const META_CONSUMER = `ws-gateway-${process.pid}`;
  try {
    await metaStreamReader.xGroupCreate(EVENT_CHANNELS.meta, META_GROUP, "0", { MKSTREAM: true });
  } catch (err: any) {
    if (!err?.message?.includes("BUSYGROUP")) throw err;
  }

  const readMetaStream = async () => {
    while (true) {
      try {
        const results = await metaStreamReader.xReadGroup(
          META_GROUP, META_CONSUMER,
          [{ key: EVENT_CHANNELS.meta, id: ">" }],
          { COUNT: 20, BLOCK: 2000 },
        );
        if (!results) continue;
        for (const { messages } of results) {
          for (const { id, message } of messages) {
            try {
              const payload = JSON.parse(message.data) as {
                eventType?: string; tokenAddress?: string;
                name?: string | null; symbol?: string | null; totalSupply?: string | null;
              };
              if (payload.eventType === "TokenMetaUpdated" && payload.tokenAddress) {
                const addr = payload.tokenAddress.toLowerCase();
                const meta = tokenMetaMap.get(addr) ?? { name: null, symbol: null, totalSupply: null, mcapEth: null, sparkline: [] };
                if (payload.name)        meta.name        = payload.name;
                if (payload.symbol)      meta.symbol      = payload.symbol;
                if (payload.totalSupply) meta.totalSupply = typeof payload.totalSupply === "string" && payload.totalSupply.endsWith("n")
                  ? payload.totalSupply.slice(0, -1)
                  : payload.totalSupply;
                tokenMetaMap.set(addr, meta);
              }
              if (payload.eventType === "PoolCreated" && payload.tokenAddress) {
                const addr = payload.tokenAddress.toLowerCase();
                if (!tokenMetaMap.has(addr)) {
                  tokenMetaMap.set(addr, {
                    name: payload.name ?? null, symbol: payload.symbol ?? null,
                    totalSupply: payload.totalSupply ?? null, mcapEth: null, sparkline: [],
                  });
                } else {
                  const meta = tokenMetaMap.get(addr);
                  if (meta) {
                    if (!meta.name        && payload.name)        meta.name        = payload.name;
                    if (!meta.symbol      && payload.symbol)      meta.symbol      = payload.symbol;
                    if (!meta.totalSupply && payload.totalSupply) meta.totalSupply = payload.totalSupply;
                  }
                }
                lastMetaLoad = 0;
                broadcast({ type: "new_token", data: payload });
                refreshTokenMeta(reader).then(() => broadcastTokenList(reader, pool)).catch(() => {});
              }
            } catch { /* ignore parse errors */ }
            await metaStreamReader.xAck(EVENT_CHANNELS.meta, META_GROUP, id);
          }
        }
      } catch (err) {
        logger.error({ err }, "Meta stream read error");
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  };
  readMetaStream();

  // chainlink:rate → tokenList USD refresh
  await sub.subscribe("chainlink:rate", () => {
    lastMetaLoad = 0;
    refreshTokenMeta(reader).then(() => broadcastTokenList(reader, pool)).catch(() => {});
  });

  logger.info("WS Redis subscriptions active");

  // Server-side heartbeat: ping every client, drop if no pong within timeout
  setInterval(() => {
    for (const [ws, client] of clientMap) {
      if (!client.alive) {
        logger.debug("Dropping unresponsive WS client");
        ws.terminate();
        clientMap.delete(ws);
        continue;
      }
      client.alive = false;
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL);

  setInterval(() => { lastMetaLoad = 0; refreshTokenMeta(reader).catch(() => {}); }, 60_000);

  // WS endpoint
  app.get<{ Querystring: { token?: string } }>("/ws", { websocket: true }, (socket, req) => {
    const jwtSecret = process.env.JWT_SECRET;
    if (jwtSecret) {
      const token = req.query.token;
      if (!token || !verifyJwt(token, jwtSecret)) {
        socket.close(4001, "Unauthorized");
        return;
      }
    }

    const tracked: TrackedClient = { ws: socket, alive: true };
    clientMap.set(socket, tracked);
    logger.debug({ total: clientMap.size }, "WS client connected");

    // Mark alive on pong
    socket.on("pong", () => { tracked.alive = true; });

    // Send current tokenList immediately on connect
    (async () => {
      try {
        if (socket.readyState !== socket.OPEN) return;
        type ListItem = { tokenAddress: string; marketCapETH: string | null; sparkline: string[]; [k: string]: unknown };
        const raw = await reader.get(KEYS.apiTokenList());
        let list: ListItem[];
        if (raw) {
          list = JSON.parse(raw) as ListItem[];
          for (const t of list) {
            const meta = tokenMetaMap.get(t.tokenAddress.toLowerCase());
            if (meta?.sparkline.length) t.sparkline = meta.sparkline;
          }
        } else {
          list = (await buildAndCacheTokenList(pool, reader)) as ListItem[];
        }
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: "tokenList", data: sortByMcap(list) }));
        }
      } catch { /* non-fatal */ }
    })();

    socket.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type?: string };
        if (msg.type === "ping") {
          tracked.alive = true;
          socket.send(JSON.stringify({ type: "pong" }));
        }
      } catch { /* ignore */ }
    });

    socket.on("close", () => {
      clientMap.delete(socket);
      logger.debug({ total: clientMap.size }, "WS client disconnected");
    });
    socket.on("error", (err) => {
      logger.warn({ err }, "WS client error");
      clientMap.delete(socket);
    });
  });
};
