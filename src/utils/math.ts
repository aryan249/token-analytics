import type { CandleResolution, Position } from "../types/events";
import { Q96, WAD, CANDLE_SECONDS, ALL_RESOLUTIONS } from "./constants";

export { ALL_RESOLUTIONS };

export function sqrtPriceX96ToEthPrice(sqrtPriceX96: bigint): bigint {
  if (sqrtPriceX96 === 0n) return 0n;
  return (sqrtPriceX96 * sqrtPriceX96 * WAD) / (Q96 * Q96);
}

export function ethPriceToUsd(priceEthWad: bigint, ethUsdRate: bigint): number {
  return Number(priceEthWad * ethUsdRate) / Number(WAD * 10n ** 8n);
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

export function applyTradeToPosition(
  existing:      Position | null,
  walletAddress: string,
  tokenAddress:  string,
  isBuy:         boolean,
  tokenAmount:   bigint,
  ethAmount:     bigint,
): Position {
  const prev: Position = existing ?? {
    walletAddress, tokenAddress, balance: 0n, costBasisEth: 0n, realizedPnlEth: 0n,
  };

  if (isBuy) {
    return { ...prev, balance: prev.balance + tokenAmount, costBasisEth: prev.costBasisEth + ethAmount };
  }

  if (prev.balance === 0n) return prev;

  const sold       = tokenAmount > prev.balance ? prev.balance : tokenAmount;
  const costOfSold = prev.balance > 0n ? (prev.costBasisEth * sold) / prev.balance : 0n;

  return {
    ...prev,
    balance:        prev.balance - sold,
    costBasisEth:   prev.costBasisEth - costOfSold,
    realizedPnlEth: prev.realizedPnlEth + (ethAmount - costOfSold),
  };
}
