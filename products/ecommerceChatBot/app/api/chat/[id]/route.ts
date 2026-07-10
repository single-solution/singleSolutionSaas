/**
 * GET /api/chat/[id]
 *
 * Fetch a conversation the calling visitor owns. Supports poll (`since` + ETag
 * 304), older-page (`before`) pagination, and marks unread agent/assistant
 * messages read on a full open.
 */

import { Types } from "@/lib/db/connection";
import { getTenantModels } from "@/lib/db/tenant";
import { resolveChatCaller } from "@/lib/api/productAuth";
import { preflight, withCors } from "@/lib/api/cors";
import { notFound, notModified, ok } from "@/lib/api/responses";
import { CHAT_MESSAGE_PAGE_SIZE } from "@/lib/chat/messagePagination";
import {
  CONVERSATION_SUMMARY_SELECT,
  markTeamMessagesReadByCustomer,
} from "@/lib/chat/messageStorage";
import {
  isThreadUnchangedForPoll,
  parsePollSince,
  threadPollEtag,
} from "@/lib/chat/poll";
import { toThreadPage, type ConversationLean } from "@/lib/chat/serializer";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export function OPTIONS(request: Request) {
  return preflight(request);
}

export async function GET(request: Request, { params }: RouteContext) {
  return withCors(request, async () => {
    const caller = await resolveChatCaller(request);
    if (caller instanceof Response) return caller;

    const { id } = await params;
    if (!Types.ObjectId.isValid(id)) {
      return notFound("Conversation not found.");
    }

    const dataDbName = caller.entitlement.dataDbName;
    const { Conversation } = await getTenantModels(dataDbName);
    const conversation = await Conversation.findOne({
      _id: new Types.ObjectId(id),
      siteId: caller.entitlement.siteId,
      visitorId: caller.visitorId,
    })
      .select(CONVERSATION_SUMMARY_SELECT)
      .lean<ConversationLean>();
    if (!conversation) {
      return notFound("Conversation not found.");
    }

    const url = new URL(request.url);
    const since = parsePollSince(url.searchParams.get("since"));
    const isPoll = since !== null;
    const beforeId = url.searchParams.get("before");
    const isOlderPage = beforeId !== null;
    const ifNoneMatch = request.headers.get("If-None-Match");
    const etag = threadPollEtag(conversation.lastMessageAt);

    if (
      isPoll &&
      isThreadUnchangedForPoll({
        lastMessageAt: conversation.lastMessageAt,
        updatedAt: conversation.updatedAt,
        since,
        ifNoneMatch,
      })
    ) {
      return notModified(etag);
    }

    let toReturn = conversation;
    if (!isPoll && !isOlderPage && conversation.unreadByCustomer > 0) {
      await markTeamMessagesReadByCustomer(dataDbName, conversation);
      const refreshed = await Conversation.findById(conversation._id)
        .select(CONVERSATION_SUMMARY_SELECT)
        .lean<ConversationLean>();
      if (refreshed) {
        toReturn = refreshed;
      }
    }

    const thread = await toThreadPage(dataDbName, toReturn, {
      beforeId,
      sinceMillis: since ? since.getTime() : null,
      limit: CHAT_MESSAGE_PAGE_SIZE,
    });
    const response = ok(thread);
    response.headers.set("ETag", etag);
    return response;
  });
}
