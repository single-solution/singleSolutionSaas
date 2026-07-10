import { Types } from "@/lib/db/connection";
import type {
  ConversationMessageAttributes,
  MessageAuthor,
} from "@/lib/db/models/Conversation";
import type { MessageAttributes } from "@/lib/db/models/Message";
import { getTenantModels } from "@/lib/db/tenant";
import {
  CHAT_MESSAGE_PAGE_SIZE,
  sliceChatMessages,
  type ChatMessageSliceParams,
} from "@/lib/chat/messagePagination";
import type { ConversationLean } from "@/lib/chat/serializer";

export const CONVERSATION_SUMMARY_SELECT =
  "-messages" as const;

export function usesSplitMessageStorage(
  conversation: Pick<ConversationLean, "messagesMigratedAt">,
): boolean {
  return conversation.messagesMigratedAt instanceof Date;
}

export function legacyClientMessageId(
  conversationId: string,
  messageId: string,
): string {
  return `legacy:${conversationId}:${messageId}`;
}

function toEmbeddedShape(message: MessageAttributes & { _id: Types.ObjectId }): ConversationMessageAttributes {
  return {
    _id: message._id,
    author: message.author,
    authorName: message.authorName,
    body: message.body,
    createdAt: message.createdAt,
    readByCustomerAt: message.readByCustomerAt,
  };
}

export interface LoadedMessagePage {
  messages: ConversationMessageAttributes[];
  hasMoreOlder: boolean;
}

export async function loadConversationMessages(
  dataDbName: string,
  conversation: ConversationLean,
  sliceParams: ChatMessageSliceParams = {},
): Promise<LoadedMessagePage> {
  const limit = sliceParams.limit ?? CHAT_MESSAGE_PAGE_SIZE;

  if (usesSplitMessageStorage(conversation)) {
    const { Message } = await getTenantModels(dataDbName);
    const conversationId = conversation._id;
    const filter: Record<string, unknown> = { conversationId };

    if (sliceParams.beforeId) {
      const cursor = await Message.findOne({
        conversationId,
        _id: new Types.ObjectId(sliceParams.beforeId),
      }).lean<MessageAttributes & { _id: Types.ObjectId }>();
      if (cursor) {
        filter.createdAt = { $lt: cursor.createdAt };
      } else {
        return { messages: [], hasMoreOlder: false };
      }
      const older = await Message.find(filter)
        .sort({ createdAt: -1 })
        .limit(limit + 1)
        .lean<Array<MessageAttributes & { _id: Types.ObjectId }>>();
      const hasMoreOlder = older.length > limit;
      const page = (hasMoreOlder ? older.slice(0, limit) : older).reverse();
      return {
        messages: page.map(toEmbeddedShape),
        hasMoreOlder,
      };
    }

    if (sliceParams.sinceMillis !== null && sliceParams.sinceMillis !== undefined) {
      filter.createdAt = { $gte: new Date(sliceParams.sinceMillis) };
      const newer = await Message.find(filter)
        .sort({ createdAt: 1 })
        .lean<Array<MessageAttributes & { _id: Types.ObjectId }>>();
      const totalBefore = await Message.countDocuments({
        conversationId,
        createdAt: { $lt: new Date(sliceParams.sinceMillis) },
      });
      return {
        messages: newer.map(toEmbeddedShape),
        hasMoreOlder: totalBefore > 0,
      };
    }

    const latest = await Message.find({ conversationId })
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .lean<Array<MessageAttributes & { _id: Types.ObjectId }>>();
    const hasMoreOlder = latest.length > limit;
    const page = (hasMoreOlder ? latest.slice(0, limit) : latest).reverse();
    return {
      messages: page.map(toEmbeddedShape),
      hasMoreOlder,
    };
  }

  let embedded = conversation.messages ?? [];
  if (embedded.length === 0) {
    const { Conversation } = await getTenantModels(dataDbName);
    const legacyRow = await Conversation.findById(conversation._id)
      .select({ messages: 1 })
      .lean<{ messages?: ConversationMessageAttributes[] }>();
    embedded = legacyRow?.messages ?? [];
  }
  const slice = sliceChatMessages(embedded, sliceParams);
  return {
    messages: embedded.slice(slice.start, slice.end),
    hasMoreOlder: slice.hasMoreOlder,
  };
}

export async function findMessageByClientMessageId(
  dataDbName: string,
  conversationId: Types.ObjectId,
  clientMessageId: string,
): Promise<(MessageAttributes & { _id: Types.ObjectId }) | null> {
  const { Message } = await getTenantModels(dataDbName);
  return Message.findOne({ conversationId, clientMessageId }).lean<
    MessageAttributes & { _id: Types.ObjectId }
  >();
}

export async function markTeamMessagesReadByCustomer(
  dataDbName: string,
  conversation: ConversationLean,
): Promise<void> {
  const now = new Date();
  const { Conversation } = await getTenantModels(dataDbName);

  if (usesSplitMessageStorage(conversation)) {
    const { Message } = await getTenantModels(dataDbName);
    await Promise.all([
      Conversation.updateOne(
        { _id: conversation._id },
        { $set: { unreadByCustomer: 0 } },
      ),
      Message.updateMany(
        {
          conversationId: conversation._id,
          author: { $in: ["agent", "assistant"] },
          readByCustomerAt: { $exists: false },
        },
        { $set: { readByCustomerAt: now } },
      ),
    ]);
    return;
  }

  await Conversation.updateOne(
    { _id: conversation._id },
    {
      $set: {
        unreadByCustomer: 0,
        "messages.$[unread].readByCustomerAt": now,
      },
    },
    {
      arrayFilters: [
        {
          "unread.author": { $in: ["agent", "assistant"] },
          "unread.readByCustomerAt": { $exists: false },
        },
      ],
    },
  );
}

export function buildEmbeddedMessagePayload(input: {
  messageId: Types.ObjectId;
  author: MessageAuthor;
  authorName?: string;
  body: string;
  createdAt: Date;
}): ConversationMessageAttributes {
  return {
    _id: input.messageId,
    author: input.author,
    authorName: input.authorName,
    body: input.body,
    createdAt: input.createdAt,
  };
}
