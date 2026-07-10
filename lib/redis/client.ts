import { Redis } from "@upstash/redis";

import { loadEnvironment } from "@/lib/env";

const MEMORY_MAX_ENTRIES = 10_000;

interface MemoryEntry {
  value: string;
  expiresAt: number;
}

type RedisCommandResult = string | number | (string | number)[] | null;

interface RedisCommands {
  eval(
    script: string,
    keys: string[],
    args: (string | number)[],
  ): Promise<RedisCommandResult>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { ex?: number }): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  ping(): Promise<string>;
}

class BoundedMemoryRedis implements RedisCommands {
  private readonly entries = new Map<string, MemoryEntry>();

  private evictExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }

  private enforceCapacity(): void {
    while (this.entries.size > MEMORY_MAX_ENTRIES) {
      const oldestKey = this.entries.keys().next().value;
      if (!oldestKey) {
        break;
      }
      this.entries.delete(oldestKey);
    }
  }

  async eval(
    script: string,
    keys: string[],
    args: (string | number)[],
  ): Promise<RedisCommandResult> {
    const now = Date.now();
    this.evictExpired(now);
    const key = keys[0];
    if (!key) {
      return [0, 0];
    }
    if (script.includes("INCR")) {
      const windowMs = Number(args[1]);
      const entry = this.entries.get(key);
      let count = 1;
      let ttl = windowMs;
      if (entry && entry.expiresAt > now) {
        count = Number(entry.value) + 1;
        ttl = Math.max(0, entry.expiresAt - now);
        entry.value = String(count);
      } else {
        this.entries.set(key, {
          value: "1",
          expiresAt: now + windowMs,
        });
        this.enforceCapacity();
      }
      return [count, ttl];
    }
    return null;
  }

  async get(key: string): Promise<string | null> {
    const now = Date.now();
    this.evictExpired(now);
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= now) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, options?: { ex?: number }): Promise<unknown> {
    const ttlSeconds = options?.ex ?? 30;
    this.entries.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
    this.enforceCapacity();
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.entries.delete(key)) {
        removed += 1;
      }
    }
    return removed;
  }

  async ping(): Promise<string> {
    return "PONG";
  }
}

export type RedisRuntimeMode = "upstash" | "memory";

export interface RedisRuntimeState {
  mode: RedisRuntimeMode;
  available: boolean;
  lastError?: string;
}

declare global {
  var __portalRedisClient: RedisCommands | undefined;
  var __portalRedisState: RedisRuntimeState | undefined;
}

function resolveUpstashConfig(): { url: string; token: string } | null {
  const environment = loadEnvironment();
  const url = environment.UPSTASH_REDIS_REST_URL;
  const token = environment.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    return null;
  }
  return { url, token };
}

function assertProductionRedisConfigured(): void {
  const environment = loadEnvironment();
  if (environment.NODE_ENV !== "production") {
    return;
  }
  const config = resolveUpstashConfig();
  if (!config) {
    throw new Error(
      "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required in production.",
    );
  }
}

export function getRedisRuntimeState(): RedisRuntimeState {
  return (
    globalThis.__portalRedisState ?? {
      mode: "memory",
      available: true,
    }
  );
}

export function getRedisClient(): RedisCommands {
  assertProductionRedisConfigured();
  if (globalThis.__portalRedisClient) {
    return globalThis.__portalRedisClient;
  }

  const config = resolveUpstashConfig();
  if (config) {
    const upstash = new Redis({ url: config.url, token: config.token });
    globalThis.__portalRedisClient = {
      eval: (script, keys, args) => upstash.eval(script, keys, args),
      get: (key) => upstash.get<string>(key).then((value) => (value == null ? null : String(value))),
      set: (key, value, options) =>
        options?.ex
          ? upstash.set(key, value, { ex: options.ex })
          : upstash.set(key, value),
      del: (...keys) => upstash.del(...keys),
      ping: () => upstash.ping(),
    };
    globalThis.__portalRedisState = { mode: "upstash", available: true };
    return globalThis.__portalRedisClient;
  }

  globalThis.__portalRedisClient = new BoundedMemoryRedis();
  globalThis.__portalRedisState = { mode: "memory", available: true };
  return globalThis.__portalRedisClient;
}

export async function pingRedis(): Promise<boolean> {
  try {
    const response = await getRedisClient().ping();
    globalThis.__portalRedisState = {
      ...getRedisRuntimeState(),
      available: true,
      lastError: undefined,
    };
    return response === "PONG";
  } catch (error) {
    globalThis.__portalRedisState = {
      ...getRedisRuntimeState(),
      available: false,
      lastError: error instanceof Error ? error.message : "Redis ping failed",
    };
    return false;
  }
}

export function markRedisUnavailable(error: unknown): void {
  globalThis.__portalRedisState = {
    ...getRedisRuntimeState(),
    available: false,
    lastError: error instanceof Error ? error.message : "Redis command failed",
  };
}
