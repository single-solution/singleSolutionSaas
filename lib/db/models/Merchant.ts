import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

const merchantSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    lifecycleStatus: {
      type: String,
      enum: ["active", "offboarding", "deletion_scheduled"],
      required: true,
      default: "active",
    },
    offboardingStartedAt: { type: Date, default: null },
    deletionEligibleAt: { type: Date, default: null },
    exportRequestedAt: { type: Date, default: null },
    deletionCompletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export type MerchantDocument = InferSchemaType<typeof merchantSchema> & { _id: Schema.Types.ObjectId };

export const Merchant: Model<MerchantDocument> =
  (models.Merchant as Model<MerchantDocument> | undefined) ?? model<MerchantDocument>("Merchant", merchantSchema);
