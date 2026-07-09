import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

const auditLogSchema = new Schema(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", index: true },
    actorUserId: { type: Schema.Types.ObjectId, ref: "User" },
    action: { type: String, required: true },
    resourceType: { type: String, required: true },
    resourceId: { type: String },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

auditLogSchema.index({ createdAt: -1 });

export type AuditLogDocument = InferSchemaType<typeof auditLogSchema> & { _id: Schema.Types.ObjectId };

export const AuditLog: Model<AuditLogDocument> =
  (models.AuditLog as Model<AuditLogDocument> | undefined) ?? model<AuditLogDocument>("AuditLog", auditLogSchema);
