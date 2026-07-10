import "server-only";

import { pingDb } from "@/lib/db/connection";
import { loadEnvironment } from "@/lib/env";
import { logger } from "@/lib/logging/logger";
import { pingRedis, getRedisRuntimeState } from "@/lib/redis/client";

const HEALTH_TIMEOUT_MS = 2_500;

export interface HealthCheckResult {
  ok: boolean;
  latencyMs: number;
  detail?: string;
}

export interface PlatformHealthReport {
  status: "healthy" | "unhealthy";
  timestamp: string;
  checks: {
    mongo: HealthCheckResult;
    redis: HealthCheckResult;
  };
}

async function withTimeout<T>(
  label: string,
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ ok: true; value: T; latencyMs: number } | { ok: false; latencyMs: number; detail: string }> {
  const startedAt = Date.now();
  try {
    const value = await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
    return { ok: true, value, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      detail: error instanceof Error ? error.message : `${label} failed`,
    };
  }
}

export async function getPlatformHealthReport(): Promise<PlatformHealthReport> {
  const timestamp = new Date().toISOString();
  const [mongoResult, redisResult] = await Promise.all([
    withTimeout("mongo", pingDb(), HEALTH_TIMEOUT_MS),
    withTimeout("redis", pingRedis(), HEALTH_TIMEOUT_MS),
  ]);

  const mongo: HealthCheckResult = mongoResult.ok
    ? { ok: true, latencyMs: mongoResult.latencyMs }
    : { ok: false, latencyMs: mongoResult.latencyMs, detail: mongoResult.detail };

  const redisState = getRedisRuntimeState();
  const redis: HealthCheckResult = redisResult.ok
    ? { ok: true, latencyMs: redisResult.latencyMs, detail: redisState.mode }
    : {
        ok: false,
        latencyMs: redisResult.latencyMs,
        detail: redisResult.detail ?? redisState.lastError ?? "Redis unavailable",
      };

  const healthy = mongo.ok && redis.ok;
  if (!healthy) {
    logger.warn("Platform health check degraded", {
      mongoOk: mongo.ok,
      redisOk: redis.ok,
      nodeEnv: loadEnvironment().NODE_ENV,
    });
  }

  return {
    status: healthy ? "healthy" : "unhealthy",
    timestamp,
    checks: { mongo, redis },
  };
}
