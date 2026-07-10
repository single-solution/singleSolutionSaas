/** POST /api/admin/conversations/[id]/messages - admin agent reply. */

import { Types } from "@/lib/db/connection";
import { getTenantModels } from "@/lib/db/tenant";
import { requireAdminApi, resolveAdminDataDb } from "@/lib/admin/guard";
import { badRequest, created, notFound, serverError } from "@/lib/api/responses";
import { toThreadLatestPage, type ConversationLean } from "@/lib/chat/serializer";
import { statusPatchAfterMessage } from "@/lib/chat/status";
import { CHAT_MESSAGE_BODY_MAX } from "@/lib/chat/types";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface PostBody {
  siteId?: unknown;
  body?: unknown;
}

export async function POST(request: Request, { params }: RouteContext) {
  const identity = requireAdminApi(request);
  if (identity instanceof Response) return identity;

  let parsed: PostBody;
  try {
    parsed = (await request.json()) as PostBody;
  } catch {
    return badRequest("Invalid request body.");
  }
  const siteId = typeof parsed.siteId === "string" ? parsed.siteId.trim() : "";
  const body = typeof parsed.body === "string" ? parsed.body.trim() : "";
  if (!siteId) {
    return badRequest("siteId is required.");
  }
  if (!body) {
    return badRequest("Message cannot be empty.");
  }
  if (body.length > CHAT_MESSAGE_BODY_MAX) {
    return badRequest("Message too long.");
  }

  const { id } = await params;
  if (!Types.ObjectId.isValid(id)) {
    return notFound("Conversation not found.");
  }
  const dataDbName = await resolveAdminDataDb(identity, siteId);
  if (!dataDbName) {
    return badRequest("Unknown site.");
  }

  const { Conversation } = await getTenantModels(dataDbName);
  const conversation = await Conversation.findOne({ _id: new Types.ObjectId(id), siteId }).lean<ConversationLean>();
  if (!conversation) {
    return notFound("Conversation not found.");
  }

  try {
    const now = new Date();
    await Conversation.updateOne(
      { _id: conversation._id },
      {
        $push: { messages: { author: "agent", authorName: identity.name || "Agent", body, createdAt: now } },
        $set: {
          lastMessageAt: now,
          lastMessagePreview: body.slice(0, 280),
          lastMessageAuthor: "agent",
          unreadByTeam: 0,
          assistantMuted: false,
          ...statusPatchAfterMessage(conversation.status, "team"),
        },
        $unset: { assistantMuteReason: "", assistantMutedAt: "" },
        $inc: { unreadByCustomer: 1 },
      },
    );
    const refreshed = await Conversation.findById(conversation._id).lean<ConversationLean>();
    if (!refreshed) {
      return serverError("Conversation vanished while replying.");
    }
    return created(toThreadLatestPage(refreshed));
  } catch {
    return serverError("Could not send the reply. Please try again.");
  }
}
