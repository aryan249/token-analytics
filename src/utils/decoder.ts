import { decodeEventLog, type Hash, type Address } from "viem";
import {
  POSITION_MANAGER_V1_ABI,
  POSITION_MANAGER_V11_ABI,
  ANY_POSITION_MANAGER_ABI,
  POOL_SWAP_ABI,
  POOL_STATE_UPDATED_ABI,
  POOL_FEES_DISTRIBUTED_ABI,
  FAIR_LAUNCH_ABI,
  BID_WALL_ABI,
  FEE_ESCROW_ABI,
  TREASURY_MANAGER_FACTORY_ABI,
  ADDRESS_FEE_SPLIT_MANAGER_ABI,
  STAKING_MANAGER_ABI,
  REVENUE_MANAGER_ABI,
  ERC20_ABI,
  ERC721_ABI,
  CHAINLINK_ABI,
  EVENT_TOPICS,
} from "../abis/abis";
import {
  FLAUNCH_NFT_SET, FEE_ESCROW_SET, FAIR_LAUNCH_SET,
  BID_WALL_SET, CHAINLINK_ADDRESS,
  PM_V1_SET, PM_V11_SET, ANY_PM_SET,
  TREASURY_FACTORY_SET,
} from "../contracts/contracts";
import type {
  RawLog, DecodedEvent,
  PoolCreatedEvent, PoolSwapEvent, PoolStateUpdatedEvent,
  PoolFeesDistributedEvent, FairLaunchCreatedEvent, FairLaunchEndedEvent,
  FairLaunchBurnEvent, BidWallInitializedEvent, BidWallRepositionedEvent,
  BidWallDepositEvent, BidWallClosedEvent, FeeEscrowDepositEvent,
  FeeEscrowWithdrawalEvent, ManagerDeployedEvent, ManagerInitializedFeeSplitEvent,
  ManagerInitializedStakingEvent, ManagerInitializedRevenueEvent,
  RevenueClaimedEvent, RevenueManagerClaimedEvent, TreasuryEscrowedEvent,
  TreasuryReclaimedEvent, CreatorUpdatedEvent,
  ERC20TransferEvent, ERC721TransferEvent, ChainlinkAnswerUpdatedEvent,
} from "../types/events";
import { WAD } from "./constants";
import { logger } from "./logger";

// ── Helpers ───────────────────────────────────────────────────────────────────

function eventId(blockHash: Hash, logIndex: number): string {
  return `${blockHash}:${logIndex}`;
}

function base(log: RawLog, chainId: number) {
  return {
    id:              eventId(log.blockHash, log.logIndex),
    blockNumber:     log.blockNumber,
    blockHash:       log.blockHash,
    blockTimestamp:  log.blockTimestamp,
    transactionHash: log.transactionHash,
    logIndex:        log.logIndex,
    contractAddress: log.address as Address,
    chainId,
  };
}

function asLog(log: RawLog) {
  return {
    address:         log.address as `0x${string}`,
    topics:          log.topics as [`0x${string}`, ...`0x${string}`[]],
    data:            log.data as `0x${string}`,
    blockNumber:     log.blockNumber,
    blockHash:       log.blockHash,
    transactionHash: log.transactionHash,
    logIndex:        log.logIndex,
  };
}

// ── PoolCreated decoders ──────────────────────────────────────────────────────

function decodePoolCreatedV1(log: RawLog, chainId: number): PoolCreatedEvent {
  const l = asLog(log);
  const d = decodeEventLog({ abi: POSITION_MANAGER_V1_ABI, eventName: "PoolCreated", data: l.data, topics: l.topics });
  const p = d.args._params as unknown as { name: string; symbol: string; creator: Address; creatorFeeAllocation: number };
  return {
    ...base(log, chainId),
    eventType:       "PoolCreated",
    pmVersion:       "v1",
    poolId:          d.args._poolId as string,
    tokenAddress:    d.args._memecoin as Address,
    treasuryAddress: d.args._memecoinTreasury as Address,
    tokenId:         d.args._tokenId as bigint,
    currencyFlipped: d.args._currencyFlipped as boolean,
    flaunchFee:      d.args._flaunchFee as bigint,
    creator:         p.creator,
    name:            p.name,
    symbol:          p.symbol,
    creatorFeeAlloc: BigInt(p.creatorFeeAllocation),
  };
}

