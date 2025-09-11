import type { CandleResolution } from "../types/events";
import { WAD, CANDLE_SECONDS, ALL_RESOLUTIONS } from "./constants";

export { ALL_RESOLUTIONS };

export function weiToEth(wei: string | bigint | null | undefined): string | null {
  if (wei == null) return null;
  try {
    const n = typeof wei === "bigint" ? wei : BigInt(wei);
    if (n === 0n) return "0";
    const whole = n / WAD;
    const frac  = n % WAD;
    if (frac === 0n) return whole.toString();
    return `${whole}.${frac.toString().padStart(18, "0").replace(/0+$/, "")}`;
  } catch { return null; }
}

export function bigIntReviver(_k: string, v: unknown): unknown {
  return typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v;
}

export function ethPriceToUsd(priceEthWad: bigint, ethUsdRate: bigint): number {
  // Divide in BigInt land first to avoid overflow past Number.MAX_SAFE_INTEGER
  const SCALE = WAD * 10n ** 8n;
  const whole = (priceEthWad * ethUsdRate) / SCALE;
  const remainder = (priceEthWad * ethUsdRate) % SCALE;
  return Number(whole) + Number(remainder) / Number(SCALE);
}

/** Format a USD value as a string — uses full precision (scientific notation for tiny values). */
export function formatUsd(value: number, minDecimals = 0): string {
  // Large values (>= 0.01): fixed-point with appropriate decimals
  const abs = Math.abs(value);
  if (abs >= 1)      return value.toFixed(Math.max(minDecimals, 2));
  if (abs >= 0.01)   return value.toFixed(Math.max(minDecimals, 4));
  if (abs >= 0.0001) return value.toFixed(Math.max(minDecimals, 6));
  if (abs === 0)     return "0";
  // Tiny values: let JS pick scientific notation (matches FLaunch's format)
  return value.toString();
}

export function getBucketTime(blockTimestamp: bigint, resolution: CandleResolution): bigint {
  const seconds = BigInt(CANDLE_SECONDS[resolution]);
  return (blockTimestamp / seconds) * seconds;
}

