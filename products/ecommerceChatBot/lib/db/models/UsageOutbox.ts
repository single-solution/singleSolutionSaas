import { Schema } from "mongoose";

import {
  OUTBOX_STATUSES,
  type OutboxStatus,
} from "@/lib/outbox/outboxShared";

export interface UsageOutboxAttributes {
  idempotencyKey: string;
  siteId: string;
  productSlug: string;
  token: string;
  metric: string;
  quantity: number;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: Date;
  leasedUntil: Date | null;
  leasedBy: string | null;
  lastError: string | null;
}

export const usageOutboxSchema = new Schema<UsageOutboxAttributes>(
  {
    idempotencyKey: { type: String, required: true, trim: true, unique: true },
    siteId: { type: String, required: true, index: true },
    productSlug: { type: String, required: true, trim: true },
    token: { type: String, required: true },
    metric: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 1 },
    status: {
      type: String,
      enum: OUTBOX_STATUSES,
      required: true,
      default: "pending",
    },
    attempts: { type: Number, required: true, default: 0, min: 0 },
    nextAttemptAt: { type: Date, required: true, default: () => new Date() },
    leasedUntil: { type: Date, default: null },
    leasedBy: { type: String, default: null, trim: true },
    lastError: { type: String, default: null, trim: true, maxlength: 500 },
  },
  { timestamps: true },
);

usageOutboxSchema.index({ status: 1, nextAttemptAt: 1, leasedUntil: 1 });
