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
  | "FairLaunchCreated"
  | "FairLaunchEnded"
  | "FairLaunchBurn"
  | "BidWallInitialized"
  | "BidWallRepositioned"
  | "BidWallDeposit"
  | "BidWallClosed"
  | "FeeEscrowDeposit"
  | "FeeEscrowWithdrawal"
  | "ManagerDeployed"
  | "ManagerInitializedFeeSplit"
  | "ManagerInitializedStaking"
  | "ManagerInitializedRevenue"
  | "RevenueClaimed"
  | "RevenueManagerClaimed"
  | "TreasuryEscrowed"
  | "TreasuryReclaimed"
  | "CreatorUpdated"
  | "ERC20Transfer"
  | "ERC721Transfer"
  | "ChainlinkAnswerUpdated";

// ── Pool events ───────────────────────────────────────────────────────────────

/**
 * Unified PoolCreated event across all PM versions.
 * pmVersion distinguishes the source contract family.
 */
export interface PoolCreatedEvent extends BaseEvent {
  eventType:       "PoolCreated";
  pmVersion:       "v1" | "v1.1" | "any";
  poolId:          string;      // _poolId (bytes32 indexed)
  tokenAddress:    Address;     // _memecoin
  treasuryAddress: Address;     // _memecoinTreasury
  tokenId:         bigint;      // _tokenId (NFT id)
  currencyFlipped: boolean;     // _currencyFlipped
  flaunchFee:      bigint;      // _flaunchFee (0 for AnyPM)
  creator:         Address;     // _params.creator
  name:            string;      // _params.name (empty for AnyPM)
  symbol:          string;      // _params.symbol (empty for AnyPM)
  creatorFeeAlloc: bigint;      // _params.creatorFeeAllocation
}

export interface PoolSwapEvent extends BaseEvent {
  eventType:    "PoolSwap";
  poolId:       string;
  tokenAddress: Address | null; // null when poolId not yet in map
  // Raw 13 fields
  flAmount0:  bigint; flAmount1:  bigint;
  flFee0:     bigint; flFee1:     bigint;
  ispAmount0: bigint; ispAmount1: bigint;
  ispFee0:    bigint; ispFee1:    bigint;
  uniAmount0: bigint; uniAmount1: bigint;
  uniFee0:    bigint; uniFee1:    bigint;
  // Derived
  totalAmount0: bigint;
  totalAmount1: bigint;
  totalFee0:    bigint;
  priceEth:     bigint;  // abs(totalAmount0) * WAD / abs(totalAmount1), 0 if div-by-zero
  isBuy:        boolean; // totalAmount0 > 0 (ETH entering pool = user buying tokens)
  volumeEth:    bigint;  // abs(totalAmount0)
}

export interface PoolStateUpdatedEvent extends BaseEvent {
  eventType:    "PoolStateUpdated";
  poolId:       string;
  sqrtPriceX96: bigint;
  tick:         number;
  protocolFee:  number;
  swapFee:      number;
  liquidity:    bigint;
}

export interface PoolFeesDistributedEvent extends BaseEvent {
  eventType:        "PoolFeesDistributed";
  poolId:           string;
  tokenAddress:     Address | null;
  donateAmount:     bigint;
  creatorAmount:    bigint;
  bidWallAmount:    bigint;
  governanceAmount: bigint;
  protocolAmount:   bigint;
}

// ── FairLaunch events ─────────────────────────────────────────────────────────

export interface FairLaunchCreatedEvent extends BaseEvent {
  eventType: "FairLaunchCreated";
  poolId:    string;
  tokens:    bigint;
  startsAt:  bigint;
  endsAt:    bigint;
}

export interface FairLaunchEndedEvent extends BaseEvent {
  eventType: "FairLaunchEnded";
  poolId:    string;
  revenue:   bigint;
  supply:    bigint;
  endedAt:   bigint;
}

export interface FairLaunchBurnEvent extends BaseEvent {
  eventType:    "FairLaunchBurn";
  poolId:       string;
  unsoldSupply: bigint;
}

// ── BidWall events ────────────────────────────────────────────────────────────

export interface BidWallInitializedEvent extends BaseEvent {
  eventType: "BidWallInitialized";
  poolId:    string;
  eth:       bigint;
  tickLower: number;
  tickUpper: number;
}

