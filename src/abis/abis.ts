// src/abis/abis.ts

import { parseAbi, keccak256, toHex } from "viem";

export const POSITION_MANAGER_ABI = parseAbi([
  "event PoolCreated(bytes32 indexed id, address indexed token, address creator, uint256 nftId, address fairLaunch, address bidWall, uint160 sqrtPriceX96)",
  "event PoolSwap(bytes32 indexed id, address indexed token, address indexed sender, address recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint256 fee, uint8 phase)",
  "event PoolStateUpdated(bytes32 indexed id, address indexed token, uint160 sqrtPriceX96, int24 tick, uint128 liquidity)",
  "event PoolFeesDistributed(bytes32 indexed id, address indexed token, uint256 totalFee, uint256 creatorFee, uint256 communityFee, uint256 bidWallFee, uint256 governanceFee, uint256 protocolFee, address feeReceiver)",
]);

export const FAIR_LAUNCH_ABI = parseAbi([
  "event FairLaunchCreated(address indexed token, address indexed fairLaunch, uint256 targetRaise, uint256 duration)",
]);

export const BID_WALL_ABI = parseAbi([
  "event BidWallUpdated(address indexed token, address indexed bidWall, uint256 floorPrice, uint256 totalLiquidity)",
]);

export const FEE_ESCROW_ABI = parseAbi([
  "event FeesClaimed(address indexed token, address indexed claimant, uint256 amount)",
]);

export const ERC20_ABI = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export const ERC721_ABI = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);

export const CHAINLINK_ABI = parseAbi([
  "event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)",
]);

function sig(s: string): `0x${string}` {
  return keccak256(toHex(s));
}

export const EVENT_TOPICS = {
  PoolCreated:         sig("PoolCreated(bytes32,address,address,uint256,address,address,uint160)"),
  PoolSwap:            sig("PoolSwap(bytes32,address,address,address,int256,int256,uint160,uint128,int24,uint256,uint8)"),
  PoolStateUpdated:    sig("PoolStateUpdated(bytes32,address,uint160,int24,uint128)"),
  PoolFeesDistributed: sig("PoolFeesDistributed(bytes32,address,uint256,uint256,uint256,uint256,uint256,uint256,address)"),
  FairLaunchCreated:   sig("FairLaunchCreated(address,address,uint256,uint256)"),
  BidWallUpdated:      sig("BidWallUpdated(address,address,uint256,uint256)"),
  FeesClaimed:         sig("FeesClaimed(address,address,uint256)"),
  ERC20Transfer:       sig("Transfer(address,address,uint256)"),
  AnswerUpdated:       sig("AnswerUpdated(int256,uint256,uint256)"),
} as const;

export type EventTopicKey = keyof typeof EVENT_TOPICS;

export const WATCHED_TOPICS = new Set(Object.values(EVENT_TOPICS));