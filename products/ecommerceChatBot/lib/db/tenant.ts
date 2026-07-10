/**
 * Per-tenant database access.
 *
 * This product runs as one service for many tenants, but each subscription
 * (merchant + site + product) has its own dedicated database on the shared
 * cluster. The database name is resolved by the platform and delivered to the
 * product (via token verification for widget traffic, or passed explicitly on
 * internal/admin calls). Models are bound to that tenant's connection so all
 * reads/writes are physically isolated per tenant.
 */

import mongoose, { type Model } from "mongoose";

import { loadEnvironment } from "@/lib/env";
import { conversationSchema, type ConversationAttributes } from "./models/Conversation";
import { siteSettingsSchema, type SiteSettingsAttributes } from "./models/SiteSettings";
import { usageSchema, type UsageAttributes } from "./models/Usage";
import { webhookDeliverySchema, type WebhookDeliveryAttributes } from "./models/WebhookDelivery";

let clusterReady = false;

/** Establish the base cluster connection once; tenant DBs branch off it. */
async function connectCluster(): Promise<void> {
  if (clusterReady && mongoose.connection.readyState === 1) {
    return;
  }
  const { mongodbUri, mongodbDatabase } = loadEnvironment();
  const base = mongodbUri.replace(/\/$/, "");
  await mongoose.connect(`${base}/${mongodbDatabase}`, {
    serverSelectionTimeoutMS: 8_000,
    connectTimeoutMS: 8_000,
  });
  clusterReady = true;
}

export interface TenantModels {
  Conversation: Model<ConversationAttributes>;
  SiteSettings: Model<SiteSettingsAttributes>;
  WebhookDelivery: Model<WebhookDeliveryAttributes>;
  Usage: Model<UsageAttributes>;
}

const DB_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,37}$/;

/** Resolve the models bound to a tenant's database. Throws on a missing/invalid name. */
export async function getTenantModels(dataDbName: string): Promise<TenantModels> {
  const name = dataDbName?.trim();
  if (!name || !DB_NAME_PATTERN.test(name)) {
    throw new Error("Missing or invalid tenant database name.");
  }
  await connectCluster();
  const db = mongoose.connection.useDb(name, { useCache: true });
  return {
    Conversation:
      (db.models.Conversation as Model<ConversationAttributes>) ??
      db.model<ConversationAttributes>("Conversation", conversationSchema),
    SiteSettings:
      (db.models.SiteSettings as Model<SiteSettingsAttributes>) ??
      db.model<SiteSettingsAttributes>("SiteSettings", siteSettingsSchema),
    WebhookDelivery:
      (db.models.WebhookDelivery as Model<WebhookDeliveryAttributes>) ??
      db.model<WebhookDeliveryAttributes>("WebhookDelivery", webhookDeliverySchema),
    Usage: (db.models.Usage as Model<UsageAttributes>) ?? db.model<UsageAttributes>("Usage", usageSchema),
  };
}