function decodePoolCreatedV11(log: RawLog, chainId: number): PoolCreatedEvent {
  const l = asLog(log);
  const d = decodeEventLog({ abi: POSITION_MANAGER_V11_ABI, eventName: "PoolCreated", data: l.data, topics: l.topics });
  const p = d.args._params as unknown as { name: string; symbol: string; creator: Address; creatorFeeAllocation: number };
  return {
    ...base(log, chainId),
    eventType:       "PoolCreated",
    pmVersion:       "v1.1",
    poolId:          d.args._poolId as string,
    tokenAddress:    d.args._memecoin as Address,
    treasuryAddress: d.args._memecoinTreasury as Address,
    tokenId:         d.args._tokenId as bigint,
    currencyFlipped: d.args._currencyFlipped as boolean,
    flaunchFee:      d.args._flaunchFee as bigint,
    creator:         p.creator,
    name:            p.name,
    symbol:          p.symbol,
    creatorFeeAlloc: BigInt(p.creatorFeeAllocation),
  };
}

function decodePoolCreatedAny(log: RawLog, chainId: number): PoolCreatedEvent {
  const l = asLog(log);
  const d = decodeEventLog({ abi: ANY_POSITION_MANAGER_ABI, eventName: "PoolCreated", data: l.data, topics: l.topics });
  const p = d.args._params as unknown as { creator: Address; creatorFeeAllocation: number };
  return {
    ...base(log, chainId),
    eventType:       "PoolCreated",
    pmVersion:       "any",
    poolId:          d.args._poolId as string,
    tokenAddress:    d.args._memecoin as Address,
    treasuryAddress: d.args._memecoinTreasury as Address,
    tokenId:         d.args._tokenId as bigint,
    currencyFlipped: d.args._currencyFlipped as boolean,
    flaunchFee:      0n,
    creator:         p.creator,
    name:            "",
    symbol:          "",
    creatorFeeAlloc: BigInt(p.creatorFeeAllocation),
  };
}

// ── PoolSwap decoder ──────────────────────────────────────────────────────────

function decodePoolSwap(
  log:           RawLog,
  chainId:       number,
  poolIdToToken: Map<string, string>,
): PoolSwapEvent {
  const l = asLog(log);
  const d = decodeEventLog({ abi: POOL_SWAP_ABI, eventName: "PoolSwap", data: l.data, topics: l.topics });

  const poolId = d.args.poolId as string;

  const flAmount0  = d.args.flAmount0  as bigint;
  const flAmount1  = d.args.flAmount1  as bigint;
  const flFee0     = d.args.flFee0     as bigint;
  const flFee1     = d.args.flFee1     as bigint;
  const ispAmount0 = d.args.ispAmount0 as bigint;
  const ispAmount1 = d.args.ispAmount1 as bigint;
  const ispFee0    = d.args.ispFee0    as bigint;
  const ispFee1    = d.args.ispFee1    as bigint;
  const uniAmount0 = d.args.uniAmount0 as bigint;
  const uniAmount1 = d.args.uniAmount1 as bigint;
  const uniFee0    = d.args.uniFee0    as bigint;
  const uniFee1    = d.args.uniFee1    as bigint;

  const totalAmount0 = flAmount0 + ispAmount0 + uniAmount0;
  const totalAmount1 = flAmount1 + ispAmount1 + uniAmount1;
  const totalFee0    = flFee0 + ispFee0 + uniFee0;

  const absA0 = totalAmount0 < 0n ? -totalAmount0 : totalAmount0;
  const absA1 = totalAmount1 < 0n ? -totalAmount1 : totalAmount1;
  const priceEth = absA1 > 0n ? (absA0 * WAD) / absA1 : 0n;

  const tokenAddress = (poolIdToToken.get(poolId.toLowerCase()) ?? null) as Address | null;

  return {
    ...base(log, chainId),
    eventType: "PoolSwap",
    poolId,
    tokenAddress,
    flAmount0, flAmount1, flFee0, flFee1,
    ispAmount0, ispAmount1, ispFee0, ispFee1,
    uniAmount0, uniAmount1, uniFee0, uniFee1,
    totalAmount0,
    totalAmount1,
    totalFee0,
    priceEth,
    isBuy:     totalAmount0 > 0n,
    volumeEth: absA0,
  };
}

