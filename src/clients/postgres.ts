import { Pool } from "pg";

export function makePool(connectionString: string, min = 2, max = 20): Pool {
  const pool = new Pool({
    connectionString,
    min,
    max,
    idleTimeoutMillis:       30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout:       30_000, // kill queries running longer than 30s
  });
  pool.on("error", (err) => console.error("[postgres] idle client error:", err));
  return pool;
}