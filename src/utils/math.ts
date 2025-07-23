// src/shared/math.ts

import type { CandleResolution, Position } from "../types/events";
import { CANDLE_SECONDS } from "../types/events";

const Q96 = 2n ** 96n;
const WAD  = 10n ** 18n;

export function sqrtPriceX96ToEthPrice(sqrtPriceX96: bigint): bigint {
  if (sqrtPriceX96 === 0n) return 0n;
  return (sqrtPriceX96 * sqrtPriceX96 * WAD) / (Q96 * Q96);
}

export function ethPriceToUsd(priceEthWad: bigint, ethUsdRate: bigint): number {
  return Number(priceEthWad * ethUsdRate) / Number(WAD * 10n ** 8n);
}

export function getBucketTime(blockTimestamp: bigint, resolution: CandleResolution): bigint {
  const seconds = BigInt(CANDLE_SECONDS[resolution]);
  return (blockTimestamp / seconds) * seconds;
}

export const ALL_RESOLUTIONS: CandleResolution[] = ["1m", "15m", "1h", "4h", "1d"];

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