// ── PoolStateUpdated decoder ──────────────────────────────────────────────────

function decodePoolStateUpdated(log: RawLog, chainId: number): PoolStateUpdatedEvent {
  const l = asLog(log);
  const d = decodeEventLog({ abi: POOL_STATE_UPDATED_ABI, eventName: "PoolStateUpdated", data: l.data, topics: l.topics });
  return {
    ...base(log, chainId),
    eventType:    "PoolStateUpdated",
    poolId:       d.args._poolId as string,
    sqrtPriceX96: d.args._sqrtPriceX96 as bigint,
    tick:         Number(d.args._tick),
    protocolFee:  Number(d.args._protocolFee),
    swapFee:      Number(d.args._swapFee),
    liquidity:    d.args._liquidity as bigint,
  };
}

// ── PoolFeesDistributed decoder ───────────────────────────────────────────────

function decodePoolFeesDistributed(
  log:           RawLog,
  chainId:       number,
  poolIdToToken: Map<string, string>,
): PoolFeesDistributedEvent {
  const l = asLog(log);
  const d = decodeEventLog({ abi: POOL_FEES_DISTRIBUTED_ABI, eventName: "PoolFeesDistributed", data: l.data, topics: l.topics });
  const poolId = d.args._poolId as string;
  const tokenAddress = (poolIdToToken.get(poolId.toLowerCase()) ?? null) as Address | null;
  return {
    ...base(log, chainId),
    eventType:        "PoolFeesDistributed",
    poolId,
    tokenAddress,
    donateAmount:     d.args._donateAmount     as bigint,
    creatorAmount:    d.args._creatorAmount    as bigint,
    bidWallAmount:    d.args._bidWallAmount    as bigint,
    governanceAmount: d.args._governanceAmount as bigint,
    protocolAmount:   d.args._protocolAmount   as bigint,
  };
}

// ── FairLaunch decoders ───────────────────────────────────────────────────────

function decodeFairLaunchCreated(log: RawLog, chainId: number): FairLaunchCreatedEvent {
  const l = asLog(log);
  const d = decodeEventLog({ abi: FAIR_LAUNCH_ABI, eventName: "FairLaunchCreated", data: l.data, topics: l.topics });
  return {
    ...base(log, chainId),
    eventType: "FairLaunchCreated",
    poolId:    d.args._poolId  as string,
    tokens:    d.args._tokens  as bigint,
    startsAt:  d.args._startsAt as bigint,
    endsAt:    d.args._endsAt   as bigint,
  };
}

function decodeFairLaunchEnded(log: RawLog, chainId: number): FairLaunchEndedEvent {
  const l = asLog(log);
  const d = decodeEventLog({ abi: FAIR_LAUNCH_ABI, eventName: "FairLaunchEnded", data: l.data, topics: l.topics });
  return {
    ...base(log, chainId),
    eventType: "FairLaunchEnded",
    poolId:    d.args._poolId  as string,
    revenue:   d.args._revenue as bigint,
    supply:    d.args._supply  as bigint,
    endedAt:   d.args._endedAt as bigint,
  };
}

function decodeFairLaunchBurn(log: RawLog, chainId: number): FairLaunchBurnEvent {
  const l = asLog(log);
  const d = decodeEventLog({ abi: POSITION_MANAGER_V11_ABI, eventName: "FairLaunchBurn", data: l.data, topics: l.topics });
  return {
    ...base(log, chainId),
    eventType:    "FairLaunchBurn",
    poolId:       d.args._poolId       as string,
    unsoldSupply: d.args._unsoldSupply as bigint,
  };
}

// ── BidWall decoders ──────────────────────────────────────────────────────────

