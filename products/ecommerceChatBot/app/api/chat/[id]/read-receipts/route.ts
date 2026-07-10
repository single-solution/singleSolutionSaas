/**
 * POST /api/chat/[id]/read-receipts
 *
 * Marks unread agent/assistant messages as read by the visitor.
 */

import { Types } from "@/lib/db/connection";
import { getTenantModels } from "@/lib/db/tenant";
import { resolveChatCaller } from "@/lib/api/productAuth";
import { preflight, withCors } from "@/lib/api/cors";
import { noContent, notFound } from "@/lib/api/responses";
import {
  CONVERSATION_SUMMARY_SELECT,
  markTeamMessagesReadByCustomer,
} from "@/lib/chat/messageStorage";
import type { ConversationLean } from "@/lib/chat/serializer";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export function OPTIONS(request: Request) {
  return preflight(request);
}

export async function POST(request: Request, { params }: RouteContext) {
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

    if (conversation.unreadByCustomer > 0) {
      await markTeamMessagesReadByCustomer(dataDbName, conversation);
    }
    return noContent();
  });
}
