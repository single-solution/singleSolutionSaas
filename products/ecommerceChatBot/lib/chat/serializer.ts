import type { Types } from "mongoose";

import type { ConversationAttributes, ConversationMessageAttributes } from "@/lib/db/models/Conversation";
import {
  loadConversationMessages,
} from "./messageStorage";
import {
  CHAT_MESSAGE_PAGE_SIZE,
  type ChatMessageSliceParams,
} from "./messagePagination";
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

export async function toThreadPage(
  dataDbName: string,
  conversation: ConversationLean,
  sliceParams: ChatMessageSliceParams = { limit: CHAT_MESSAGE_PAGE_SIZE },
): Promise<ChatThread> {
  const page = await loadConversationMessages(dataDbName, conversation, sliceParams);
  return toThread(conversation, page);
}

/** Serialize a thread carrying only its most recent message page. */
export async function toThreadLatestPage(
  dataDbName: string,
  conversation: ConversationLean,
): Promise<ChatThread> {
  return toThreadPage(dataDbName, conversation, { limit: CHAT_MESSAGE_PAGE_SIZE });
}

export async function toThreadFromSummary(
  dataDbName: string,
  conversation: ConversationLean,
  embeddedMessages: ConversationMessageAttributes[] = [],
): Promise<ChatThread> {
  const page = await loadConversationMessages(dataDbName, {
    ...conversation,
    messages: embeddedMessages,
  });
  return toThread(conversation, page);
}
