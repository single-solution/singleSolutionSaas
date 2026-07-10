/**
 * GET /api/internal/conversations/[id]?siteId=...&productSlug=...
 *
 * Platform-only: conversation detail for the agent inbox; marks it team-read.
 */

import { Types } from "@/lib/db/connection";
import { getTenantModels } from "@/lib/db/tenant";
import { requireInternalAuth } from "@/lib/api/internalAuth";
import { badRequest, notFound, ok } from "@/lib/api/responses";
import { loadEnvironment } from "@/lib/env";
import { resolveTenantBindingFromPlatform } from "@/lib/platform/tenantBinding";
import { CHAT_MESSAGE_PAGE_SIZE } from "@/lib/chat/messagePagination";
import { CONVERSATION_SUMMARY_SELECT } from "@/lib/chat/messageStorage";
import { toThreadPage, type ConversationLean } from "@/lib/chat/serializer";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, { params }: RouteContext) {
  const unauthorizedResponse = requireInternalAuth(request);
  if (unauthorizedResponse) return unauthorizedResponse;

  const url = new URL(request.url);
  const siteId = url.searchParams.get("siteId")?.trim();
  if (!siteId) {
    return badRequest("siteId is required.");
  }
  const productSlug =
    url.searchParams.get("productSlug")?.trim() || loadEnvironment().productSlug;
  const beforeId = url.searchParams.get("before");

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

  if (conversation.unreadByTeam > 0) {
    await Conversation.updateOne(
      { _id: conversation._id },
      { $set: { unreadByTeam: 0 } },
    );
    conversation.unreadByTeam = 0;
  }

  const thread = await toThreadPage(binding.dataDbName, conversation, {
    beforeId,
    limit: CHAT_MESSAGE_PAGE_SIZE,
  });
  return ok(thread);
}
