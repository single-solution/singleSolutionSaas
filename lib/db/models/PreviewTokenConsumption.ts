import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

const previewTokenConsumptionSchema = new Schema(
  {
    tokenId: { type: String, required: true, unique: true, index: true },
    siteId: { type: Schema.Types.ObjectId, required: true },
    productSlug: { type: String, required: true, lowercase: true, trim: true },
    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: true },
);

previewTokenConsumptionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type PreviewTokenConsumptionDocument = InferSchemaType<
  typeof previewTokenConsumptionSchema
> & { _id: Schema.Types.ObjectId };

export const PreviewTokenConsumption: Model<PreviewTokenConsumptionDocument> =
  (models.PreviewTokenConsumption as Model<PreviewTokenConsumptionDocument> | undefined) ??
  model<PreviewTokenConsumptionDocument>("PreviewTokenConsumption", previewTokenConsumptionSchema);
