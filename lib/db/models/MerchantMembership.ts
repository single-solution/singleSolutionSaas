import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

const merchantMembershipSchema = new Schema(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    role: { type: String, required: true, enum: ["owner", "admin", "member"], default: "member" },
  },
  { timestamps: true },
);

merchantMembershipSchema.index({ merchantId: 1, userId: 1 }, { unique: true });

export type MerchantMembershipDocument = InferSchemaType<typeof merchantMembershipSchema> & {
  _id: Schema.Types.ObjectId;
};

export const MerchantMembership: Model<MerchantMembershipDocument> =
  (models.MerchantMembership as Model<MerchantMembershipDocument> | undefined) ??
  model<MerchantMembershipDocument>("MerchantMembership", merchantMembershipSchema);
