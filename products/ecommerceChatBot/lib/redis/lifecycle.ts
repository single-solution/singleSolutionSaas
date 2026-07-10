import { getRedisRuntimeState, type RedisRuntimeState } from "@/lib/redis/client";

export interface RedisLifecycleSnapshot {
  runtime: RedisRuntimeState;
  checkedAt: number;
}

export function getRedisLifecycleSnapshot(): RedisLifecycleSnapshot {
  return {
    runtime: getRedisRuntimeState(),
    checkedAt: Date.now(),
  };
}
