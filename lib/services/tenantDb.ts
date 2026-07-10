/**
 * Per-tenant product data databases.
 *
 * Every subscription (merchant + site + product) gets its own database on the
 * shared Atlas cluster so one merchant's product data is fully isolated from
 * another's. The permanent control-plane DB stays the source of truth and only
 * records each tenant DB's name (on the subscription). The running product
 * resolves its data store from that name, delivered via token verification.
 *
 * MongoDB creates a database lazily on first write, so "provisioning" just
 * writes a small marker document; it is idempotent and records provenance.
 */

import mongoose from "mongoose";

import { Subscription } from "@/lib/db";

// MongoDB Atlas caps database names at 38 bytes, so segments are kept short and
// a stable id suffix guarantees uniqueness.
const MAX_DB_NAME_LENGTH = 38;

function sanitizeSegment(value: string, maxLength: number): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.slice(0, maxLength) || "x";
}

function shortHash(value: string): string {
  // Subscription ids are 24-hex ObjectId strings; the last 8 hex chars are a
  // stable, unique-per-subscription suffix.
  return value.replace(/[^a-z0-9]/gi, "").slice(-8).toLowerCase() || "0";
}

/**
 * Deterministic, collision-safe, Mongo-legal database name for a subscription.
 * Readable prefix (merchant/site/product slugs) plus a stable id suffix so two
 * tenants that share slugs never collide.
 */
export function buildTenantDbName(input: {
  merchantSlug: string;
  siteSlug: string;
  productSlug: string;
  subscriptionId: string;
}): string {
  const merchant = sanitizeSegment(input.merchantSlug, 8);
  const site = sanitizeSegment(input.siteSlug, 6);
  const product = sanitizeSegment(input.productSlug, 8);
  const suffix = shortHash(input.subscriptionId);
  return `t-${merchant}-${site}-${product}-${suffix}`.slice(0, MAX_DB_NAME_LENGTH);
}

/** Idempotently mark the tenant database as provisioned (creates it lazily). */
export async function provisionTenantDb(dbName: string, provenance: Record<string, unknown>): Promise<void> {
  const tenantDb = mongoose.connection.useDb(dbName, { useCache: true });
  await tenantDb.collection("tenantMeta").updateOne(
    { key: "tenant" },
    { $set: { ...provenance, updatedAt: new Date() }, $setOnInsert: { provisionedAt: new Date() } },
    { upsert: true },
  );
}

/**
 * Ensure a subscription has a provisioned tenant DB and return its name. Safe to
 * call repeatedly; only provisions the first time or after a backfill.
 */
export async function ensureSubscriptionDataDb(subscription: {
  _id: { toString(): string };
  merchantId: { toString(): string };
  siteId: { toString(): string };
  productSlug: string;
  dataDbName?: string | null;
}): Promise<string> {
  if (subscription.dataDbName) {
    return subscription.dataDbName;
  }
  const { Merchant, Site } = await import("@/lib/db");
  const [merchant, site] = await Promise.all([
    Merchant.findById(subscription.merchantId).lean(),
    Site.findById(subscription.siteId).lean(),
  ]);
  const dataDbName = buildTenantDbName({
    merchantSlug: merchant?.slug ?? subscription.merchantId.toString(),
    siteSlug: site?.slug ?? subscription.siteId.toString(),
    productSlug: subscription.productSlug,
    subscriptionId: subscription._id.toString(),
  });
  await provisionTenantDb(dataDbName, {
    merchantId: subscription.merchantId.toString(),
    siteId: subscription.siteId.toString(),
    productSlug: subscription.productSlug,
  });
  await Subscription.updateOne({ _id: subscription._id }, { $set: { dataDbName } });
  return dataDbName;
}
