import type { CandleResolution } from "../types/events";

// ── Math primitives ───────────────────────────────────────────────────────────
export const Q96               = 2n ** 96n;
export const WAD               = 10n ** 18n;
export const TWO_192           = 2n ** 192n;
export const CHAINLINK_DECIMALS = 10n ** 8n;

// ── Candle resolutions ────────────────────────────────────────────────────────
export const ALL_RESOLUTIONS: CandleResolution[] = ["1m", "15m", "1h", "4h", "1d"];

export const RESOLUTIONS = new Set<string>(ALL_RESOLUTIONS);

export const CANDLE_SECONDS: Record<CandleResolution, number> = {
  "1m":  60,
  "15m": 900,
  "1h":  3600,
  "4h":  14400,
  "1d":  86400,
};