export interface BidWallRepositionedEvent extends BaseEvent {
  eventType: "BidWallRepositioned";
  poolId:    string;
  eth:       bigint;
  tickLower: number;
  tickUpper: number;
}

export interface BidWallDepositEvent extends BaseEvent {
  eventType: "BidWallDeposit";
  poolId:    string;
  added:     bigint;
  pending:   bigint;
}

export interface BidWallClosedEvent extends BaseEvent {
  eventType: "BidWallClosed";
  poolId:    string;
  recipient: Address;
  eth:       bigint;
}

// ── FeeEscrow events ──────────────────────────────────────────────────────────

export interface FeeEscrowDepositEvent extends BaseEvent {
  eventType: "FeeEscrowDeposit";
  poolId:    string;
  payee:     Address;
  token:     Address;
  amount:    bigint;
}

export interface FeeEscrowWithdrawalEvent extends BaseEvent {
  eventType:  "FeeEscrowWithdrawal";
  sender:     Address;
  recipient:  Address;
  token:      Address;
  amount:     bigint;
}

// ── Manager events ────────────────────────────────────────────────────────────

export interface ManagerDeployedEvent extends BaseEvent {
  eventType:             "ManagerDeployed";
  manager:               Address;
  managerImplementation: Address;
}

export interface ManagerInitializedFeeSplitEvent extends BaseEvent {
  eventType:    "ManagerInitializedFeeSplit";
  owner:        Address;
  creatorShare: bigint;
  ownerShare:   bigint;
}

export interface ManagerInitializedStakingEvent extends BaseEvent {
  eventType:          "ManagerInitializedStaking";
  owner:              Address;
  stakingToken:       Address;
  minEscrowDuration:  bigint;
  minStakeDuration:   bigint;
  creatorShare:       bigint;
  ownerShare:         bigint;
}

export interface ManagerInitializedRevenueEvent extends BaseEvent {
  eventType:          "ManagerInitializedRevenue";
  owner:              Address;
  protocolRecipient:  Address;
  protocolFee:        bigint;
}

export interface RevenueClaimedEvent extends BaseEvent {
  eventType:     "RevenueClaimed";
  recipient:     Address;
  amountClaimed: bigint;
}

export interface RevenueManagerClaimedEvent extends BaseEvent {
  eventType: "RevenueManagerClaimed";
  flaunch:   Address;
  tokenId:   bigint;
  recipient: Address;
  amount:    bigint;
}

export interface TreasuryEscrowedEvent extends BaseEvent {
  eventType: "TreasuryEscrowed";
  flaunch:   Address;
  tokenId:   bigint;
  owner:     Address;
  sender:    Address;
}

export interface TreasuryReclaimedEvent extends BaseEvent {
  eventType: "TreasuryReclaimed";
  flaunch:   Address;
  tokenId:   bigint;
  sender:    Address;
  recipient: Address;
}

export interface CreatorUpdatedEvent extends BaseEvent {
  eventType: "CreatorUpdated";
  flaunch:   Address;
  tokenId:   bigint;
  creator:   Address;
}

// ── Token standard events ─────────────────────────────────────────────────────

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

// ── Union ─────────────────────────────────────────────────────────────────────

export type DecodedEvent =
  | PoolCreatedEvent
  | PoolSwapEvent
  | PoolStateUpdatedEvent
  | PoolFeesDistributedEvent
  | FairLaunchCreatedEvent
  | FairLaunchEndedEvent
  | FairLaunchBurnEvent
  | BidWallInitializedEvent
  | BidWallRepositionedEvent
  | BidWallDepositEvent
  | BidWallClosedEvent
  | FeeEscrowDepositEvent
  | FeeEscrowWithdrawalEvent
  | ManagerDeployedEvent
  | ManagerInitializedFeeSplitEvent
  | ManagerInitializedStakingEvent
  | ManagerInitializedRevenueEvent
  | RevenueClaimedEvent
  | RevenueManagerClaimedEvent
  | TreasuryEscrowedEvent
  | TreasuryReclaimedEvent
  | CreatorUpdatedEvent
  | ERC20TransferEvent
  | ERC721TransferEvent
  | ChainlinkAnswerUpdatedEvent;

// ── Supporting types ──────────────────────────────────────────────────────────

export type CandleResolution = "1m" | "15m" | "1h" | "4h" | "1d";

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
