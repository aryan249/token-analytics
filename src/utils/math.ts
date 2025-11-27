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
