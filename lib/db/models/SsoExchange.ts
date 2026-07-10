import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

const ssoExchangeSchema = new Schema(
  {
    codeHash: { type: String, required: true, unique: true, index: true },
    productSlug: { type: String, required: true, lowercase: true, trim: true },
    siteId: { type: Schema.Types.ObjectId, default: null },
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    sessionVersion: { type: Number, required: true },
    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

ssoExchangeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type SsoExchangeDocument = InferSchemaType<typeof ssoExchangeSchema> & {
  _id: Schema.Types.ObjectId;
};

export const SsoExchange: Model<SsoExchangeDocument> =
  (models.SsoExchange as Model<SsoExchangeDocument> | undefined) ??
  model<SsoExchangeDocument>("SsoExchange", ssoExchangeSchema);
