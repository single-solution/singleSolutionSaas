import { hashCacheSegment } from "@/lib/redis/hashKey";
import { getRedisClient, getRedisRuntimeState, markRedisUnavailable } from "@/lib/redis/client";

const RATE_LIMIT_SCRIPT = `
local limit = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("PEXPIRE", KEYS[1], window_ms)
end
local ttl = redis.call("PTTL", KEYS[1])
return {current, ttl}
`;

const KEY_PREFIX = "ss:chatbot:rl:v1";

export type RateLimitPolicy = "fail_closed" | "degrade";

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
  unavailable?: boolean;
}

export interface RateLimitInput {
  category: string;
  identifier: string;
  limit: number;
  windowMs: number;
  policy?: RateLimitPolicy;
}

function buildRateLimitKey(category: string, identifier: string): string {
  const hashedIdentifier = hashCacheSegment(identifier);
  return `${KEY_PREFIX}:${category}:${hashedIdentifier}`;
}

function parseEvalResult(result: unknown): { count: number; ttlMs: number } {
  if (!Array.isArray(result) || result.length < 2) {
    return { count: 0, ttlMs: 0 };
  }
  return {
    count: Number(result[0]) || 0,
    ttlMs: Math.max(0, Number(result[1]) || 0),
  };
}

export async function checkDistributedRateLimit(
  input: RateLimitInput,
): Promise<RateLimitResult> {
  const policy = input.policy ?? "fail_closed";
  const key = buildRateLimitKey(input.category, input.identifier);

  try {
    const result = await getRedisClient().eval(
      RATE_LIMIT_SCRIPT,
      [key],
      [input.limit, input.windowMs],
    );
    const { count, ttlMs } = parseEvalResult(result);
    if (count > input.limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(ttlMs / 1000)),
      };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  } catch (error) {
    markRedisUnavailable(error);
    if (policy === "degrade" || getRedisRuntimeState().mode === "memory") {
      return { allowed: true, retryAfterSeconds: 0 };
    }
    return { allowed: false, retryAfterSeconds: 60, unavailable: true };
  }
}

/**
 * Resolves the client IP for rate limiting.
 * On Vercel, prefer x-vercel-forwarded-for (platform-trusted). Do not trust
 * arbitrary x-forwarded-for in production outside that signal.
 */
export function getClientIp(request: Request): string {
  const vercelForwarded = request.headers.get("x-vercel-forwarded-for");
  if (vercelForwarded) {
    return vercelForwarded.split(",")[0]?.trim() || "unknown";
  }

  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) {
    return realIp;
  }

  if (process.env.NODE_ENV !== "production") {
    const forwarded = request.headers.get("x-forwarded-for");
    if (forwarded) {
      return forwarded.split(",")[0]?.trim() || "unknown";
    }
  }

  return "unknown";
}