function decodeBidWallInitialized(log: RawLog, chainId: number): BidWallInitializedEvent {
  const l = asLog(log);
  const d = decodeEventLog({ abi: BID_WALL_ABI, eventName: "BidWallInitialized", data: l.data, topics: l.topics });
  return {
    ...base(log, chainId),
    eventType: "BidWallInitialized",
    poolId:    d.args._poolId    as string,
    eth:       d.args._eth       as bigint,
    tickLower: Number(d.args._tickLower),
    tickUpper: Number(d.args._tickUpper),
  };
}

function decodeBidWallRepositioned(log: RawLog, chainId: number): BidWallRepositionedEvent {
  const l = asLog(log);
  const d = decodeEventLog({ abi: BID_WALL_ABI, eventName: "BidWallRepositioned", data: l.data, topics: l.topics });
  return {
    ...base(log, chainId),
    eventType: "BidWallRepositioned",
    poolId:    d.args._poolId    as string,
    eth:       d.args._eth       as bigint,
    tickLower: Number(d.args._tickLower),
    tickUpper: Number(d.args._tickUpper),
  };
}

function decodeBidWallDeposit(log: RawLog, chainId: number): BidWallDepositEvent {
  const l = asLog(log);
  const d = decodeEventLog({ abi: BID_WALL_ABI, eventName: "BidWallDeposit", data: l.data, topics: l.topics });
  return {
    ...base(log, chainId),
    eventType: "BidWallDeposit",
    poolId:    d.args._poolId  as string,
    added:     d.args._added   as bigint,
    pending:   d.args._pending as bigint,
  };
}

function decodeBidWallClosed(log: RawLog, chainId: number): BidWallClosedEvent {
  const l = asLog(log);
  const d = decodeEventLog({ abi: BID_WALL_ABI, eventName: "BidWallClosed", data: l.data, topics: l.topics });
  return {
    ...base(log, chainId),
    eventType: "BidWallClosed",
    poolId:    d.args._poolId    as string,
    recipient: d.args._recipient as Address,
    eth:       d.args._eth       as bigint,
  };
}

// ── FeeEscrow decoders ────────────────────────────────────────────────────────

function decodeFeeEscrowDeposit(log: RawLog, chainId: number): FeeEscrowDepositEvent {
  const l = asLog(log);
  const d = decodeEventLog({ abi: FEE_ESCROW_ABI, eventName: "Deposit", data: l.data, topics: l.topics });
  return {
    ...base(log, chainId),
    eventType: "FeeEscrowDeposit",
    poolId:    d.args._poolId as string,
    payee:     d.args._payee  as Address,
    token:     d.args._token  as Address,
    amount:    d.args._amount as bigint,
  };
}

function decodeFeeEscrowWithdrawal(log: RawLog, chainId: number): FeeEscrowWithdrawalEvent {
  const l = asLog(log);
  const d = decodeEventLog({ abi: FEE_ESCROW_ABI, eventName: "Withdrawal", data: l.data, topics: l.topics });
  return {
    ...base(log, chainId),
    eventType: "FeeEscrowWithdrawal",
    sender:    d.args._sender    as Address,
    recipient: d.args._recipient as Address,
    token:     d.args._token     as Address,
    amount:    d.args._amount    as bigint,
  };
}

// ── Manager decoders ──────────────────────────────────────────────────────────

function decodeManagerDeployed(log: RawLog, chainId: number): ManagerDeployedEvent {
  const l = asLog(log);
  const d = decodeEventLog({ abi: TREASURY_MANAGER_FACTORY_ABI, eventName: "ManagerDeployed", data: l.data, topics: l.topics });
  return {
    ...base(log, chainId),
    eventType:             "ManagerDeployed",
    manager:               d.args._manager               as Address,
    managerImplementation: d.args._managerImplementation as Address,
  };
}

function decodeManagerInitializedFeeSplit(log: RawLog, chainId: number): ManagerInitializedFeeSplitEvent {
  const l = asLog(log);
  const d = decodeEventLog({ abi: ADDRESS_FEE_SPLIT_MANAGER_ABI, eventName: "ManagerInitialized", data: l.data, topics: l.topics });
  const p = d.args._params as { creatorShare: bigint; ownerShare: bigint };
  return {
    ...base(log, chainId),
    eventType:    "ManagerInitializedFeeSplit",
    owner:        d.args._owner as Address,
    creatorShare: p.creatorShare,
    ownerShare:   p.ownerShare,
  };
}

