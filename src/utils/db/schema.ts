import type { Pool } from "pg";

export async function bootstrapSchema(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`

      -- ── Sync checkpoint ────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS sync_checkpoints (
        chain_id              INTEGER      PRIMARY KEY,
        last_finalized_block  BIGINT       NOT NULL DEFAULT 0,
        last_finalized_hash   TEXT         NOT NULL DEFAULT '0x',
        updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );

      -- ── Block headers ───────────────────────────────────────────────────────
      -- Every confirmed block stored for reorg parent-hash comparison.
      CREATE TABLE IF NOT EXISTS block_headers (
        block_number     BIGINT       PRIMARY KEY,
        block_hash       TEXT         NOT NULL UNIQUE,
        parent_hash      TEXT         NOT NULL,
        block_timestamp  BIGINT       NOT NULL,
        chain_id         INTEGER      NOT NULL,
        created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_block_headers_hash
        ON block_headers (block_hash);

      -- ── Token registry ──────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS token_registry (
        token_address    TEXT         PRIMARY KEY,
        pool_id          TEXT         NOT NULL,
        creator          TEXT         NOT NULL,
        nft_id           BIGINT       NOT NULL,
        pm_address       TEXT         NOT NULL,
        discovered_block BIGINT       NOT NULL,
        discovered_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_token_registry_pool
        ON token_registry (pool_id);

      -- ── Trades ─────────────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS trades (
        id               TEXT         PRIMARY KEY,
        block_number     BIGINT       NOT NULL,
        block_hash       TEXT         NOT NULL,
        block_timestamp  BIGINT       NOT NULL,
        tx_hash          TEXT         NOT NULL,
        token_address    TEXT         NOT NULL,
        pool_id          TEXT         NOT NULL,
        sender           TEXT         NOT NULL,
        recipient        TEXT         NOT NULL,
        amount0_eth      NUMERIC      NOT NULL,
        amount1_tokens   NUMERIC      NOT NULL,
        price_eth        NUMERIC      NOT NULL,
        price_usd        NUMERIC,
        fee_eth          NUMERIC      NOT NULL,
        is_buy           BOOLEAN      NOT NULL,
        phase            TEXT         NOT NULL,
        chain_id         INTEGER      NOT NULL,
        indexed_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_trades_token
        ON trades (token_address, block_timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_trades_block
        ON trades (block_number);
      CREATE INDEX IF NOT EXISTS idx_trades_recipient
        ON trades (recipient);

      -- ── OHLCV candles ───────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS candles (
        token_address  TEXT     NOT NULL,
        resolution     TEXT     NOT NULL,
        bucket_time    BIGINT   NOT NULL,
        open_eth       NUMERIC  NOT NULL,
        high_eth       NUMERIC  NOT NULL,
        low_eth        NUMERIC  NOT NULL,
        close_eth      NUMERIC  NOT NULL,
        volume_eth     NUMERIC  NOT NULL DEFAULT 0,
        trade_count    INTEGER  NOT NULL DEFAULT 0,
        PRIMARY KEY (token_address, resolution, bucket_time)
      );
      CREATE INDEX IF NOT EXISTS idx_candles_lookup
        ON candles (token_address, resolution, bucket_time DESC);

      -- ── Positions (WAC) ─────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS positions (
        wallet_address   TEXT        NOT NULL,
        token_address    TEXT        NOT NULL,
        balance          NUMERIC     NOT NULL DEFAULT 0,
        cost_basis_eth   NUMERIC     NOT NULL DEFAULT 0,
        realized_pnl_eth NUMERIC     NOT NULL DEFAULT 0,
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (wallet_address, token_address)
      );
      CREATE INDEX IF NOT EXISTS idx_positions_wallet
        ON positions (wallet_address);

      -- ── Fee distributions ───────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS fee_distributions (
        id               TEXT         PRIMARY KEY,
        block_number     BIGINT       NOT NULL,
        block_timestamp  BIGINT       NOT NULL,
        tx_hash          TEXT         NOT NULL,
        token_address    TEXT         NOT NULL,
        pool_id          TEXT         NOT NULL,
        total_fee_eth    NUMERIC      NOT NULL,
        creator_fee_eth  NUMERIC      NOT NULL,
        protocol_fee_eth NUMERIC      NOT NULL,
        fee_receiver     TEXT         NOT NULL,
        chain_id         INTEGER      NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_fee_distributions_token
        ON fee_distributions (token_address, block_timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_fee_distributions_receiver
        ON fee_distributions (fee_receiver);

      -- ── Fees claimed ────────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS fees_claimed (
        id               TEXT         PRIMARY KEY,
        block_number     BIGINT       NOT NULL,
        block_timestamp  BIGINT       NOT NULL,
        tx_hash          TEXT         NOT NULL,
        token_address    TEXT         NOT NULL,
        claimant         TEXT         NOT NULL,
        amount_eth       NUMERIC      NOT NULL,
        chain_id         INTEGER      NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_fees_claimed_claimant
        ON fees_claimed (claimant, block_timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_fees_claimed_token
        ON fees_claimed (token_address, block_timestamp DESC);

    `);
  } finally {
    client.release();
  }
}