import { getRedisClient } from "@/lib/redis/client";
import { hashCacheSegment } from "@/lib/redis/hashKey";
import type { ProductEntitlement } from "@/lib/platform/client";

const CACHE_VERSION = 1;
const ENTITLEMENT_TTL_SECONDS = 30;
const INVALID_ENTITLEMENT_TTL_SECONDS = 30;
const TRANSIENT_FAILURE_TTL_SECONDS = 5;
const SITE_BINDING_TTL_SECONDS = 60;
const PLATFORM_SESSION_TTL_SECONDS = 30;

type EntitlementCacheKind = "valid" | "invalid" | "transient";

interface EntitlementCachePayload {
  kind: EntitlementCacheKind;
  entitlement?: ProductEntitlement;
}

interface SiteBindingCachePayload {
  dataDbName: string;
}

interface PlatformSessionCachePayload {
  valid: boolean;
}

function entitlementKey(token: string): string {
  return `ss:chatbot:entitlement:v${CACHE_VERSION}:${hashCacheSegment(token)}`;
}

function siteBindingKey(productSlug: string, siteId: string): string {
  return `ss:chatbot:site-binding:v${CACHE_VERSION}:${hashCacheSegment(`${productSlug}:${siteId}`)}`;
}

function platformSessionKey(userId: string, sessionVersion: number): string {
  return `ss:chatbot:platform-session:v${CACHE_VERSION}:${hashCacheSegment(`${userId}:${sessionVersion}`)}`;
}

async function readJson<T>(key: string): Promise<T | null> {
  const raw = await getRedisClient().get(key);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    await getRedisClient().del(key);
    return null;
  }
}

async function writeJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  await getRedisClient().set(key, JSON.stringify(value), { ex: ttlSeconds });
}

export async function readEntitlementCache(
  token: string,
): Promise<EntitlementCachePayload | null> {
  return readJson<EntitlementCachePayload>(entitlementKey(token));
}

export async function writeEntitlementCache(
  token: string,
  payload: EntitlementCachePayload,
): Promise<void> {
  const ttlSeconds =
    payload.kind === "transient"
      ? TRANSIENT_FAILURE_TTL_SECONDS
      : payload.kind === "invalid"
        ? INVALID_ENTITLEMENT_TTL_SECONDS
        : ENTITLEMENT_TTL_SECONDS;
  await writeJson(entitlementKey(token), payload, ttlSeconds);
}

export async function invalidateEntitlementCache(token: string): Promise<void> {
  await getRedisClient().del(entitlementKey(token));
}

export async function readSiteBindingCache(
  productSlug: string,
  siteId: string,
): Promise<SiteBindingCachePayload | null> {
  return readJson<SiteBindingCachePayload>(siteBindingKey(productSlug, siteId));
}

export async function writeSiteBindingCache(
  productSlug: string,
  siteId: string,
  dataDbName: string,
): Promise<void> {
  await writeJson(
    siteBindingKey(productSlug, siteId),
    { dataDbName },
    SITE_BINDING_TTL_SECONDS,
  );
}

export async function invalidateSiteBindingCache(
  productSlug: string,
  siteId: string,
): Promise<void> {
  await getRedisClient().del(siteBindingKey(productSlug, siteId));
}

export async function readPlatformSessionCache(
  userId: string,
  sessionVersion: number,
): Promise<PlatformSessionCachePayload | null> {
  return readJson<PlatformSessionCachePayload>(platformSessionKey(userId, sessionVersion));
}

export async function writePlatformSessionCache(
  userId: string,
  sessionVersion: number,
  valid: boolean,
): Promise<void> {
  await writeJson(
    platformSessionKey(userId, sessionVersion),
    { valid },
    PLATFORM_SESSION_TTL_SECONDS,
  );
}

export async function invalidatePlatformSessionCache(
  userId: string,
  sessionVersion: number,
): Promise<void> {
  await getRedisClient().del(platformSessionKey(userId, sessionVersion));
}

export async function invalidateEntitlementCachesForSite(
  productSlug: string,
  siteId: string,
): Promise<void> {
  await invalidateSiteBindingCache(productSlug, siteId);
}