function decodeManagerInitializedStaking(log: RawLog, chainId: number): ManagerInitializedStakingEvent {
  const l = asLog(log);
  const d = decodeEventLog({ abi: STAKING_MANAGER_ABI, eventName: "ManagerInitialized", data: l.data, topics: l.topics });
  const p = d.args._params as {
    stakingToken: Address; minEscrowDuration: bigint;
    minStakeDuration: bigint; creatorShare: bigint; ownerShare: bigint;
  };
  return {
    ...base(log, chainId),
    eventType:         "ManagerInitializedStaking",
    owner:             d.args._owner as Address,
    stakingToken:      p.stakingToken,
    minEscrowDuration: p.minEscrowDuration,
    minStakeDuration:  p.minStakeDuration,
    creatorShare:      p.creatorShare,
    ownerShare:        p.ownerShare,
  };
}

function decodeManagerInitializedRevenue(log: RawLog, chainId: number): ManagerInitializedRevenueEvent {
  const l = asLog(log);
  const d = decodeEventLog({ abi: REVENUE_MANAGER_ABI, eventName: "ManagerInitialized", data: l.data, topics: l.topics });
  const p = d.args._params as { protocolRecipient: Address; protocolFee: bigint };
  return {
    ...base(log, chainId),
    eventType:         "ManagerInitializedRevenue",
    owner:             d.args._owner as Address,
    protocolRecipient: p.protocolRecipient,
    protocolFee:       p.protocolFee,
  };
}

function decodeRevenueClaimed(log: RawLog, chainId: number): RevenueClaimedEvent {
  const l = asLog(log);
  const d = decodeEventLog({ abi: ADDRESS_FEE_SPLIT_MANAGER_ABI, eventName: "RevenueClaimed", data: l.data, topics: l.topics });
  return {
    ...base(log, chainId),
    eventType:     "RevenueClaimed",
    recipient:     d.args._recipient     as Address,
    amountClaimed: d.args._amountClaimed as bigint,
  };
}

function decodeRevenueManagerClaimed(log: RawLog, chainId: number): RevenueManagerClaimedEvent {
  const l = asLog(log);
  const d = decodeEventLog({ abi: REVENUE_MANAGER_ABI, eventName: "RevenueClaimed", data: l.data, topics: l.topics });
  return {
    ...base(log, chainId),
    eventType: "RevenueManagerClaimed",
    flaunch:   d.args._flaunch   as Address,
    tokenId:   d.args._tokenId   as bigint,
    recipient: d.args._recipient as Address,
    amount:    d.args._amount    as bigint,
  };
}

function decodeTreasuryEscrowed(log: RawLog, chainId: number): TreasuryEscrowedEvent {
  // same ABI shape across all manager types — use AddressFeeSplitManager ABI
  const l = asLog(log);
  const d = decodeEventLog({ abi: ADDRESS_FEE_SPLIT_MANAGER_ABI, eventName: "TreasuryEscrowed", data: l.data, topics: l.topics });
  return {
    ...base(log, chainId),
    eventType: "TreasuryEscrowed",
    flaunch:   d.args._flaunch  as Address,
    tokenId:   d.args._tokenId  as bigint,
    owner:     d.args._owner    as Address,
    sender:    d.args._sender   as Address,
  };
}

function decodeTreasuryReclaimed(log: RawLog, chainId: number): TreasuryReclaimedEvent {
  const l = asLog(log);
  const d = decodeEventLog({ abi: ADDRESS_FEE_SPLIT_MANAGER_ABI, eventName: "TreasuryReclaimed", data: l.data, topics: l.topics });
  return {
    ...base(log, chainId),
    eventType: "TreasuryReclaimed",
    flaunch:   d.args._flaunch   as Address,
    tokenId:   d.args._tokenId   as bigint,
    sender:    d.args._sender    as Address,
    recipient: d.args._recipient as Address,
  };
}

