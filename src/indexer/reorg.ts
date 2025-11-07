import type { Pool } from "pg";
import type { Hash } from "viem";
import type { BlockHeader } from "../types/events";
import { getBlockHeader, deleteBlockHeadersAbove, writeCheckpoint } from "../utils/db/checkpoint";
import { deleteTradesAboveBlock }           from "../utils/db/trades";
import { deleteCandlesAboveBlock }          from "../utils/db/candles";
import { deletePositionsAboveBlock }        from "../utils/db/positions";
import { deleteFeeDistributionsAboveBlock } from "../utils/db/fees";
import { logger }                           from "../utils/logger";

export interface ReorgResult {
  detected:            boolean;
  commonAncestorBlock: bigint | null;
}

export async function detectAndRecover(
  pool:         Pool,
  incoming:     BlockHeader,
  chainId:      number,
  getRpcHeader: (blockNumber: bigint) => Promise<BlockHeader>
): Promise<ReorgResult> {

  const storedParent = await getBlockHeader(pool, incoming.blockNumber - 1n);

  if (!storedParent) {
    return { detected: false, commonAncestorBlock: null };
  }

  if (storedParent.blockHash === incoming.parentHash) {
    return { detected: false, commonAncestorBlock: null };
  }

  logger.warn(
    { blockNumber: incoming.blockNumber.toString(), expectedParent: storedParent.blockHash, incomingParent: incoming.parentHash },
    "Reorg detected — starting backtrace"
  );

  const commonAncestor = await backtrace(pool, incoming.blockNumber - 1n, getRpcHeader);

  logger.warn({ commonAncestor: commonAncestor.toString() }, "Common ancestor found — cascade cleanup");

  await deleteTradesAboveBlock(pool, commonAncestor);
  await deleteCandlesAboveBlock(pool, commonAncestor);
  await deletePositionsAboveBlock(pool, commonAncestor);
  await deleteFeeDistributionsAboveBlock(pool, commonAncestor);
  await deleteBlockHeadersAbove(pool, commonAncestor);

  const ancestorHeader = await getBlockHeader(pool, commonAncestor);
  const ancestorHash   = ancestorHeader?.blockHash as Hash ?? "0x" as Hash;
  await writeCheckpoint(pool, chainId, commonAncestor, ancestorHash);

  logger.warn({ commonAncestor: commonAncestor.toString() }, "Reorg recovery complete");

  return { detected: true, commonAncestorBlock: commonAncestor };
}

async function backtrace(
  pool:         Pool,
  blockNumber:  bigint,
  getRpcHeader: (n: bigint) => Promise<BlockHeader>
): Promise<bigint> {
  let current = blockNumber;

  while (current > 0n) {
    const stored    = await getBlockHeader(pool, current);
    const rpcHeader = await getRpcHeader(current);

    if (!stored) { current--; continue; }

    if (stored.blockHash === rpcHeader.blockHash) return current;

    logger.debug({ block: current.toString() }, "Block is orphaned — continuing backtrace");
    current--;
  }

  return 0n;
}