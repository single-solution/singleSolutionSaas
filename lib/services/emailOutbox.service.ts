import { EmailOutbox } from "@/lib/db";
import type { EmailOutboxDocument } from "@/lib/db/models/EmailOutbox";
import { sendInviteEmail } from "@/lib/email/invite";
import { sendRecoveryEmail } from "@/lib/email/recovery";
import { loadEnvironment } from "@/lib/env";
import {
  OUTBOX_BATCH_LIMIT,
  OUTBOX_DEFAULT_MAX_ATTEMPTS,
  OUTBOX_LEASE_MS,
  computeOutboxBackoff,
  sanitizeOutboxError,
} from "@/lib/outbox/outboxShared";

export interface EnqueueInviteEmailInput {
  idempotencyKey: string;
  to: string;
  recipientName: string;
  merchantName: string;
  inviteUrl: string;
  expiresInDays: number;
}

export async function enqueueInviteEmail(
  input: EnqueueInviteEmailInput,
): Promise<void> {
  await EmailOutbox.updateOne(
    { idempotencyKey: input.idempotencyKey },
    {
      $setOnInsert: {
        idempotencyKey: input.idempotencyKey,
        kind: "invite",
        to: input.to,
        payload: {
          recipientName: input.recipientName,
          merchantName: input.merchantName,
          inviteUrl: input.inviteUrl,
          expiresInDays: input.expiresInDays,
        },
        status: "pending",
        attempts: 0,
        nextAttemptAt: new Date(),
        leasedUntil: null,
        leasedBy: null,
        lastError: null,
      },
    },
    { upsert: true },
  );
}

function buildInviteIdempotencyKey(userId: string, tokenHash: string): string {
  return `invite:${userId}:${tokenHash}`;
}

export function inviteEmailIdempotencyKey(
  userId: string,
  tokenHash: string,
): string {
  return buildInviteIdempotencyKey(userId, tokenHash);
}

export interface EnqueueRecoveryEmailInput {
  idempotencyKey: string;
  to: string;
  recipientName: string;
  recoveryUrl: string;
  expiresInHours: number;
}

export async function enqueueRecoveryEmail(
  input: EnqueueRecoveryEmailInput,
): Promise<void> {
  await EmailOutbox.updateOne(
    { idempotencyKey: input.idempotencyKey },
    {
      $setOnInsert: {
        idempotencyKey: input.idempotencyKey,
        kind: "recovery",
        to: input.to,
        payload: {
          recipientName: input.recipientName,
          recoveryUrl: input.recoveryUrl,
          expiresInHours: input.expiresInHours,
        },
        status: "pending",
        attempts: 0,
        nextAttemptAt: new Date(),
        leasedUntil: null,
        leasedBy: null,
        lastError: null,
      },
    },
    { upsert: true },
  );
}

async function deliverRecovery(item: EmailOutboxDocument): Promise<boolean> {
  const payload = item.payload as {
    recipientName?: string;
    recoveryUrl?: string;
    expiresInHours?: number;
  };
  if (!payload.recipientName || !payload.recoveryUrl || !payload.expiresInHours) {
    throw new Error("Recovery outbox payload is incomplete.");
  }
  return sendRecoveryEmail({
    to: item.to,
    recipientName: payload.recipientName,
    recoveryUrl: payload.recoveryUrl,
    expiresInHours: payload.expiresInHours,
  });
}

export interface ProcessEmailOutboxResult {
  processed: number;
  completed: number;
  retried: number;
  dead: number;
}

async function deliverInvite(item: EmailOutboxDocument): Promise<boolean> {
  const payload = item.payload as {
    recipientName?: string;
    merchantName?: string;
    inviteUrl?: string;
    expiresInDays?: number;
  };
  if (
    !payload.recipientName ||
    !payload.merchantName ||
    !payload.inviteUrl ||
    !payload.expiresInDays
  ) {
    throw new Error("Invite outbox payload is incomplete.");
  }
  return sendInviteEmail({
    to: item.to,
    recipientName: payload.recipientName,
    merchantName: payload.merchantName,
    inviteUrl: payload.inviteUrl,
    expiresInDays: payload.expiresInDays,
  });
}

export async function processEmailOutbox(
  processorId = "email-outbox",
): Promise<ProcessEmailOutboxResult> {
  const now = new Date();
  const result: ProcessEmailOutboxResult = {
    processed: 0,
    completed: 0,
    retried: 0,
    dead: 0,
  };

  for (let index = 0; index < OUTBOX_BATCH_LIMIT; index += 1) {
    const leased = await EmailOutbox.findOneAndUpdate(
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
    ).lean<EmailOutboxDocument>();

    if (!leased) {
      break;
    }

    result.processed += 1;
    try {
      let delivered = false;
      if (leased.kind === "invite") {
        delivered = await deliverInvite(leased);
      } else if (leased.kind === "recovery") {
        delivered = await deliverRecovery(leased);
      }
      if (!delivered && loadEnvironment().SMTP_HOST) {
        throw new Error("Email provider rejected the invite message.");
      }
      await EmailOutbox.updateOne(
        { _id: leased._id },
        {
          $set: {
            status: "completed",
            leasedUntil: null,
            leasedBy: null,
            lastError: delivered ? null : "SMTP is not configured.",
          },
        },
      );
      result.completed += 1;
    } catch (error) {
      const attempts = leased.attempts + 1;
      const terminal = attempts >= OUTBOX_DEFAULT_MAX_ATTEMPTS;
      await EmailOutbox.updateOne(
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
