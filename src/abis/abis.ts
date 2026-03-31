// src/abis/abis.ts

import { parseAbi, keccak256, toHex } from "viem";

// ── Shared pool events (identical across all PM versions) ─────────────────────

export const POOL_SWAP_ABI = parseAbi([
  "event PoolSwap(bytes32 indexed poolId, int256 flAmount0, int256 flAmount1, int256 flFee0, int256 flFee1, int256 ispAmount0, int256 ispAmount1, int256 ispFee0, int256 ispFee1, int256 uniAmount0, int256 uniAmount1, int256 uniFee0, int256 uniFee1)",
]);

export const POOL_STATE_UPDATED_ABI = parseAbi([
  "event PoolStateUpdated(bytes32 indexed _poolId, uint160 _sqrtPriceX96, int24 _tick, uint24 _protocolFee, uint24 _swapFee, uint128 _liquidity)",
]);

export const POOL_FEES_DISTRIBUTED_ABI = parseAbi([
  "event PoolFeesDistributed(bytes32 indexed _poolId, uint256 _donateAmount, uint256 _creatorAmount, uint256 _bidWallAmount, uint256 _governanceAmount, uint256 _protocolAmount)",
]);

// ── PositionManager v1 (10-field params tuple) ────────────────────────────────

export const POSITION_MANAGER_V1_ABI = parseAbi([
  "event PoolCreated(bytes32 indexed _poolId, address _memecoin, address _memecoinTreasury, uint256 _tokenId, bool _currencyFlipped, uint256 _flaunchFee, (string name, string symbol, string tokenUri, uint256 initialTokenFairLaunch, uint256 premineAmount, address creator, uint24 creatorFeeAllocation, uint256 flaunchAt, bytes initialPriceParams, bytes feeCalculatorParams) _params)",
]);

// ── PositionManager v1.1 / v1.1.1 / v1.1.4 (11-field params tuple) ───────────

export const POSITION_MANAGER_V11_ABI = parseAbi([
  "event PoolCreated(bytes32 indexed _poolId, address _memecoin, address _memecoinTreasury, uint256 _tokenId, bool _currencyFlipped, uint256 _flaunchFee, (string name, string symbol, string tokenUri, uint256 initialTokenFairLaunch, uint256 fairLaunchDuration, uint256 premineAmount, address creator, uint24 creatorFeeAllocation, uint256 flaunchAt, bytes initialPriceParams, bytes feeCalculatorParams) _params)",
  "event FairLaunchBurn(bytes32 indexed _poolId, uint256 _unsoldSupply)",
]);

// ── AnyPositionManager (5-field params tuple) ─────────────────────────────────

export const ANY_POSITION_MANAGER_ABI = parseAbi([
  "event PoolCreated(bytes32 indexed _poolId, address _memecoin, address _memecoinTreasury, uint256 _tokenId, bool _currencyFlipped, (address memecoin, address creator, uint24 creatorFeeAllocation, bytes initialPriceParams, bytes feeCalculatorParams) _params)",
]);

// ── FairLaunch ────────────────────────────────────────────────────────────────

export const FAIR_LAUNCH_ABI = parseAbi([
  "event FairLaunchCreated(bytes32 indexed _poolId, uint256 _tokens, uint256 _startsAt, uint256 _endsAt)",
  "event FairLaunchEnded(bytes32 indexed _poolId, uint256 _revenue, uint256 _supply, uint256 _endedAt)",
]);

// ── BidWall ───────────────────────────────────────────────────────────────────

export const BID_WALL_ABI = parseAbi([
  "event BidWallInitialized(bytes32 indexed _poolId, uint256 _eth, int24 _tickLower, int24 _tickUpper)",
  "event BidWallRepositioned(bytes32 indexed _poolId, uint256 _eth, int24 _tickLower, int24 _tickUpper)",
  "event BidWallDeposit(bytes32 indexed _poolId, uint256 _added, uint256 _pending)",
  "event BidWallClosed(bytes32 indexed _poolId, address _recipient, uint256 _eth)",
  "event BidWallRewardsTransferred(bytes32 indexed _poolId, address _recipient, uint256 _tokens)",
  "event BidWallDisabledStateUpdated(bytes32 indexed _poolId, bool _disabled)",
]);

