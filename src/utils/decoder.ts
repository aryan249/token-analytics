// src/processor/decoder.ts
// Pure function: RawLog → DecodedEvent | null. No I/O.

import { decodeEventLog, type Hash, type Address } from "viem";
import {
  POSITION_MANAGER_ABI, FAIR_LAUNCH_ABI, BID_WALL_ABI,
  FEE_ESCROW_ABI, ERC20_ABI, ERC721_ABI, CHAINLINK_ABI,
  EVENT_TOPICS,
} from "../abis/abis";
import {
  FLAUNCH_NFT_SET, FEE_ESCROW_SET, FAIR_LAUNCH_SET,
  BID_WALL_SET, CHAINLINK_ADDRESS,
} from "../contracts/contracts";
import type {
  RawLog, DecodedEvent,
  PoolCreatedEvent, PoolSwapEvent, PoolStateUpdatedEvent,
  PoolFeesDistributedEvent, ERC20TransferEvent, ERC721TransferEvent,
  ChainlinkAnswerUpdatedEvent, FeesClaimedEvent,
  FairLaunchCreatedEvent, BidWallUpdatedEvent,
} from "../types/events";

const SWAP_PHASE = ["FairLaunch", "ISP", "Uniswap"] as const;

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

function decodePoolCreated(log: RawLog, chainId: number): PoolCreatedEvent {
  const l = asLog(log);
  const d = decodeEventLog({ abi: POSITION_MANAGER_ABI, eventName: "PoolCreated", data: l.data, topics: l.topics });
  return { ...base(log, chainId), eventType: "PoolCreated", tokenAddress: d.args.token as Address, poolId: d.args.id as string, creator: d.args.creator as Address, nftId: d.args.nftId as bigint, fairLaunchAddress: d.args.fairLaunch as Address, bidWallAddress: d.args.bidWall as Address, initialSqrtPriceX96: d.args.sqrtPriceX96 as bigint };
}

function decodePoolSwap(log: RawLog, chainId: number): PoolSwapEvent {
  const l = asLog(log);
  const d = decodeEventLog({ abi: POSITION_MANAGER_ABI, eventName: "PoolSwap", data: l.data, topics: l.topics });
  const phase = SWAP_PHASE[Number(d.args.phase)] ?? "Uniswap";
  return { ...base(log, chainId), eventType: "PoolSwap", tokenAddress: d.args.token as Address, poolId: d.args.id as string, sender: d.args.sender as Address, recipient: d.args.recipient as Address, amount0: d.args.amount0 as bigint, amount1: d.args.amount1 as bigint, sqrtPriceX96: d.args.sqrtPriceX96 as bigint, liquidity: d.args.liquidity as bigint, tick: Number(d.args.tick), fee: d.args.fee as bigint, isBuy: (d.args.amount0 as bigint) < 0n, phase };
}

function decodePoolStateUpdated(log: RawLog, chainId: number): PoolStateUpdatedEvent {
  const l = asLog(log);
  const d = decodeEventLog({ abi: POSITION_MANAGER_ABI, eventName: "PoolStateUpdated", data: l.data, topics: l.topics });
  return { ...base(log, chainId), eventType: "PoolStateUpdated", tokenAddress: d.args.token as Address, poolId: d.args.id as string, sqrtPriceX96: d.args.sqrtPriceX96 as bigint, tick: Number(d.args.tick), liquidity: d.args.liquidity as bigint };
}

function decodePoolFeesDistributed(log: RawLog, chainId: number): PoolFeesDistributedEvent {
  const l = asLog(log);
  const d = decodeEventLog({ abi: POSITION_MANAGER_ABI, eventName: "PoolFeesDistributed", data: l.data, topics: l.topics });
  return { ...base(log, chainId), eventType: "PoolFeesDistributed", tokenAddress: d.args.token as Address, poolId: d.args.id as string, totalFeeEth: d.args.totalFee as bigint, creatorFeeEth: d.args.creatorFee as bigint, communityFeeEth: d.args.communityFee as bigint, bidWallFeeEth: d.args.bidWallFee as bigint, governanceFeeEth: d.args.governanceFee as bigint, protocolFeeEth: d.args.protocolFee as bigint, feeReceiver: d.args.feeReceiver as Address };
}

function decodeERC20Transfer(log: RawLog, chainId: number): ERC20TransferEvent {
  const l = asLog(log);
  const d = decodeEventLog({ abi: ERC20_ABI, eventName: "Transfer", data: l.data, topics: l.topics });
  return { ...base(log, chainId), eventType: "ERC20Transfer", tokenAddress: log.address as Address, from: d.args.from as Address, to: d.args.to as Address, value: d.args.value as bigint };
}

