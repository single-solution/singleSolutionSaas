import {
  checkDistributedRateLimit,
  getClientIp,
  type RateLimitPolicy,
  type RateLimitResult,
} from "@/lib/redis/rateLimit";

export { getClientIp, type RateLimitPolicy, type RateLimitResult };

export async function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  policy: RateLimitPolicy = "fail_closed",
): Promise<RateLimitResult> {
  const separatorIndex = key.indexOf(":");
  const category = separatorIndex === -1 ? key : key.slice(0, separatorIndex);
  const identifier = separatorIndex === -1 ? "default" : key.slice(separatorIndex + 1);
  return checkDistributedRateLimit({
    category,
    identifier,
    limit,
    windowMs,
    policy,
  });
}
