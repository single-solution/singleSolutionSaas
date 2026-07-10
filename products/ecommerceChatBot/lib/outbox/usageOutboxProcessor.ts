import { getTenantModels } from "@/lib/db/tenant";
import type { UsageOutboxAttributes } from "@/lib/db/models/UsageOutbox";
import { mirrorUsage } from "@/lib/db/usageMirror";
import { reportProductUsage } from "@/lib/platform/client";
import {
  OUTBOX_BATCH_LIMIT,
  OUTBOX_DEFAULT_MAX_ATTEMPTS,
  OUTBOX_LEASE_MS,
  computeOutboxBackoff,
  sanitizeOutboxError,
} from "@/lib/outbox/outboxShared";

export interface ProcessUsageOutboxResult {
  processed: number;
  completed: number;
  retried: number;
  dead: number;
}

export async function processUsageOutbox(
  dataDbName: string,
  processorId = "usage-outbox",
): Promise<ProcessUsageOutboxResult> {
  const { UsageOutbox } = await getTenantModels(dataDbName);
  const now = new Date();
  const result: ProcessUsageOutboxResult = {
    processed: 0,
    completed: 0,
    retried: 0,
    dead: 0,
  };

  for (let index = 0; index < OUTBOX_BATCH_LIMIT; index += 1) {
    const leased = await UsageOutbox.findOneAndUpdate(
      {
        status: { $in: ["pending", "processing"] },
        nextAttemptAt: { $lte: now },
        $or: [{ leasedUntil: null }, { leasedUntil: { $lte: now } }],
      },
      {
        $set: {
          status: "processing",
          leasedUntil: new Date(now.getTime() + OUTBOX_LEASE_MS),
          leasedBy: processorId,
        },
      },
      { sort: { nextAttemptAt: 1 }, new: true },
    ).lean<UsageOutboxAttributes & { _id: unknown }>();

    if (!leased) {
      break;
    }

    result.processed += 1;
    try {
      await reportProductUsage(
        leased.token,
        leased.metric,
        leased.quantity,
        leased.idempotencyKey,
      );
      await mirrorUsage(
        dataDbName,
        leased.siteId,
        leased.productSlug,
        leased.metric,
        leased.quantity,
      );
      await UsageOutbox.updateOne(
        { _id: leased._id },
        {
          $set: {
            status: "completed",
            leasedUntil: null,
            leasedBy: null,
            lastError: null,
          },
        },
      );
      result.completed += 1;
    } catch (error) {
      const attempts = leased.attempts + 1;
      const terminal = attempts >= OUTBOX_DEFAULT_MAX_ATTEMPTS;
      await UsageOutbox.updateOne(
        { _id: leased._id },
        {
          $set: {
            status: terminal ? "dead" : "pending",
            attempts,
            nextAttemptAt: terminal ? now : computeOutboxBackoff(attempts),
            leasedUntil: null,
            leasedBy: null,
            lastError: sanitizeOutboxError(error),
          },
        },
      );
      if (terminal) {
        result.dead += 1;
      } else {
        result.retried += 1;
      }
    }
  }

  return result;
}