function decodeERC721Transfer(log: RawLog, chainId: number): ERC721TransferEvent {
  const l = asLog(log);
  const d = decodeEventLog({ abi: ERC721_ABI, eventName: "Transfer", data: l.data, topics: l.topics });
  return { ...base(log, chainId), eventType: "ERC721Transfer", nftContract: log.address as Address, from: d.args.from as Address, to: d.args.to as Address, tokenId: d.args.tokenId as bigint };
}

function decodeChainlinkAnswerUpdated(log: RawLog, chainId: number): ChainlinkAnswerUpdatedEvent {
  const l = asLog(log);
  const d = decodeEventLog({ abi: CHAINLINK_ABI, eventName: "AnswerUpdated", data: l.data, topics: l.topics });
  return { ...base(log, chainId), eventType: "ChainlinkAnswerUpdated", current: d.args.current as bigint, roundId: d.args.roundId as bigint, updatedAt: d.args.updatedAt as bigint };
}

function decodeFeesClaimed(log: RawLog, chainId: number): FeesClaimedEvent {
  const l = asLog(log);
  const d = decodeEventLog({ abi: FEE_ESCROW_ABI, eventName: "FeesClaimed", data: l.data, topics: l.topics });
  return { ...base(log, chainId), eventType: "FeesClaimed", tokenAddress: d.args.token as Address, claimant: d.args.claimant as Address, amountEth: d.args.amount as bigint };
}

function decodeFairLaunchCreated(log: RawLog, chainId: number): FairLaunchCreatedEvent {
  const l = asLog(log);
  const d = decodeEventLog({ abi: FAIR_LAUNCH_ABI, eventName: "FairLaunchCreated", data: l.data, topics: l.topics });
  return { ...base(log, chainId), eventType: "FairLaunchCreated", tokenAddress: d.args.token as Address, fairLaunchAddress: d.args.fairLaunch as Address, targetRaise: d.args.targetRaise as bigint, duration: d.args.duration as bigint };
}

function decodeBidWallUpdated(log: RawLog, chainId: number): BidWallUpdatedEvent {
  const l = asLog(log);
  const d = decodeEventLog({ abi: BID_WALL_ABI, eventName: "BidWallUpdated", data: l.data, topics: l.topics });
  return { ...base(log, chainId), eventType: "BidWallUpdated", tokenAddress: d.args.token as Address, bidWallAddress: d.args.bidWall as Address, floorPrice: d.args.floorPrice as bigint, totalLiquidity: d.args.totalLiquidity as bigint };
}

export function decodeLog(
  log:         RawLog,
  chainId:     number,
  knownTokens: Set<string>
): DecodedEvent | null {
  if (!log.topics || log.topics.length === 0) return null;

  const topic0  = log.topics[0];
  const address = log.address.toLowerCase();

  try {
    if (topic0 === EVENT_TOPICS.PoolCreated)         return decodePoolCreated(log, chainId);
    if (topic0 === EVENT_TOPICS.PoolSwap)            return decodePoolSwap(log, chainId);
    if (topic0 === EVENT_TOPICS.PoolStateUpdated)    return decodePoolStateUpdated(log, chainId);
    if (topic0 === EVENT_TOPICS.PoolFeesDistributed) return decodePoolFeesDistributed(log, chainId);

    if (topic0 === EVENT_TOPICS.FairLaunchCreated && FAIR_LAUNCH_SET.has(address))
      return decodeFairLaunchCreated(log, chainId);
    if (topic0 === EVENT_TOPICS.BidWallUpdated && BID_WALL_SET.has(address))
      return decodeBidWallUpdated(log, chainId);
    if (topic0 === EVENT_TOPICS.FeesClaimed && FEE_ESCROW_SET.has(address))
      return decodeFeesClaimed(log, chainId);
    if (topic0 === EVENT_TOPICS.AnswerUpdated && address === CHAINLINK_ADDRESS)
      return decodeChainlinkAnswerUpdated(log, chainId);

    // ERC-721: 4 topics. ERC-20: 3 topics.
    if (topic0 === EVENT_TOPICS.ERC20Transfer && log.topics.length === 4 && FLAUNCH_NFT_SET.has(address))
      return decodeERC721Transfer(log, chainId);
    if (topic0 === EVENT_TOPICS.ERC20Transfer && log.topics.length === 3 && knownTokens.has(address))
      return decodeERC20Transfer(log, chainId);

    return null;
  } catch {
    return null;
  }
}