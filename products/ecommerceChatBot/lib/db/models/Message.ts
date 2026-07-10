import { Schema } from "mongoose";

import {
  MESSAGE_AUTHORS,
  type MessageAuthor,
} from "@/lib/db/models/Conversation";

const MESSAGE_BODY_MAX_LENGTH = 8_000;
const AUTHOR_NAME_MAX_LENGTH = 160;
const CLIENT_MESSAGE_ID_MAX_LENGTH = 120;

export interface MessageAttributes {
  conversationId: Schema.Types.ObjectId;
  clientMessageId: string;
  author: MessageAuthor;
  authorName?: string;
  body: string;
  createdAt: Date;
  readByCustomerAt?: Date;
}

export const messageSchema = new Schema<MessageAttributes>(
  {
    conversationId: {
      type: Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    clientMessageId: {
      type: String,
      required: true,
      trim: true,
      maxlength: CLIENT_MESSAGE_ID_MAX_LENGTH,
    },
    author: { type: String, enum: MESSAGE_AUTHORS, required: true },
    authorName: {
      type: String,
      trim: true,
      maxlength: AUTHOR_NAME_MAX_LENGTH,
    },
    body: {
      type: String,
      required: true,
      trim: true,
      maxlength: MESSAGE_BODY_MAX_LENGTH,
    },
    createdAt: { type: Date, required: true, default: () => new Date() },
    readByCustomerAt: { type: Date },
  },
  { timestamps: false },
);

messageSchema.index({ conversationId: 1, createdAt: 1 });
messageSchema.index(
  { conversationId: 1, clientMessageId: 1 },
  { unique: true },
);
