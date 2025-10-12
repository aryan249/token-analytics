import type { Pool } from "pg";

export interface TradeRow {
  id:             string;
  blockNumber:    bigint;
  blockHash:      string;
  blockTimestamp: bigint;
  txHash:         string;
  tokenAddress:   string;
  poolId:         string;
  amount0Eth:     bigint;
  amount1Tokens:  bigint;
  priceEth:       bigint;
  priceUsd:       number | null;
  isBuy:          boolean;
  chainId:        number;
}

export async function insertTrade(pool: Pool, trade: TradeRow): Promise<void> {
  await pool.query(
    `INSERT INTO trades (
       id, block_number, block_hash, block_timestamp, tx_hash,
       token_address, pool_id,
       amount0_eth, amount1_tokens, price_eth, price_usd,
       is_buy, chain_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (id) DO NOTHING`,
    [
      trade.id,
      trade.blockNumber.toString(),
      trade.blockHash,
      trade.blockTimestamp.toString(),
      trade.txHash,
      trade.tokenAddress.toLowerCase(),
      trade.poolId,
      trade.amount0Eth.toString(),
      trade.amount1Tokens.toString(),
      trade.priceEth.toString(),
      trade.priceUsd,
      trade.isBuy,
      trade.chainId,
    ]
  );
}

export async function deleteTradesAboveBlock(
  pool: Pool, blockNumber: bigint
): Promise<void> {
  await pool.query(
    "DELETE FROM trades WHERE block_number > $1",
    [blockNumber.toString()]
  );
}
