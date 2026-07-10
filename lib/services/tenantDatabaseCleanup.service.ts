import "server-only";

import mongoose from "mongoose";

import { Merchant, Subscription } from "@/lib/db";
import { writeAuditLogSafe } from "@/lib/audit/writeAuditLog";
import { logger } from "@/lib/logging/logger";
import { isRetentionActive } from "@/lib/services/subscriptionLifecycle.service";

const BATCH_LIMIT = 20;
const JOB_TIMEOUT_MS = 45_000;

export interface TenantDatabaseCleanupSummary {
  scanned: number;
  dropped: number;
  skipped: number;
  merchantsCompleted: number;
  errors: number;
  durationMs: number;
}

async function dropTenantDatabase(dataDbName: string): Promise<void> {
  const tenantDb = mongoose.connection.useDb(dataDbName, { useCache: true });
  await tenantDb.dropDatabase();
}

export async function processTenantDatabaseCleanup(
  processorId = "tenant-databases-cron",
): Promise<TenantDatabaseCleanupSummary> {
  const startedAt = Date.now();
  const summary: TenantDatabaseCleanupSummary = {
    scanned: 0,
    dropped: 0,
    skipped: 0,
    merchantsCompleted: 0,
    errors: 0,
    durationMs: 0,
  };

  const now = new Date();
  const subscriptions = await Subscription.find({
    status: "archived",
    deletionEligibleAt: { $lte: now },
    dataDbName: { $ne: null },
  })
    .limit(BATCH_LIMIT)
    .lean();

  for (const subscription of subscriptions) {
    if (Date.now() - startedAt > JOB_TIMEOUT_MS) {
      break;
    }
    summary.scanned += 1;
    const dataDbName = subscription.dataDbName?.trim();
    if (!dataDbName) {
      summary.skipped += 1;
      continue;
    }
    if (isRetentionActive(subscription.deletionEligibleAt)) {
      summary.skipped += 1;
      continue;
    }

    try {
      await dropTenantDatabase(dataDbName);
      await Subscription.updateOne(
        { _id: subscription._id },
        { $unset: { dataDbName: "" } },
      );
      summary.dropped += 1;
      await writeAuditLogSafe({
        merchantId: subscription.merchantId.toString(),
        actorUserId: null,
        action: "subscription.tenant_database_deleted",
        resourceType: "subscription",
        resourceId: subscription._id.toString(),
        metadata: {
          siteId: subscription.siteId.toString(),
          productSlug: subscription.productSlug,
          processorId,
        },
        actorRole: "system",
      });
    } catch (error) {
      summary.errors += 1;
      logger.error("Tenant database cleanup failed", {
        subscriptionId: subscription._id.toString(),
        dataDbName,
        error: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  const merchants = await Merchant.find({
    lifecycleStatus: "deletion_scheduled",
    deletionEligibleAt: { $lte: now },
    deletionCompletedAt: null,
  })
    .limit(10)
    .lean();

  for (const merchant of merchants) {
    if (Date.now() - startedAt > JOB_TIMEOUT_MS) {
      break;
    }
    const pendingTenantDatabases = await Subscription.countDocuments({
      merchantId: merchant._id,
      dataDbName: { $ne: null },
    });
    if (pendingTenantDatabases > 0) {
      continue;
    }
    await Merchant.updateOne(
      { _id: merchant._id },
      { $set: { deletionCompletedAt: new Date() } },
    );
    summary.merchantsCompleted += 1;
    await writeAuditLogSafe({
      merchantId: merchant._id.toString(),
      actorUserId: null,
      action: "merchant.deletion_completed",
      resourceType: "merchant",
      resourceId: merchant._id.toString(),
      metadata: { processorId },
      actorRole: "system",
    });
  }

  summary.durationMs = Date.now() - startedAt;
  logger.info("Tenant database cleanup finished", { ...summary });
  return summary;
}
