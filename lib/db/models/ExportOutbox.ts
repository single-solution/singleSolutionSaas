import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

import {
  OUTBOX_STATUSES,
  type OutboxStatus,
} from "@/lib/outbox/outboxShared";

const exportOutboxSchema = new Schema(
  {
    idempotencyKey: { type: String, required: true, trim: true, unique: true },
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true, index: true },
    requestedByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
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
    completedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

exportOutboxSchema.index({ status: 1, nextAttemptAt: 1, leasedUntil: 1 });

export type ExportOutboxDocument = InferSchemaType<typeof exportOutboxSchema> & {
  _id: Schema.Types.ObjectId;
  status: OutboxStatus;
};

export const ExportOutbox: Model<ExportOutboxDocument> =
  (models.ExportOutbox as Model<ExportOutboxDocument> | undefined) ??
  model<ExportOutboxDocument>("ExportOutbox", exportOutboxSchema);
