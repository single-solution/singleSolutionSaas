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
import { messageSchema, type MessageAttributes } from "./models/Message";
import { siteSettingsSchema, type SiteSettingsAttributes } from "./models/SiteSettings";
import { usageSchema, type UsageAttributes } from "./models/Usage";
import { usageOutboxSchema, type UsageOutboxAttributes } from "./models/UsageOutbox";
import { webhookDeliverySchema, type WebhookDeliveryAttributes } from "./models/WebhookDelivery";
import { webhookOutboxSchema, type WebhookOutboxAttributes } from "./models/WebhookOutbox";

const CONNECT_TIMEOUT_MS = 8_000;
const TENANT_MODEL_CACHE_MAX = 128;

export type DbConnectionStatus = "connected" | "connecting" | "disconnected" | "error";

export interface DbConnectionState {
  status: DbConnectionStatus;
  lastError?: string;
  lastConnectedAt?: number;
}

declare global {
  var __chatbotMongoosePromise: Promise<void> | undefined;
  var __chatbotMongooseState: DbConnectionState | undefined;
}

function getConnectionState(): DbConnectionState {
  return (
    globalThis.__chatbotMongooseState ?? {
      status: "disconnected",
    }
  );
}

function setConnectionState(state: DbConnectionState): void {
  globalThis.__chatbotMongooseState = state;
}

function resetConnectionPromise(): void {
  globalThis.__chatbotMongoosePromise = undefined;
}

function attachConnectionListeners(): void {
  const connection = mongoose.connection;
  connection.on("disconnected", () => {
    setConnectionState({ status: "disconnected" });
    resetConnectionPromise();
  });
  connection.on("error", (error) => {
    setConnectionState({
      status: "error",
      lastError: error.message,
    });
    resetConnectionPromise();
  });
}

export function getDbConnectionState(): DbConnectionState {
  const state = getConnectionState();
  if (mongoose.connection.readyState === 1 && state.status !== "connected") {
    return { ...state, status: "connected" };
  }
  return state;
}

export async function pingDb(): Promise<boolean> {
  if (mongoose.connection.readyState !== 1) {
    return false;
  }
  try {
    await mongoose.connection.db?.admin().command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}

/** Establish the base cluster connection once; tenant DBs branch off it. */
export async function connectCluster(): Promise<void> {
  if (mongoose.connection.readyState === 1) {
    setConnectionState({
      status: "connected",
      lastConnectedAt: Date.now(),
    });
    return;
  }

  if (!globalThis.__chatbotMongoosePromise) {
    setConnectionState({ status: "connecting" });
    const { mongodbUri, mongodbDatabase } = loadEnvironment();
    const base = mongodbUri.replace(/\/$/, "");
    globalThis.__chatbotMongoosePromise = mongoose
      .connect(`${base}/${mongodbDatabase}`, {
        serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
        connectTimeoutMS: CONNECT_TIMEOUT_MS,
      })
      .then(() => {
        attachConnectionListeners();
        setConnectionState({
          status: "connected",
          lastConnectedAt: Date.now(),
          lastError: undefined,
        });
      })
      .catch((error) => {
        setConnectionState({
          status: "error",
          lastError: error instanceof Error ? error.message : "Database connection failed",
        });
        resetConnectionPromise();
        throw error;
      });
  }

  await globalThis.__chatbotMongoosePromise;
}

export interface TenantModels {
  Conversation: Model<ConversationAttributes>;
  Message: Model<MessageAttributes>;
  SiteSettings: Model<SiteSettingsAttributes>;
  WebhookDelivery: Model<WebhookDeliveryAttributes>;
  WebhookOutbox: Model<WebhookOutboxAttributes>;
  Usage: Model<UsageAttributes>;
  UsageOutbox: Model<UsageOutboxAttributes>;
}

const DB_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,37}$/;

class TenantModelCache {
  private readonly order: string[] = [];
  private readonly entries = new Map<string, Promise<TenantModels>>();

  get(dataDbName: string): Promise<TenantModels> | undefined {
    const existing = this.entries.get(dataDbName);
    if (!existing) {
      return undefined;
    }
    const index = this.order.indexOf(dataDbName);
    if (index >= 0) {
      this.order.splice(index, 1);
      this.order.push(dataDbName);
    }
    return existing;
  }

  set(dataDbName: string, modelsPromise: Promise<TenantModels>): void {
    if (!this.entries.has(dataDbName)) {
      this.order.push(dataDbName);
    }
    this.entries.set(dataDbName, modelsPromise);
    while (this.order.length > TENANT_MODEL_CACHE_MAX) {
      const evicted = this.order.shift();
      if (!evicted) {
        break;
      }
      this.entries.delete(evicted);
    }
  }
}

const tenantModelCache = new TenantModelCache();

function bindTenantModels(dataDbName: string): TenantModels {
  const database = mongoose.connection.useDb(dataDbName, { useCache: true });
  return {
    Conversation:
      (database.models.Conversation as Model<ConversationAttributes>) ??
      database.model<ConversationAttributes>("Conversation", conversationSchema),
    Message:
      (database.models.Message as Model<MessageAttributes>) ??
      database.model<MessageAttributes>("Message", messageSchema),
    SiteSettings:
      (database.models.SiteSettings as Model<SiteSettingsAttributes>) ??
      database.model<SiteSettingsAttributes>("SiteSettings", siteSettingsSchema),
    WebhookDelivery:
      (database.models.WebhookDelivery as Model<WebhookDeliveryAttributes>) ??
      database.model<WebhookDeliveryAttributes>("WebhookDelivery", webhookDeliverySchema),
    WebhookOutbox:
      (database.models.WebhookOutbox as Model<WebhookOutboxAttributes>) ??
      database.model<WebhookOutboxAttributes>("WebhookOutbox", webhookOutboxSchema),
    Usage:
      (database.models.Usage as Model<UsageAttributes>) ??
      database.model<UsageAttributes>("Usage", usageSchema),
    UsageOutbox:
      (database.models.UsageOutbox as Model<UsageOutboxAttributes>) ??
      database.model<UsageOutboxAttributes>("UsageOutbox", usageOutboxSchema),
  };
}

/** Resolve the models bound to a tenant's database. Throws on a missing/invalid name. */
export async function getTenantModels(dataDbName: string): Promise<TenantModels> {
  const name = dataDbName?.trim();
  if (!name || !DB_NAME_PATTERN.test(name)) {
    throw new Error("Missing or invalid tenant database name.");
  }

  const cached = tenantModelCache.get(name);
  if (cached) {
    return cached;
  }

  const modelsPromise = connectCluster().then(() => bindTenantModels(name));
  tenantModelCache.set(name, modelsPromise);
  return modelsPromise;
}
