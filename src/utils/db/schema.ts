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
        total_supply     NUMERIC,
        name             TEXT,
        symbol           TEXT,
        discovered_block BIGINT       NOT NULL,
        discovered_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
      ALTER TABLE token_registry ADD COLUMN IF NOT EXISTS name   TEXT;
      ALTER TABLE token_registry ADD COLUMN IF NOT EXISTS symbol TEXT;
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
        amount0_eth      NUMERIC      NOT NULL,
        amount1_tokens   NUMERIC      NOT NULL,
        price_eth        NUMERIC      NOT NULL,
        price_usd        NUMERIC,
        is_buy           BOOLEAN      NOT NULL,
        chain_id         INTEGER      NOT NULL,
        indexed_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
      -- Make previously NOT NULL columns optional (safe to run repeatedly)
      ALTER TABLE trades ALTER COLUMN sender      DROP NOT NULL;
      ALTER TABLE trades ALTER COLUMN recipient   DROP NOT NULL;
      ALTER TABLE trades ALTER COLUMN fee_eth     DROP NOT NULL;
      ALTER TABLE trades ALTER COLUMN phase       DROP NOT NULL;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS sender      TEXT;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS recipient   TEXT;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS fee_eth     NUMERIC;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS phase       TEXT;
      CREATE INDEX IF NOT EXISTS idx_trades_token
        ON trades (token_address, block_timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_trades_block
        ON trades (block_number);

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
        id                TEXT         PRIMARY KEY,
        block_number      BIGINT       NOT NULL,
        block_timestamp   BIGINT       NOT NULL,
        tx_hash           TEXT         NOT NULL,
        token_address     TEXT         NOT NULL,
        pool_id           TEXT         NOT NULL,
        donate_amount     NUMERIC      NOT NULL DEFAULT 0,
        creator_amount    NUMERIC      NOT NULL DEFAULT 0,
        bid_wall_amount   NUMERIC      NOT NULL DEFAULT 0,
        governance_amount NUMERIC      NOT NULL DEFAULT 0,
        protocol_amount   NUMERIC      NOT NULL DEFAULT 0,
        chain_id          INTEGER      NOT NULL
      );
      -- Drop old NOT NULL constraint on fee_receiver if it exists
      ALTER TABLE fee_distributions ALTER COLUMN fee_receiver DROP NOT NULL;
      -- Add new columns
      ALTER TABLE fee_distributions ADD COLUMN IF NOT EXISTS donate_amount     NUMERIC NOT NULL DEFAULT 0;
      ALTER TABLE fee_distributions ADD COLUMN IF NOT EXISTS creator_amount    NUMERIC NOT NULL DEFAULT 0;
      ALTER TABLE fee_distributions ADD COLUMN IF NOT EXISTS bid_wall_amount   NUMERIC NOT NULL DEFAULT 0;
      ALTER TABLE fee_distributions ADD COLUMN IF NOT EXISTS governance_amount NUMERIC NOT NULL DEFAULT 0;
      ALTER TABLE fee_distributions ADD COLUMN IF NOT EXISTS protocol_amount   NUMERIC NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS idx_fee_distributions_token
        ON fee_distributions (token_address, block_timestamp DESC);

      -- ── Fee escrow withdrawals ───────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS fee_escrow_withdrawals (
        id              TEXT         PRIMARY KEY,
        block_number    BIGINT       NOT NULL,
        block_timestamp BIGINT       NOT NULL,
        tx_hash         TEXT         NOT NULL,
        sender          TEXT         NOT NULL,
        recipient       TEXT         NOT NULL,
        token           TEXT         NOT NULL,
        amount          NUMERIC      NOT NULL,
        chain_id        INTEGER      NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_fee_escrow_withdrawals_recipient
        ON fee_escrow_withdrawals (recipient, block_timestamp DESC);

      -- ── Dynamic manager registry ─────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS dynamic_managers (
        manager_address  TEXT         PRIMARY KEY,
        implementation   TEXT         NOT NULL,
        manager_type     TEXT,
        discovered_block BIGINT       NOT NULL,
        discovered_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );

      -- ── Fair launch info ─────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS fair_launch_info (
        pool_id        TEXT         PRIMARY KEY,
        tokens         NUMERIC      NOT NULL,
        starts_at      BIGINT       NOT NULL,
        ends_at        BIGINT       NOT NULL,
        ended_at       BIGINT,
        revenue        NUMERIC,
        supply         NUMERIC,
        chain_id       INTEGER      NOT NULL
      );

    `);
  } finally {
    client.release();
  }
}
