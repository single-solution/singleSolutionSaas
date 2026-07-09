import mongoose, { Schema, type Model } from "mongoose";

/**
 * A visitor <-> merchant chat conversation. This product runs as one shared
 * service connected to many sites, so every conversation is scoped by `siteId` +
 * `productSlug` (resolved from the site's product access token) and owned by an
 * anonymous `visitorId` (a per-browser id, no login). One conversation per
 * visitor per site.
 */

export const CONVERSATION_STATUSES = ["open", "awaiting-customer", "resolved"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const MESSAGE_AUTHORS = ["customer", "agent", "assistant"] as const;
export type MessageAuthor = (typeof MESSAGE_AUTHORS)[number];

export const ASSISTANT_MUTE_REASONS = ["escalation", "manual"] as const;
export type AssistantMuteReason = (typeof ASSISTANT_MUTE_REASONS)[number];

export interface ConversationMessageAttributes {
  _id?: mongoose.Types.ObjectId;
  author: MessageAuthor;
  authorName?: string;
  body: string;
  createdAt: Date;
  readByCustomerAt?: Date;
}

export interface ConversationAttributes {
  siteId: string;
  productSlug: string;
  visitorId: string;
  customerName: string;
  status: ConversationStatus;
  lastMessageAt: Date;
  lastMessagePreview: string;
  lastMessageAuthor: MessageAuthor;
  unreadByCustomer: number;
  unreadByTeam: number;
  assistantMuted?: boolean;
  assistantMuteReason?: AssistantMuteReason;
  assistantMutedAt?: Date;
  messages: ConversationMessageAttributes[];
}

const MESSAGE_BODY_MAX_LENGTH = 8_000;
const AUTHOR_NAME_MAX_LENGTH = 160;
const CUSTOMER_NAME_MAX_LENGTH = 160;
const PREVIEW_MAX_LENGTH = 280;
const VISITOR_ID_MAX_LENGTH = 64;

const messageSchema = new Schema<ConversationMessageAttributes>(
  {
    author: { type: String, enum: MESSAGE_AUTHORS, required: true },
    authorName: { type: String, trim: true, maxlength: AUTHOR_NAME_MAX_LENGTH },
    body: { type: String, required: true, trim: true, maxlength: MESSAGE_BODY_MAX_LENGTH },
    createdAt: { type: Date, required: true, default: () => new Date() },
    readByCustomerAt: { type: Date },
  },
  { _id: true },
);

const conversationSchema = new Schema<ConversationAttributes>(
  {
    siteId: { type: String, required: true, index: true },
    productSlug: { type: String, required: true, trim: true },
    visitorId: { type: String, required: true, trim: true, maxlength: VISITOR_ID_MAX_LENGTH },
    customerName: { type: String, required: true, trim: true, maxlength: CUSTOMER_NAME_MAX_LENGTH, default: "Visitor" },
    status: { type: String, enum: CONVERSATION_STATUSES, required: true, default: "open" },
    lastMessageAt: { type: Date, required: true, default: () => new Date() },
    lastMessagePreview: { type: String, required: true, trim: true, maxlength: PREVIEW_MAX_LENGTH, default: "" },
    lastMessageAuthor: { type: String, enum: MESSAGE_AUTHORS, required: true, default: "customer" },
    unreadByCustomer: { type: Number, required: true, default: 0, min: 0 },
    unreadByTeam: { type: Number, required: true, default: 0, min: 0 },
    assistantMuted: { type: Boolean, default: false },
    assistantMuteReason: { type: String, enum: ASSISTANT_MUTE_REASONS, required: false },
    assistantMutedAt: { type: Date },
    messages: { type: [messageSchema], default: [] },
  },
  { timestamps: true },
);

// One conversation per visitor per site.
conversationSchema.index({ siteId: 1, visitorId: 1 }, { unique: true });
// Agent inbox: filter by site + status, newest activity first.
conversationSchema.index({ siteId: 1, status: 1, lastMessageAt: -1 });

export const Conversation: Model<ConversationAttributes> =
  (mongoose.models.Conversation as Model<ConversationAttributes>) ?? mongoose.model<ConversationAttributes>("Conversation", conversationSchema);
