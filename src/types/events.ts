// src/types/events.ts

import type { Address, Hash } from "viem";

export interface RawLog {
  address:         string;
  topics:          string[];
  data:            string;
  blockNumber:     bigint;
  blockHash:       Hash;
  transactionHash: Hash;
  logIndex:        number;
  blockTimestamp:  bigint;
}

export interface BlockHeader {
  blockNumber:    bigint;
  blockHash:      Hash;
  parentHash:     Hash;
  blockTimestamp: bigint;
}

export interface BaseEvent {
  id:              string;      // "{blockHash}:{logIndex}"
  eventType:       EventType;
  blockNumber:     bigint;
  blockHash:       Hash;
  blockTimestamp:  bigint;
  transactionHash: Hash;
  logIndex:        number;
  contractAddress: Address;
  chainId:         number;
}

export type EventType =
  | "PoolCreated"
  | "PoolSwap"
  | "PoolStateUpdated"
  | "PoolFeesDistributed"
  | "ERC20Transfer"
  | "ERC721Transfer"
  | "FairLaunchCreated"
  | "BidWallUpdated"
  | "ChainlinkAnswerUpdated"
  | "FeesClaimed";

export interface PoolCreatedEvent extends BaseEvent {
  eventType:           "PoolCreated";
  tokenAddress:        Address;
  poolId:              string;
  creator:             Address;
  nftId:               bigint;
  fairLaunchAddress:   Address;
  bidWallAddress:      Address;
  initialSqrtPriceX96: bigint;
}

export interface PoolSwapEvent extends BaseEvent {
  eventType:    "PoolSwap";
  tokenAddress: Address;
  poolId:       string;
  sender:       Address;
  recipient:    Address;
  amount0:      bigint;
  amount1:      bigint;
  sqrtPriceX96: bigint;
  liquidity:    bigint;
  tick:         number;
  fee:          bigint;
  isBuy:        boolean;
  phase:        "FairLaunch" | "ISP" | "Uniswap";
}

export interface PoolStateUpdatedEvent extends BaseEvent {
  eventType:    "PoolStateUpdated";
  tokenAddress: Address;
  poolId:       string;
  sqrtPriceX96: bigint;
  tick:         number;
  liquidity:    bigint;
}

export interface PoolFeesDistributedEvent extends BaseEvent {
  eventType:        "PoolFeesDistributed";
  tokenAddress:     Address;
  poolId:           string;
  totalFeeEth:      bigint;
  creatorFeeEth:    bigint;
  communityFeeEth:  bigint;
  bidWallFeeEth:    bigint;
  governanceFeeEth: bigint;
  protocolFeeEth:   bigint;
  feeReceiver:      Address;
}

export interface ERC20TransferEvent extends BaseEvent {
  eventType:    "ERC20Transfer";
  tokenAddress: Address;
  from:         Address;
  to:           Address;
  value:        bigint;
}

export interface ERC721TransferEvent extends BaseEvent {
  eventType:   "ERC721Transfer";
  nftContract: Address;
  from:        Address;
  to:          Address;
  tokenId:     bigint;
}

export interface ChainlinkAnswerUpdatedEvent extends BaseEvent {
  eventType: "ChainlinkAnswerUpdated";
  current:   bigint;
  roundId:   bigint;
  updatedAt: bigint;
}

export interface FeesClaimedEvent extends BaseEvent {
  eventType:    "FeesClaimed";
  tokenAddress: Address;
  claimant:     Address;
  amountEth:    bigint;
}

export interface FairLaunchCreatedEvent extends BaseEvent {
  eventType:         "FairLaunchCreated";
  tokenAddress:      Address;
  fairLaunchAddress: Address;
  targetRaise:       bigint;
  duration:          bigint;
}

export interface BidWallUpdatedEvent extends BaseEvent {
  eventType:      "BidWallUpdated";
  tokenAddress:   Address;
  bidWallAddress: Address;
  floorPrice:     bigint;
  totalLiquidity: bigint;
}

export type DecodedEvent =
  | PoolCreatedEvent
  | PoolSwapEvent
  | PoolStateUpdatedEvent
  | PoolFeesDistributedEvent
  | ERC20TransferEvent
  | ERC721TransferEvent
  | ChainlinkAnswerUpdatedEvent
  | FeesClaimedEvent
  | FairLaunchCreatedEvent
  | BidWallUpdatedEvent;

export type CandleResolution = "1m" | "15m" | "1h" | "4h" | "1d";

export const CANDLE_SECONDS: Record<CandleResolution, number> = {
  "1m":  60,
  "15m": 900,
  "1h":  3600,
  "4h":  14400,
  "1d":  86400,
};

export interface Candle {
  tokenAddress: string;
  resolution:   CandleResolution;
  bucketTime:   bigint;
  openEth:      bigint;
  highEth:      bigint;
  lowEth:       bigint;
  closeEth:     bigint;
  volumeEth:    bigint;
  tradeCount:   number;
}

export interface Position {
  walletAddress:  string;
  tokenAddress:   string;
  balance:        bigint;
  costBasisEth:   bigint;
  realizedPnlEth: bigint;
}

export interface SyncCheckpoint {
  chainId:            number;
  lastFinalizedBlock: bigint;
  lastFinalizedHash:  Hash;
  updatedAt:          Date;
}