// ── FeeEscrow ─────────────────────────────────────────────────────────────────

export const FEE_ESCROW_ABI = parseAbi([
  "event Deposit(bytes32 indexed _poolId, address _payee, address _token, uint256 _amount)",
  "event Withdrawal(address _sender, address _recipient, address _token, uint256 _amount)",
]);

// ── TreasuryManagerFactory ────────────────────────────────────────────────────

export const TREASURY_MANAGER_FACTORY_ABI = parseAbi([
  "event ManagerDeployed(address indexed _manager, address indexed _managerImplementation)",
]);

// ── AddressFeeSplitManager ────────────────────────────────────────────────────

export const ADDRESS_FEE_SPLIT_MANAGER_ABI = parseAbi([
  "event ManagerInitialized(address _owner, (uint256 creatorShare, uint256 ownerShare, (address recipient, uint256 share)[] recipientShares) _params)",
  "event RecipientAdded(address indexed _recipient, uint256 _share)",
  "event RecipientShareTransferred(address indexed _oldRecipient, address indexed _newRecipient, uint256 _share)",
  "event RevenueClaimed(address indexed _recipient, uint256 _amountClaimed)",
  "event TreasuryEscrowed(address indexed _flaunch, uint256 indexed _tokenId, address _owner, address _sender)",
  "event TreasuryReclaimed(address indexed _flaunch, uint256 indexed _tokenId, address _sender, address _recipient)",
  "event CreatorUpdated(address indexed _flaunch, uint256 indexed _tokenId, address _creator)",
  "event ManagerOwnershipTransferred(address indexed _previousOwner, address indexed _newOwner)",
]);

// ── StakingManager ────────────────────────────────────────────────────────────

export const STAKING_MANAGER_ABI = parseAbi([
  "event ManagerInitialized(address _owner, (address stakingToken, uint256 minEscrowDuration, uint256 minStakeDuration, uint256 creatorShare, uint256 ownerShare) _params)",
  "event Stake(address _sender, uint256 _amount, (uint256 amount, uint256 timelockedUntil, uint256 ethRewardsPerTokenSnapshotX128, uint256 ethOwed) _position)",
  "event Unstake(address _sender, uint256 _amount, (uint256 amount, uint256 timelockedUntil, uint256 ethRewardsPerTokenSnapshotX128, uint256 ethOwed) _position)",
  "event Claim(address _sender, uint256 _amount)",
  "event TreasuryEscrowed(address indexed _flaunch, uint256 indexed _tokenId, address _owner, address _sender)",
  "event TreasuryReclaimed(address indexed _flaunch, uint256 indexed _tokenId, address _sender, address _recipient)",
  "event CreatorUpdated(address indexed _flaunch, uint256 indexed _tokenId, address _creator)",
  "event ManagerOwnershipTransferred(address indexed _previousOwner, address indexed _newOwner)",
]);

// ── RevenueManager ────────────────────────────────────────────────────────────

export const REVENUE_MANAGER_ABI = parseAbi([
  "event ManagerInitialized(address _owner, (address protocolRecipient, uint256 protocolFee) _params)",
  "event RevenueClaimed(address indexed _flaunch, uint256 indexed _tokenId, address _recipient, uint256 _amount)",
  "event TreasuryEscrowed(address indexed _flaunch, uint256 indexed _tokenId, address _owner, address _sender)",
  "event TreasuryReclaimed(address indexed _flaunch, uint256 indexed _tokenId, address _sender, address _recipient)",
  "event CreatorUpdated(address indexed _flaunch, uint256 indexed _tokenId, address _creator)",
  "event ManagerOwnershipTransferred(address indexed _previousOwner, address indexed _newOwner)",
]);

