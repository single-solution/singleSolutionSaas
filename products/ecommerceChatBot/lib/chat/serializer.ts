import type { Types } from "mongoose";

import type { ConversationAttributes, ConversationMessageAttributes } from "@/lib/db/models/Conversation";
import { CHAT_MESSAGE_PAGE_SIZE, sliceChatMessages } from "./messagePagination";
import type { ChatMessage, ChatThread, ChatThreadSummary } from "./types";
import { asArray, asString, normalizeChatMessageAuthor, normalizeChatStatus, objectIdString, toIsoDate } from "./wireCoercion";

export type ConversationLean = ConversationAttributes & {
  _id: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
};

function toMessage(message: ConversationMessageAttributes): ChatMessage {
  return {
    id: objectIdString(message._id),
    author: normalizeChatMessageAuthor(message.author),
    authorName: message.authorName,
    body: asString(message.body),
    createdAt: toIsoDate(message.createdAt),
    readByCustomerAt: message.readByCustomerAt ? toIsoDate(message.readByCustomerAt) : undefined,
  };
}

export function summariseThread(conversation: ConversationLean): ChatThreadSummary {
  return {
    id: objectIdString(conversation._id),
    customerName: asString(conversation.customerName, "Visitor"),
    status: normalizeChatStatus(conversation.status),
    lastMessageAt: toIsoDate(conversation.lastMessageAt, new Date(toIsoDate(conversation.updatedAt ?? conversation.createdAt))),
    lastMessagePreview: asString(conversation.lastMessagePreview),
    lastMessageAuthor: normalizeChatMessageAuthor(conversation.lastMessageAuthor),
    unreadByCustomer: conversation.unreadByCustomer ?? 0,
    unreadByTeam: conversation.unreadByTeam ?? 0,
    assistantPaused: conversation.assistantMuted === true,
    assistantPauseReason: conversation.assistantMuteReason ?? null,
    assistantPausedAt: conversation.assistantMutedAt ? toIsoDate(conversation.assistantMutedAt) : undefined,
    createdAt: toIsoDate(conversation.createdAt),
    updatedAt: toIsoDate(conversation.updatedAt ?? conversation.createdAt),
  };
}

export function toThread(conversation: ConversationLean, page?: { messages: ConversationMessageAttributes[]; hasMoreOlder: boolean }): ChatThread {
  const messages = page?.messages ?? asArray<ConversationMessageAttributes>(conversation.messages);
  return {
    ...summariseThread(conversation),
    messages: messages.map(toMessage),
    hasMoreOlder: page?.hasMoreOlder ?? false,
  };
}

/** Serialize a thread carrying only its most recent message page. */
export function toThreadLatestPage(conversation: ConversationLean): ChatThread {
  const all = asArray<ConversationMessageAttributes>(conversation.messages);
  const slice = sliceChatMessages(all, { limit: CHAT_MESSAGE_PAGE_SIZE });
  return toThread(conversation, {
    messages: all.slice(slice.start, slice.end),
    hasMoreOlder: slice.hasMoreOlder,
  });
}
