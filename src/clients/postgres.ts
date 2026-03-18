// src/clients/postgres.ts

import { Pool } from "pg";

export function makePool(connectionString: string, min = 2, max = 10): Pool {
  const pool = new Pool({
    connectionString,
    min,
    max,
    idleTimeoutMillis:       30_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on("error", (err) => console.error("[postgres] idle client error:", err));
  return pool;
}