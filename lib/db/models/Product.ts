import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

const planQuotaSchema = new Schema(
  {
    metric: { type: String, required: true, trim: true },
    limit: { type: Number, required: true, min: 0 },
    unit: { type: String, trim: true },
  },
  { _id: false },
);

const productPlanSchema = new Schema(
  {
    code: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    priceMonthly: { type: Number, required: true, min: 0, default: 0 },
    currency: { type: String, required: true, trim: true, default: "USD" },
    scopes: { type: [String], required: true, default: [] },
    quotas: { type: [planQuotaSchema], required: true, default: [] },
  },
  { _id: false },
);

const configFieldOptionSchema = new Schema(
  {
    value: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
  },
  { _id: false },
);

const configFieldSchema = new Schema(
  {
    key: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    type: {
      type: String,
      enum: ["string", "text", "number", "boolean", "select", "color", "url", "secret", "list"],
      required: true,
      default: "string",
    },
    default: { type: Schema.Types.Mixed, default: null },
    help: { type: String, trim: true, default: "" },
    options: { type: [configFieldOptionSchema], default: [] },
    required: { type: Boolean, default: false },
    secret: { type: Boolean, default: false },
    lockable: { type: Boolean, default: true },
    group: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

const configSectionSchema = new Schema(
  {
    key: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: "" },
    kind: { type: String, enum: ["settings", "connection", "integration"], default: "settings" },
    fields: { type: [configFieldSchema], required: true, default: [] },
  },
  { _id: false },
);

const testActionSchema = new Schema(
  {
    key: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: "" },
    inputLabel: { type: String, trim: true, default: "Sample input" },
    inputPlaceholder: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

const productSchema = new Schema(
  {
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: "" },
    baseUrl: { type: String, trim: true, default: "" },
    status: { type: String, enum: ["active", "inactive"], required: true, default: "active" },
    availableScopes: { type: [String], required: true, default: [] },
    plans: { type: [productPlanSchema], required: true, default: [] },
    configSchema: { type: [configSectionSchema], required: true, default: [] },
    testActions: { type: [testActionSchema], required: true, default: [] },
  },
  { timestamps: true },
);

export type ProductDocument = InferSchemaType<typeof productSchema> & { _id: Schema.Types.ObjectId };

export const Product: Model<ProductDocument> =
  (models.Product as Model<ProductDocument> | undefined) ?? model<ProductDocument>("Product", productSchema);