function decodeCreatorUpdated(log: RawLog, chainId: number): CreatorUpdatedEvent {
  const l = asLog(log);
  const d = decodeEventLog({ abi: ADDRESS_FEE_SPLIT_MANAGER_ABI, eventName: "CreatorUpdated", data: l.data, topics: l.topics });
  return {
    ...base(log, chainId),
    eventType: "CreatorUpdated",
    flaunch:   d.args._flaunch  as Address,
    tokenId:   d.args._tokenId  as bigint,
    creator:   d.args._creator  as Address,
  };
}

// ── Token standard decoders ───────────────────────────────────────────────────

function decodeERC20Transfer(log: RawLog, chainId: number): ERC20TransferEvent {
  const l = asLog(log);
  const d = decodeEventLog({ abi: ERC20_ABI, eventName: "Transfer", data: l.data, topics: l.topics });
  return {
    ...base(log, chainId),
    eventType:    "ERC20Transfer",
    tokenAddress: log.address as Address,
    from:         d.args.from  as Address,
    to:           d.args.to    as Address,
    value:        d.args.value as bigint,
  };
}

function decodeERC721Transfer(log: RawLog, chainId: number): ERC721TransferEvent {
  const l = asLog(log);
  const d = decodeEventLog({ abi: ERC721_ABI, eventName: "Transfer", data: l.data, topics: l.topics });
  return {
    ...base(log, chainId),
    eventType:   "ERC721Transfer",
    nftContract: log.address as Address,
    from:        d.args.from    as Address,
    to:          d.args.to      as Address,
    tokenId:     d.args.tokenId as bigint,
  };
}

function decodeChainlinkAnswerUpdated(log: RawLog, chainId: number): ChainlinkAnswerUpdatedEvent {
  const l = asLog(log);
  const d = decodeEventLog({ abi: CHAINLINK_ABI, eventName: "AnswerUpdated", data: l.data, topics: l.topics });
  return {
    ...base(log, chainId),
    eventType: "ChainlinkAnswerUpdated",
    current:   d.args.current   as bigint,
    roundId:   d.args.roundId   as bigint,
    updatedAt: d.args.updatedAt as bigint,
  };
}

// ── Main dispatcher ───────────────────────────────────────────────────────────

/**
 * Decode one raw log into a typed DecodedEvent.
 *
 * @param poolIdToToken  Mutable map updated in-place when PoolCreated is decoded,
 *                       so subsequent events in the same batch can resolve tokenAddress.
 * @param dynamicManagers  Set of dynamically discovered manager addresses (lowercase).
 * @param knownTokens    Set of known token addresses (lowercase) for ERC-20 filtering.
 */
