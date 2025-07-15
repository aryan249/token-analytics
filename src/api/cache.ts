import type { RedisClient } from "../clients/redis";

export async function withCache<T>(
  redis:      RedisClient,
  key:        string,
  ttlSeconds: number,
  fetch:      () => Promise<T>,
): Promise<T> {
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached) as T;
  const data = await fetch();
  await redis.setEx(key, ttlSeconds, JSON.stringify(data));
  return data;
}

export function invalidate(redis: RedisClient, key: string): Promise<number> {
  return redis.del(key);
}
