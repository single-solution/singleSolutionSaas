import mongoose from "mongoose";

import { connectCluster } from "@/lib/db/tenant";
import { loadPublicDemoConfig } from "@/lib/demo/config";
import { logger } from "@/lib/logging/logger";
import { verifyProductToken } from "@/lib/platform/client";

const DEFAULT_RETENTION_DAYS = 30;
const BATCH_LIMIT = 100;

export interface DemoCleanupSummary {
  configured: boolean;
  eligible: boolean;
  conversationsDeleted: number;
  messagesDeleted: number;
  webhookDeliveriesDeleted: number;
  durationMs: number;
}

function resolveRetentionDays(): number {
  const configured = Number(process.env.DEMO_DATA_RETENTION_DAYS);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.min(configured, 365);
  }
  return DEFAULT_RETENTION_DAYS;
}

async function isPublicDemoTenant(dataDbName: string, siteId: string): Promise<boolean> {
  const tenantDb = mongoose.connection.useDb(dataDbName, { useCache: true });
  const meta = await tenantDb.collection("tenantMeta").findOne({ key: "tenant" });
  if (!meta?.isPublicDemo) {
    return false;
  }
  return meta.siteId === siteId;
}

export async function processDemoCleanup(): Promise<DemoCleanupSummary> {
  const startedAt = Date.now();
  const summary: DemoCleanupSummary = {
    configured: false,
    eligible: false,
    conversationsDeleted: 0,
    messagesDeleted: 0,
    webhookDeliveriesDeleted: 0,
    durationMs: 0,
  };

  const demoConfig = loadPublicDemoConfig();
  const token = demoConfig.productToken;
  if (!token) {
    summary.durationMs = Date.now() - startedAt;
    return summary;
  }
  summary.configured = true;

  await connectCluster();
  const entitlement = await verifyProductToken(token);
  if (!entitlement?.dataDbName || !entitlement.siteId) {
    summary.durationMs = Date.now() - startedAt;
    return summary;
  }

  const isDemoTenant = await isPublicDemoTenant(
    entitlement.dataDbName,
    entitlement.siteId,
  );
  if (!isDemoTenant) {
    logger.warn("Demo cleanup skipped: token does not map to public demo tenant");
    summary.durationMs = Date.now() - startedAt;
    return summary;
  }
  summary.eligible = true;

  const cutoff = new Date(Date.now() - resolveRetentionDays() * 24 * 60 * 60_000);
  const tenantDb = mongoose.connection.useDb(entitlement.dataDbName, { useCache: true });
  const staleConversations = await tenantDb
    .collection("conversations")
    .find({ updatedAt: { $lte: cutoff } }, { projection: { _id: 1 } })
    .limit(BATCH_LIMIT)
    .toArray();

  if (staleConversations.length === 0) {
    summary.durationMs = Date.now() - startedAt;
    return summary;
  }

  const conversationIds = staleConversations.map((conversation) => conversation._id);
  const messageResult = await tenantDb.collection("messages").deleteMany({
    conversationId: { $in: conversationIds },
  });
  const conversationResult = await tenantDb.collection("conversations").deleteMany({
    _id: { $in: conversationIds },
  });
  const deliveryResult = await tenantDb.collection("webhookdeliveries").deleteMany({
    createdAt: { $lte: cutoff },
  });

  summary.conversationsDeleted = conversationResult.deletedCount ?? 0;
  summary.messagesDeleted = messageResult.deletedCount ?? 0;
  summary.webhookDeliveriesDeleted = deliveryResult.deletedCount ?? 0;
  summary.durationMs = Date.now() - startedAt;

  logger.info("Demo cleanup finished", {
    siteId: entitlement.siteId,
    dataDbName: entitlement.dataDbName,
    ...summary,
  });
  return summary;
}
