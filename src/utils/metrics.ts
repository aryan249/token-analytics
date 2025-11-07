import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from "prom-client";

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

// ── Event processing ─────────────────────────────────────────────────────────

export const eventsProcessed = new Counter({
  name: "events_processed_total",
  help: "Total events processed by type and status",
  labelNames: ["processor", "event_type", "status"] as const, // status: ok | error | dead_letter
  registers: [registry],
});

export const eventProcessingDuration = new Histogram({
  name: "event_processing_duration_seconds",
  help: "Time to process a single event",
  labelNames: ["processor", "event_type"] as const,
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [registry],
});

// ── Scanner ──────────────────────────────────────────────────────────────────

export const blocksProcessed = new Counter({
  name: "blocks_processed_total",
  help: "Total blocks processed by the scanner",
  registers: [registry],
});

export const scannerLag = new Gauge({
  name: "scanner_lag_blocks",
  help: "Number of blocks behind chain head",
  registers: [registry],
});

// ── Redis streams ────────────────────────────────────────────────────────────

export const streamPublishDuration = new Histogram({
  name: "stream_publish_duration_seconds",
  help: "Time to publish a batch of events to Redis streams",
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
  registers: [registry],
});

export const streamPendingMessages = new Gauge({
  name: "stream_pending_messages",
  help: "Number of pending (unacked) messages per stream",
  labelNames: ["stream", "group"] as const,
  registers: [registry],
});

// ── API cache ────────────────────────────────────────────────────────────────

export const cacheHits = new Counter({
  name: "cache_hits_total",
  help: "Cache hit count by key pattern",
  labelNames: ["pattern"] as const,
  registers: [registry],
});

export const cacheMisses = new Counter({
  name: "cache_misses_total",
  help: "Cache miss count by key pattern",
  labelNames: ["pattern"] as const,
  registers: [registry],
});

// ── API requests ─────────────────────────────────────────────────────────────

export const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration by route and status code",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total HTTP requests by route and status code",
  labelNames: ["method", "route", "status_code"] as const,
  registers: [registry],
});

// ── WebSocket ────────────────────────────────────────────────────────────────

export const wsClientsConnected = new Gauge({
  name: "ws_clients_connected",
  help: "Number of connected WebSocket clients",
  registers: [registry],
});

export const wsMessagesBroadcast = new Counter({
  name: "ws_messages_broadcast_total",
  help: "Total WebSocket messages broadcast by type",
  labelNames: ["type"] as const,
  registers: [registry],
});

// ── Dead-letter queue ────────────────────────────────────────────────────────

export const deadLetterTotal = new Counter({
  name: "dead_letter_total",
  help: "Total messages sent to dead-letter queue",
  labelNames: ["stream"] as const,
  registers: [registry],
});

// ── Errors ───────────────────────────────────────────────────────────────────

export const errorsTotal = new Counter({
  name: "errors_total",
  help: "Total errors by source and type",
  labelNames: ["source", "type"] as const,
  registers: [registry],
});
