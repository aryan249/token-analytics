// src/contracts/contracts.ts

import type { Address } from "viem";

export type ContractRole =
  | "PositionManager" | "AnyPositionManager" | "FairLaunch"
  | "BidWall" | "AnyBidWall" | "FeeEscrow" | "FlaunchNFT"
  | "ChainlinkAggregator" | "TokenImporter" | "FeeExemptions"
  | "ActionManager" | "TreasuryManagerFactory";

export interface ContractEntry {
  address:      Address;
  role:         ContractRole;
  version?:     string;
  deployBlock?: bigint;
}

export const CONTRACTS: ContractEntry[] = [
  { address: "0x51Bba15255406Cfe7099a42183302640ba7dAFDC", role: "PositionManager",    version: "v1" },
  { address: "0xf785bb58059fab6fb19bdda2cb9078d9e546efdc", role: "PositionManager",    version: "v1.1" },
  { address: "0xb903b0ab7bcee8f5e4d8c9b10a71aac7135d6fdc", role: "PositionManager",    version: "v1.1.1" },
  { address: "0x23321f11a6d44fd1ab790044fdfde5758c902fdc", role: "PositionManager",    version: "v1.1.4" },
  { address: "0x2ad43d0618b1d8a0cc75cf716cf0bf64070725dc", role: "AnyPositionManager", version: "v1" },
  { address: "0x8dc3b85e1dc1c846ebf3971179a751896842e5dc", role: "AnyPositionManager", version: "v2" },
  { address: "0xCc7A4A00072ccbeEEbd999edc812C0ce498Fb63B", role: "FairLaunch",         version: "v1" },
  { address: "0x4dc442403e8c758425b93c59dc737da522f32640", role: "FairLaunch",         version: "v2" },
  { address: "0x66681f10BA90496241A25e33380004f30Dfd8aa8", role: "BidWall",            version: "v1" },
  { address: "0x7f22353d1634223a802D1c1Ea5308Ddf5DD0ef9c", role: "BidWall",            version: "v2" },
  { address: "0x2154c604df568A5285284D1c4918DC98C39240df", role: "AnyBidWall",         version: "v1" },
  { address: "0x72e6f7948b1B1A343B477F39aAbd2E35E6D27dde", role: "FeeEscrow",         version: "v1" },
  { address: "0x6A53F8b799bE11a2A3264eF0bfF183dCB12d9571", role: "FlaunchNFT",        version: "v1" },
  { address: "0xb4512bf57d50fbcb64a3adf8b17a79b2a204c18c", role: "FlaunchNFT",        version: "v1.1" },
  { address: "0x0cf6bdf0a85a9d6763361037985b76c8893553af", role: "FlaunchNFT",        version: "v1.1.1" },
  { address: "0x516af52d0c629b5e378da4dc64ecb0744ce10109", role: "FlaunchNFT",        version: "v1.1.4" },
  { address: "0xf175a370eb26ea26c42caaecd10ee723ed844c50", role: "FlaunchNFT",        version: "AnyFlaunch" },
  { address: "0xc5b2e8f197407263f4b62a35c71bfc394ecf95d5", role: "FlaunchNFT",        version: "AnyFlaunch2" },
  { address: "0x57d2d46Fc7ff2A7142d479F2f59e1E3F95447077", role: "ChainlinkAggregator" },
  { address: "0xb47af90ae61bc916ea4b4bacffae4570e7435842", role: "TokenImporter",     version: "v1" },
  { address: "0x6fb66f4fc262dc86e12136c481ba7c411e668197", role: "TokenImporter",     version: "v2" },
  { address: "0xfdCE459071c74b732B2dEC579Afb38Ea552C4e06", role: "FeeExemptions" },
  { address: "0xeC2a53F572cFD952aAA3a8359Ac54B31d0A186a4", role: "ActionManager",    version: "v1" },
  { address: "0xFB5c20c4E60c9c64648DD3692437E3E313Add4A4", role: "ActionManager",    version: "v2" },
  { address: "0x48af8b28DDC5e5A86c4906212fc35Fa808CA8763", role: "TreasuryManagerFactory" },
];

export const STATIC_CONTRACT_SET = new Set(CONTRACTS.map((c) => c.address.toLowerCase()));
export const ADDRESS_TO_ROLE     = new Map<string, ContractRole>(CONTRACTS.map((c) => [c.address.toLowerCase(), c.role]));

export const FLAUNCH_NFT_SET     = new Set(CONTRACTS.filter((c) => c.role === "FlaunchNFT").map((c) => c.address.toLowerCase()));
export const FEE_ESCROW_SET      = new Set(CONTRACTS.filter((c) => c.role === "FeeEscrow").map((c) => c.address.toLowerCase()));
export const FAIR_LAUNCH_SET     = new Set(CONTRACTS.filter((c) => c.role === "FairLaunch").map((c) => c.address.toLowerCase()));
export const BID_WALL_SET        = new Set(CONTRACTS.filter((c) => c.role === "BidWall" || c.role === "AnyBidWall").map((c) => c.address.toLowerCase()));
export const CHAINLINK_ADDRESS   = CONTRACTS.find((c) => c.role === "ChainlinkAggregator")!.address.toLowerCase();
export const TREASURY_FACTORY_SET = new Set(CONTRACTS.filter((c) => c.role === "TreasuryManagerFactory").map((c) => c.address.toLowerCase()));

// ── PositionManager version sets ──────────────────────────────────────────────

/** PM v1 only — uses 10-field params tuple */
export const PM_V1_SET = new Set(
  CONTRACTS.filter((c) => c.role === "PositionManager" && c.version === "v1")
           .map((c) => c.address.toLowerCase())
);

/** PM v1.1 / v1.1.1 / v1.1.4 — uses 11-field params tuple (adds fairLaunchDuration) */
export const PM_V11_SET = new Set(
  CONTRACTS.filter((c) => c.role === "PositionManager" && c.version !== "v1")
           .map((c) => c.address.toLowerCase())
);

/** AnyPositionManager v1 and v2 — uses 5-field params tuple */
export const ANY_PM_SET = new Set(
  CONTRACTS.filter((c) => c.role === "AnyPositionManager")
           .map((c) => c.address.toLowerCase())
);

/** All PositionManager addresses (any version) */
export const PM_ALL_SET = new Set([...PM_V1_SET, ...PM_V11_SET, ...ANY_PM_SET]);

// ── PositionManager v1 deployment block on Base mainnet ───────────────────────
export const EARLIEST_DEPLOY_BLOCK = 25689000n;
