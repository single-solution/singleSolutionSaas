/**
 * POST /api/internal/conversations/[id]/messages
 *
 * Platform-only: a merchant agent replies to a conversation. Clears the
 * assistant mute (a human has taken over) and notifies the visitor's widget via
 * the unread counter it polls.
 */

import { Types } from "@/lib/db/connection";
import { getTenantModels } from "@/lib/db/tenant";
import { requireInternalAuth } from "@/lib/api/internalAuth";
import { badRequest, created, notFound, serverError } from "@/lib/api/responses";
import { loadEnvironment } from "@/lib/env";
import { resolveTenantBindingFromPlatform } from "@/lib/platform/tenantBinding";
import {
  createAgentClientMessageId,
  normalizeClientMessageId,
} from "@/lib/chat/clientMessageId";
import { appendConversationMessage } from "@/lib/chat/messageService";
import { CONVERSATION_SUMMARY_SELECT } from "@/lib/chat/messageStorage";
import type { ConversationLean } from "@/lib/chat/serializer";
import { statusPatchAfterMessage } from "@/lib/chat/status";
import { CHAT_MESSAGE_BODY_MAX } from "@/lib/chat/types";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface PostBody {
  siteId?: unknown;
  productSlug?: unknown;
  body?: unknown;
  agentName?: unknown;
  clientMessageId?: unknown;
}

export async function POST(request: Request, { params }: RouteContext) {
  const unauthorizedResponse = requireInternalAuth(request);
  if (unauthorizedResponse) return unauthorizedResponse;

  let parsed: PostBody;
  try {
    parsed = (await request.json()) as PostBody;
  } catch {
    return badRequest("Invalid request body.");
  }

  const siteId = typeof parsed.siteId === "string" ? parsed.siteId.trim() : "";
  const productSlug =
    (typeof parsed.productSlug === "string" ? parsed.productSlug.trim() : "") ||
    loadEnvironment().productSlug;
  const body = typeof parsed.body === "string" ? parsed.body.trim() : "";
  const agentName =
    typeof parsed.agentName === "string" && parsed.agentName.trim()
      ? parsed.agentName.trim().slice(0, 160)
      : "Agent";
  if (!siteId) {
    return badRequest("siteId is required.");
  }
  if (!body) {
    return badRequest("Message cannot be empty.");
  }
  if (body.length > CHAT_MESSAGE_BODY_MAX) {
    return badRequest("Message too long.");
  }

  const binding = await resolveTenantBindingFromPlatform({
    siteId,
    productSlug,
    requireBridgeAccess: true,
  });
  if (!binding) {
    return notFound("Tenant binding not found or subscription is not active.");
  }

  const { id } = await params;
  if (!Types.ObjectId.isValid(id)) {
    return notFound("Conversation not found.");
  }

  const clientMessageId =
    normalizeClientMessageId(parsed.clientMessageId) ?? createAgentClientMessageId();

  const { Conversation } = await getTenantModels(binding.dataDbName);
  const conversation = await Conversation.findOne({
    _id: new Types.ObjectId(id),
    siteId,
  })
    .select(CONVERSATION_SUMMARY_SELECT)
    .lean<ConversationLean>();
  if (!conversation) {
    return notFound("Conversation not found.");
  }

  try {
    const now = new Date();
    const result = await appendConversationMessage({
      dataDbName: binding.dataDbName,
      conversation: { ...conversation, messages: [] },
      clientMessageId,
      author: "agent",
      authorName: agentName,
      body,
      createdAt: now,
      conversationPatch: {
        lastMessageAt: now,
        lastMessagePreview: body.slice(0, 280),
        lastMessageAuthor: "agent",
        unreadByTeam: 0,
        unreadByCustomer: 1,
        statusPatch: statusPatchAfterMessage(conversation.status, "team"),
        clearAssistantMute: true,
      },
    });
    return created(result.thread);
  } catch {
    return serverError("Could not send the reply. Please try again.");
  }
}
