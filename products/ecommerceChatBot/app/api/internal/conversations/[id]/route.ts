/**
 * GET /api/internal/conversations/[id]?siteId=...
 *
 * Platform-only: full conversation for the agent inbox; marks it team-read.
 */

import { connectDb, Types } from "@/lib/db/connection";
import { Conversation } from "@/lib/db/models/Conversation";
import { requireInternalAuth } from "@/lib/api/internalAuth";
import { badRequest, notFound, ok } from "@/lib/api/responses";
import { toThread, type ConversationLean } from "@/lib/chat/serializer";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, { params }: RouteContext) {
  const unauthorizedResponse = requireInternalAuth(request);
  if (unauthorizedResponse) return unauthorizedResponse;

  const siteId = new URL(request.url).searchParams.get("siteId")?.trim();
  if (!siteId) {
    return badRequest("siteId is required.");
  }
  const { id } = await params;
  if (!Types.ObjectId.isValid(id)) {
    return notFound("Conversation not found.");
  }

  await connectDb();
  const conversation = await Conversation.findOne({ _id: new Types.ObjectId(id), siteId }).lean<ConversationLean>();
  if (!conversation) {
    return notFound("Conversation not found.");
  }

  if (conversation.unreadByTeam > 0) {
    await Conversation.updateOne({ _id: conversation._id }, { $set: { unreadByTeam: 0 } });
    conversation.unreadByTeam = 0;
  }

  return ok(toThread(conversation));
}
