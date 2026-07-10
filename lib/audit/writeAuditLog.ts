import "server-only";

import { AuditLog, Types } from "@/lib/db";
import { getRequestContext } from "@/lib/logging/requestContext";
import { logger } from "@/lib/logging/logger";

export interface AuditLogInput {
  merchantId: string | null;
  actorUserId: string | null;
  action: string;
  resourceType: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  actorRole?: string | null;
  actorIp?: string | null;
}

export async function writeAuditLogSafe(input: AuditLogInput): Promise<void> {
  try {
    const context = getRequestContext();
    await AuditLog.create({
      merchantId: input.merchantId
        ? new Types.ObjectId(input.merchantId)
        : undefined,
      actorUserId: input.actorUserId
        ? new Types.ObjectId(input.actorUserId)
        : undefined,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      metadata: {
        ...(input.metadata ?? {}),
        requestId: context?.requestId ?? undefined,
        actorRole: input.actorRole ?? context?.actorRole ?? undefined,
        actorIp: input.actorIp ?? context?.clientIp ?? undefined,
      },
    });
  } catch (error) {
    logger.warn("Audit log write failed", {
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      error: error instanceof Error ? error.message : "unknown",
    });
  }
}
