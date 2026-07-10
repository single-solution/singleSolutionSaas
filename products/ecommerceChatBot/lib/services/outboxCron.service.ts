import { connectCluster } from "@/lib/db/tenant";
import { fetchProductSites } from "@/lib/platform/client";
import { processUsageOutbox } from "@/lib/outbox/usageOutboxProcessor";
import { processWebhookOutbox } from "@/lib/outbox/webhookOutboxProcessor";
import { loadEnvironment } from "@/lib/env";
import { logger } from "@/lib/logging/logger";

const TENANT_BATCH_LIMIT = 15;
const JOB_TIMEOUT_MS = 45_000;

export interface TenantOutboxRollup {
  dataDbName: string;
  processed: number;
  completed: number;
  retried: number;
  dead: number;
}

export interface OutboxCronSummary {
  tenants: number;
  rollups: TenantOutboxRollup[];
  totals: {
    processed: number;
    completed: number;
    retried: number;
    dead: number;
  };
  durationMs: number;
}

async function listTenantDatabases(): Promise<string[]> {
  const sites = await fetchProductSites(loadEnvironment().productSlug);
  return [...new Set(sites.map((site) => site.dataDbName).filter(Boolean))].slice(
    0,
    TENANT_BATCH_LIMIT,
  );
}

export async function processWebhookOutboxAcrossTenants(
  processorId: string,
): Promise<OutboxCronSummary> {
  const startedAt = Date.now();
  const rollups: TenantOutboxRollup[] = [];
  const totals = { processed: 0, completed: 0, retried: 0, dead: 0 };

  await connectCluster();
  for (const dataDbName of await listTenantDatabases()) {
    if (Date.now() - startedAt > JOB_TIMEOUT_MS) {
      break;
    }
    try {
      const result = await processWebhookOutbox(dataDbName, processorId);
      rollups.push({ dataDbName, ...result });
      totals.processed += result.processed;
      totals.completed += result.completed;
      totals.retried += result.retried;
      totals.dead += result.dead;
    } catch (error) {
      logger.error("Webhook outbox tenant processing failed", {
        dataDbName,
        error: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  return {
    tenants: rollups.length,
    rollups,
    totals,
    durationMs: Date.now() - startedAt,
  };
}

export async function processUsageOutboxAcrossTenants(
  processorId: string,
): Promise<OutboxCronSummary> {
  const startedAt = Date.now();
  const rollups: TenantOutboxRollup[] = [];
  const totals = { processed: 0, completed: 0, retried: 0, dead: 0 };

  await connectCluster();
  for (const dataDbName of await listTenantDatabases()) {
    if (Date.now() - startedAt > JOB_TIMEOUT_MS) {
      break;
    }
    try {
      const result = await processUsageOutbox(dataDbName, processorId);
      rollups.push({ dataDbName, ...result });
      totals.processed += result.processed;
      totals.completed += result.completed;
      totals.retried += result.retried;
      totals.dead += result.dead;
    } catch (error) {
      logger.error("Usage outbox tenant processing failed", {
        dataDbName,
        error: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  return {
    tenants: rollups.length,
    rollups,
    totals,
    durationMs: Date.now() - startedAt,
  };
}
