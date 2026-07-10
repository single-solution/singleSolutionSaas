import { Types } from "mongoose";

import { getTenantModels } from "@/lib/db/tenant";
import type { MessageAuthor } from "@/lib/db/models/Conversation";
import type { WebhookEvent } from "@/lib/db/models/WebhookDelivery";
import {
  buildEmbeddedMessagePayload,
  findMessageByClientMessageId,
  loadConversationMessages,
  usesSplitMessageStorage,
} from "@/lib/chat/messageStorage";
import {
  toThread,
  type ConversationLean,
} from "@/lib/chat/serializer";
import type { ChatThread } from "@/lib/chat/types";
import { enqueueUsageReport } from "@/lib/outbox/usageOutbox";
import { enqueueWebhookDelivery } from "@/lib/outbox/webhookOutbox";

export interface AppendConversationMessageInput {
  dataDbName: string;
  conversation: ConversationLean;
  clientMessageId: string;
  author: MessageAuthor;
  authorName?: string;
  body: string;
  createdAt?: Date;
  conversationPatch?: {
    lastMessageAt: Date;
    lastMessagePreview: string;
    lastMessageAuthor: MessageAuthor;
    unreadByCustomer?: number;
    unreadByTeam?: number;
    statusPatch?: Record<string, unknown>;
    assistantMuted?: boolean;
    assistantMuteReason?: "escalation" | "manual";
    assistantMutedAt?: Date;
    clearAssistantMute?: boolean;
  };
  usage?: {
    token: string;
    metric: string;
    quantity: number;
    idempotencyKey: string;
    siteId: string;
    productSlug: string;
  };
  webhook?: {
    siteId: string;
    event: WebhookEvent;
    idempotencyKey: string;
    payload: Record<string, unknown>;
  };
}

export interface AppendConversationMessageResult {
  duplicate: boolean;
  thread: ChatThread;
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: number }).code === 11_000
  );
}

export async function appendConversationMessage(
  input: AppendConversationMessageInput,
): Promise<AppendConversationMessageResult> {
  const existing = await findMessageByClientMessageId(
    input.dataDbName,
    input.conversation._id,
    input.clientMessageId,
  );
  if (existing) {
    return buildThreadResult(input, true);
  }

  const now = input.createdAt ?? new Date();
  const { Conversation, Message } = await getTenantModels(input.dataDbName);
  const dualWriteEmbedded = !usesSplitMessageStorage(input.conversation);
  const messageId = new Types.ObjectId();

  try {
    await Message.create({
      _id: messageId,
      conversationId: input.conversation._id,
      clientMessageId: input.clientMessageId,
      author: input.author,
      authorName: input.authorName,
      body: input.body,
      createdAt: now,
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return buildThreadResult(input, true);
    }
    throw error;
  }

  const patch = input.conversationPatch;
  const update: Record<string, unknown> = {
    $set: {
      lastMessageAt: patch?.lastMessageAt ?? now,
      lastMessagePreview: patch?.lastMessagePreview ?? input.body.slice(0, 280),
      lastMessageAuthor: patch?.lastMessageAuthor ?? input.author,
      ...(patch?.statusPatch ?? {}),
      ...(patch?.assistantMuted
        ? {
            assistantMuted: true,
            assistantMuteReason: patch.assistantMuteReason,
            assistantMutedAt: patch.assistantMutedAt ?? now,
          }
        : {}),
    },
  };

  if (patch?.clearAssistantMute) {
    update.$unset = { assistantMuteReason: "", assistantMutedAt: "" };
    (update.$set as Record<string, unknown>).assistantMuted = false;
  }

  const increment: Record<string, number> = {};
  if (patch?.unreadByCustomer) {
    increment.unreadByCustomer = patch.unreadByCustomer;
  }
  if (patch?.unreadByTeam) {
    increment.unreadByTeam = patch.unreadByTeam;
  }
  if (Object.keys(increment).length > 0) {
    update.$inc = increment;
  }

  if (dualWriteEmbedded) {
    update.$push = {
      messages: buildEmbeddedMessagePayload({
        messageId,
        author: input.author,
        authorName: input.authorName,
        body: input.body,
        createdAt: now,
      }),
    };
  }

  await Conversation.updateOne({ _id: input.conversation._id }, update);

  if (input.usage) {
    await enqueueUsageReport({
      dataDbName: input.dataDbName,
      idempotencyKey: input.usage.idempotencyKey,
      siteId: input.usage.siteId,
      productSlug: input.usage.productSlug,
      token: input.usage.token,
      metric: input.usage.metric,
      quantity: input.usage.quantity,
    });
  }

  if (input.webhook) {
    await enqueueWebhookDelivery({
      dataDbName: input.dataDbName,
      idempotencyKey: input.webhook.idempotencyKey,
      siteId: input.webhook.siteId,
      event: input.webhook.event,
      payload: input.webhook.payload,
    });
  }

  return buildThreadResult(input, false);
}

async function buildThreadResult(
  input: AppendConversationMessageInput,
  duplicate: boolean,
): Promise<AppendConversationMessageResult> {
  const { Conversation } = await getTenantModels(input.dataDbName);
  const refreshed = await Conversation.findById(input.conversation._id)
    .select("-messages")
    .lean<ConversationLean>();
  if (!refreshed) {
    throw new Error("Conversation vanished while posting message.");
  }
  const page = await loadConversationMessages(input.dataDbName, refreshed);
  return {
    duplicate,
    thread: toThread(refreshed, page),
  };
}