// ── Token standards ───────────────────────────────────────────────────────────

export const ERC20_ABI = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export const ERC20_METADATA_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
]);

export const ERC721_ABI = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);

export const CHAINLINK_ABI = parseAbi([
  "event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)",
]);

// ── Topic hashes ──────────────────────────────────────────────────────────────

function sig(s: string): `0x${string}` {
  return keccak256(toHex(s));
}

export const EVENT_TOPICS = {
  // Three PoolCreated variants — different canonical signatures → different hashes
  PoolCreatedV1:  sig("PoolCreated(bytes32,address,address,uint256,bool,uint256,(string,string,string,uint256,uint256,address,uint24,uint256,bytes,bytes))"),
  PoolCreatedV11: sig("PoolCreated(bytes32,address,address,uint256,bool,uint256,(string,string,string,uint256,uint256,uint256,address,uint24,uint256,bytes,bytes))"),
  PoolCreatedAny: sig("PoolCreated(bytes32,address,address,uint256,bool,(address,address,uint24,bytes,bytes))"),

  PoolSwap:            sig("PoolSwap(bytes32,int256,int256,int256,int256,int256,int256,int256,int256,int256,int256,int256,int256)"),
  PoolStateUpdated:    sig("PoolStateUpdated(bytes32,uint160,int24,uint24,uint24,uint128)"),
  PoolFeesDistributed: sig("PoolFeesDistributed(bytes32,uint256,uint256,uint256,uint256,uint256)"),

  FairLaunchCreated: sig("FairLaunchCreated(bytes32,uint256,uint256,uint256)"),
  FairLaunchEnded:   sig("FairLaunchEnded(bytes32,uint256,uint256,uint256)"),
  FairLaunchBurn:    sig("FairLaunchBurn(bytes32,uint256)"),

  BidWallInitialized:  sig("BidWallInitialized(bytes32,uint256,int24,int24)"),
  BidWallRepositioned: sig("BidWallRepositioned(bytes32,uint256,int24,int24)"),
  BidWallDeposit:      sig("BidWallDeposit(bytes32,uint256,uint256)"),
  BidWallClosed:       sig("BidWallClosed(bytes32,address,uint256)"),

  FeeEscrowDeposit:    sig("Deposit(bytes32,address,address,uint256)"),
  FeeEscrowWithdrawal: sig("Withdrawal(address,address,address,uint256)"),

  ManagerDeployed:            sig("ManagerDeployed(address,address)"),
  ManagerInitializedFeeSplit: sig("ManagerInitialized(address,(uint256,uint256,(address,uint256)[]))"),
  ManagerInitializedStaking:  sig("ManagerInitialized(address,(address,uint256,uint256,uint256,uint256))"),
  ManagerInitializedRevenue:  sig("ManagerInitialized(address,(address,uint256))"),

  // RevenueClaimed has two different signatures in different contracts
  RevenueClaimed:        sig("RevenueClaimed(address,uint256)"),             // AddressFeeSplitManager
  RevenueManagerClaimed: sig("RevenueClaimed(address,uint256,address,uint256)"), // RevenueManager

  TreasuryEscrowed:  sig("TreasuryEscrowed(address,uint256,address,address)"),
  TreasuryReclaimed: sig("TreasuryReclaimed(address,uint256,address,address)"),
  CreatorUpdated:    sig("CreatorUpdated(address,uint256,address)"),

  ERC20Transfer: sig("Transfer(address,address,uint256)"),
  AnswerUpdated: sig("AnswerUpdated(int256,uint256,uint256)"),
} as const;

export type EventTopicKey = keyof typeof EVENT_TOPICS;

export const WATCHED_TOPICS = new Set(Object.values(EVENT_TOPICS));