export function decodeLog(
  log:            RawLog,
  chainId:        number,
  poolIdToToken:  Map<string, string>,
  dynamicManagers: Set<string>,
  knownTokens:    Set<string>,
): DecodedEvent | null {
  if (!log.topics || log.topics.length === 0) return null;

  const topic0  = log.topics[0];
  const address = log.address.toLowerCase();

  try {
    // ── PoolCreated variants ────────────────────────────────────────────────
    if (topic0 === EVENT_TOPICS.PoolCreatedV1 && PM_V1_SET.has(address)) {
      const e = decodePoolCreatedV1(log, chainId);
      poolIdToToken.set(e.poolId.toLowerCase(), e.tokenAddress.toLowerCase());
      return e;
    }
    if (topic0 === EVENT_TOPICS.PoolCreatedV11 && PM_V11_SET.has(address)) {
      const e = decodePoolCreatedV11(log, chainId);
      poolIdToToken.set(e.poolId.toLowerCase(), e.tokenAddress.toLowerCase());
      return e;
    }
    if (topic0 === EVENT_TOPICS.PoolCreatedAny && ANY_PM_SET.has(address)) {
      const e = decodePoolCreatedAny(log, chainId);
      poolIdToToken.set(e.poolId.toLowerCase(), e.tokenAddress.toLowerCase());
      return e;
    }

    // ── Pool events (any PM address) ────────────────────────────────────────
    if (topic0 === EVENT_TOPICS.PoolSwap)
      return decodePoolSwap(log, chainId, poolIdToToken);
    if (topic0 === EVENT_TOPICS.PoolStateUpdated)
      return decodePoolStateUpdated(log, chainId);
    if (topic0 === EVENT_TOPICS.PoolFeesDistributed)
      return decodePoolFeesDistributed(log, chainId, poolIdToToken);

    // ── FairLaunch ──────────────────────────────────────────────────────────
    if (topic0 === EVENT_TOPICS.FairLaunchCreated && FAIR_LAUNCH_SET.has(address))
      return decodeFairLaunchCreated(log, chainId);
    if (topic0 === EVENT_TOPICS.FairLaunchEnded && FAIR_LAUNCH_SET.has(address))
      return decodeFairLaunchEnded(log, chainId);
    if (topic0 === EVENT_TOPICS.FairLaunchBurn && PM_V11_SET.has(address))
      return decodeFairLaunchBurn(log, chainId);

    // ── BidWall ─────────────────────────────────────────────────────────────
    if (BID_WALL_SET.has(address)) {
      if (topic0 === EVENT_TOPICS.BidWallInitialized)  return decodeBidWallInitialized(log, chainId);
      if (topic0 === EVENT_TOPICS.BidWallRepositioned) return decodeBidWallRepositioned(log, chainId);
      if (topic0 === EVENT_TOPICS.BidWallDeposit)      return decodeBidWallDeposit(log, chainId);
      if (topic0 === EVENT_TOPICS.BidWallClosed)       return decodeBidWallClosed(log, chainId);
    }

    // ── FeeEscrow ───────────────────────────────────────────────────────────
    if (FEE_ESCROW_SET.has(address)) {
      if (topic0 === EVENT_TOPICS.FeeEscrowDeposit)    return decodeFeeEscrowDeposit(log, chainId);
      if (topic0 === EVENT_TOPICS.FeeEscrowWithdrawal) return decodeFeeEscrowWithdrawal(log, chainId);
    }

    // ── TreasuryManagerFactory ──────────────────────────────────────────────
    if (topic0 === EVENT_TOPICS.ManagerDeployed && TREASURY_FACTORY_SET.has(address))
      return decodeManagerDeployed(log, chainId);

    // ── Dynamic manager events ──────────────────────────────────────────────
    if (dynamicManagers.has(address)) {
      if (topic0 === EVENT_TOPICS.ManagerInitializedFeeSplit)
        return decodeManagerInitializedFeeSplit(log, chainId);
      if (topic0 === EVENT_TOPICS.ManagerInitializedStaking)
        return decodeManagerInitializedStaking(log, chainId);
      if (topic0 === EVENT_TOPICS.ManagerInitializedRevenue)
        return decodeManagerInitializedRevenue(log, chainId);
      if (topic0 === EVENT_TOPICS.RevenueClaimed)
        return decodeRevenueClaimed(log, chainId);
      if (topic0 === EVENT_TOPICS.RevenueManagerClaimed)
        return decodeRevenueManagerClaimed(log, chainId);
      if (topic0 === EVENT_TOPICS.TreasuryEscrowed)
        return decodeTreasuryEscrowed(log, chainId);
      if (topic0 === EVENT_TOPICS.TreasuryReclaimed)
        return decodeTreasuryReclaimed(log, chainId);
      if (topic0 === EVENT_TOPICS.CreatorUpdated)
        return decodeCreatorUpdated(log, chainId);
    }

    // ── Chainlink ───────────────────────────────────────────────────────────
    if (topic0 === EVENT_TOPICS.AnswerUpdated && address === CHAINLINK_ADDRESS)
      return decodeChainlinkAnswerUpdated(log, chainId);

    // ── ERC-721: 4 topics (from indexed, to indexed, tokenId indexed) ───────
    if (topic0 === EVENT_TOPICS.ERC20Transfer && log.topics.length === 4 && FLAUNCH_NFT_SET.has(address))
      return decodeERC721Transfer(log, chainId);

    // ── ERC-20: 3 topics (from indexed, to indexed) ─────────────────────────
    if (topic0 === EVENT_TOPICS.ERC20Transfer && log.topics.length === 3 && knownTokens.has(address))
      return decodeERC20Transfer(log, chainId);

    return null;
  } catch (err) {
    logger.warn({ err, topic: topic0, address }, "Failed to decode event log");
    return null;
  }
}
