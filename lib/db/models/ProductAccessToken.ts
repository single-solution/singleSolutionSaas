import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

const productAccessTokenSchema = new Schema(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true, index: true },
    siteId: { type: Schema.Types.ObjectId, ref: "Site", required: true, index: true },
    productSlug: { type: String, required: true, trim: true, index: true },
    name: { type: String, required: true, trim: true },
    tokenPrefix: { type: String, required: true },
    tokenHash: { type: String, required: true, index: true },
    scopes: { type: [String], required: true, default: [] },
    allowedDomains: { type: [String], required: true, default: [] },
    lastUsedAt: { type: Date },
    revokedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export type ProductAccessTokenDocument = InferSchemaType<typeof productAccessTokenSchema> & {
  _id: Schema.Types.ObjectId;
};

export const ProductAccessToken: Model<ProductAccessTokenDocument> =
  (models.ProductAccessToken as Model<ProductAccessTokenDocument> | undefined) ??
  model<ProductAccessTokenDocument>("ProductAccessToken", productAccessTokenSchema);
