/**
 * Wire types shared by the widget and the API. Mirrors the Mongoose attributes
 * in `Conversation` but with `Date -> string (ISO)` and `ObjectId -> string`.
 */

export const CHAT_STATUSES = ["open", "awaiting-customer", "resolved"] as const;
export type ChatStatus = (typeof CHAT_STATUSES)[number];

export const CHAT_MESSAGE_AUTHORS = ["customer", "agent", "assistant"] as const;
export type ChatMessageAuthor = (typeof CHAT_MESSAGE_AUTHORS)[number];

export type AssistantPauseReason = "escalation" | "manual";

export interface ChatMessage {
  id: string;
  author: ChatMessageAuthor;
  authorName?: string;
  body: string;
  /** ISO 8601 timestamp. */
  createdAt: string;
  readByCustomerAt?: string;
}

export interface ChatThreadSummary {
  id: string;
  customerName: string;
  status: ChatStatus;
  lastMessageAt: string;
  lastMessagePreview: string;
  lastMessageAuthor: ChatMessageAuthor;
  unreadByCustomer: number;
  unreadByTeam: number;
  assistantPaused: boolean;
  assistantPauseReason?: AssistantPauseReason | null;
  assistantPausedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatThread extends ChatThreadSummary {
  messages: ChatMessage[];
  hasMoreOlder?: boolean;
}

export const CHAT_MESSAGE_BODY_MAX = 4_000;
