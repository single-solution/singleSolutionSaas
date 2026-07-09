import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, default: "" },
    name: { type: String, required: true, trim: true },
    isPlatformAdmin: { type: Boolean, required: true, default: false },
    sessionVersion: { type: Number, required: true, default: 0 },
    status: { type: String, enum: ["invited", "active"], required: true, default: "active" },
    inviteTokenHash: { type: String, default: null, index: true },
    inviteTokenExpiresAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export type UserDocument = InferSchemaType<typeof userSchema> & { _id: Schema.Types.ObjectId };

export const User: Model<UserDocument> =
  (models.User as Model<UserDocument> | undefined) ?? model<UserDocument>("User", userSchema);
