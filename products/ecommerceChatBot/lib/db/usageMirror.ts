import { getTenantModels } from "./tenant";

/** Current billing period key (YYYY-MM), matching the platform's aggregation. */
function currentPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}

/**
 * Increment the tenant-local usage mirror. The platform holds the authoritative
 * billing counter; this copy lets the in-product dashboard show usage without a
 * round-trip. Best-effort: a failed mirror must never block a customer reply.
 */
export async function mirrorUsage(
  dataDbName: string,
  siteId: string,
  productSlug: string,
  metric: string,
  quantity: number,
): Promise<void> {
  try {
    const { Usage } = await getTenantModels(dataDbName);
    await Usage.updateOne(
      { siteId, metric, period: currentPeriod() },
      { $inc: { quantity }, $set: { productSlug, lastEventAt: new Date() } },
      { upsert: true },
    );
  } catch {
    // Mirror is non-authoritative; ignore failures.
  }
}
