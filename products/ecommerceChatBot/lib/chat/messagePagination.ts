/**
 * Message pagination over the embedded `messages` array (stored oldest ->
 * newest). The thread loads the most recent page; scroll-up requests older
 * pages via a `before` cursor; polling requests only messages newer than the
 * client's `since` cursor. The client merges every response by id.
 */

import { toMillis } from "./wireCoercion";

export const CHAT_MESSAGE_PAGE_SIZE = 20;

interface PageableMessage {
  _id?: unknown;
  createdAt?: unknown;
}

export interface ChatMessageSliceParams {
  beforeId?: string | null;
  sinceMillis?: number | null;
  limit?: number;
}

export interface ChatMessageSlice {
  start: number;
  end: number;
  hasMoreOlder: boolean;
}

function idString(value: unknown): string {
  return value == null ? "" : String(value);
}

export function sliceChatMessages(
  messages: PageableMessage[],
  { beforeId = null, sinceMillis = null, limit = CHAT_MESSAGE_PAGE_SIZE }: ChatMessageSliceParams = {},
): ChatMessageSlice {
  const total = messages.length;

  if (beforeId) {
    const index = messages.findIndex((message) => idString(message._id) === beforeId);
    const end = index === -1 ? 0 : index;
    const start = Math.max(0, end - limit);
    return { start, end, hasMoreOlder: start > 0 };
  }

  if (sinceMillis !== null) {
    let start = total;
    for (let index = 0; index < total; index += 1) {
      if (toMillis(messages[index].createdAt) >= sinceMillis) {
        start = index;
        break;
      }
    }
    return { start, end: total, hasMoreOlder: start > 0 };
  }

  const start = Math.max(0, total - limit);
  return { start, end: total, hasMoreOlder: start > 0 };
}

export function mergeChatMessagesById<T extends { id: string; createdAt: string }>(existing: T[], incoming: T[]): T[] {
  const byId = new Map<string, T>();
  for (const message of existing) {
    byId.set(message.id, message);
  }
  for (const message of incoming) {
    byId.set(message.id, message);
  }
  return [...byId.values()].sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
}
