import type { RedisClient } from "../clients/redis";

const LOCK_TTL = 5; // seconds
const LOCK_RETRY_DELAY = 50; // ms
const LOCK_MAX_RETRIES = 100; // 50ms * 100 = 5s max wait

/**
 * Cache-aside with stampede lock.
 *
 * 1. Check cache → hit: return immediately
 * 2. Cache miss → try to acquire a Redis lock (SET NX EX)
 * 3. Lock acquired → fetch from DB, write cache, release lock
 * 4. Lock not acquired → another request is fetching, poll cache until data appears
 *
 * This prevents thundering herd: only 1 request hits the DB per cache key expiry.
 */
export async function withCache<T>(
  redis:      RedisClient,
  key:        string,
  ttlSeconds: number,
  fetch:      () => Promise<T>,
): Promise<T> {
  // 1. Check cache
  const cached = await redis.get(key);
  if (cached !== null) return JSON.parse(cached) as T;

  // 2. Try to acquire lock
  const lockKey = `lock:${key}`;
  const acquired = await redis.set(lockKey, "1", { NX: true, EX: LOCK_TTL });

  if (acquired) {
    // 3. We hold the lock — fetch and populate cache
    try {
      const data = await fetch();
      await redis.setEx(key, ttlSeconds, JSON.stringify(data));
      return data;
    } finally {
      await redis.del(lockKey);
    }
  }

  // 4. Another request is fetching — wait for cache to be populated
  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    await new Promise((r) => setTimeout(r, LOCK_RETRY_DELAY));
    const result = await redis.get(key);
    if (result !== null) return JSON.parse(result) as T;
  }

  // 5. Timeout — lock holder may have failed. Fetch directly as fallback.
  const data = await fetch();
  await redis.setEx(key, ttlSeconds, JSON.stringify(data));
  return data;
}

export function invalidate(redis: RedisClient, key: string): Promise<number> {
  return redis.del(key);
}
