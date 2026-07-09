/**
 * GET  /api/admin/conversations/[id]?siteId= - thread detail.
 * PATCH /api/admin/conversations/[id]         - status change + assistant mute.
 */

import { connectDb, Types } from "@/lib/db/connection";
import { Conversation, CONVERSATION_STATUSES, type ConversationStatus } from "@/lib/db/models/Conversation";
import { requireAdminApi, requireSiteId } from "@/lib/admin/guard";
import { badRequest, notFound, ok, serverError } from "@/lib/api/responses";
import { toThreadLatestPage, type ConversationLean } from "@/lib/chat/serializer";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, { params }: RouteContext) {
  const identity = requireAdminApi(request);
  if (identity instanceof Response) return identity;
  const siteId = requireSiteId(request);
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
  return ok(toThreadLatestPage(conversation));
}

interface PatchBody {
  siteId?: unknown;
  status?: unknown;
  assistantMuted?: unknown;
}

export async function PATCH(request: Request, { params }: RouteContext) {
  const identity = requireAdminApi(request);
  if (identity instanceof Response) return identity;

  let parsed: PatchBody;
  try {
    parsed = (await request.json()) as PatchBody;
  } catch {
    return badRequest("Invalid request body.");
  }
  const siteId = typeof parsed.siteId === "string" ? parsed.siteId.trim() : "";
  if (!siteId) {
    return badRequest("siteId is required.");
  }
  const { id } = await params;
  if (!Types.ObjectId.isValid(id)) {
    return notFound("Conversation not found.");
  }

  const set: Record<string, unknown> = {};
  const unset: Record<string, unknown> = {};
  if (typeof parsed.status === "string") {
    if (!CONVERSATION_STATUSES.includes(parsed.status as ConversationStatus)) {
      return badRequest("Invalid status.");
    }
    set.status = parsed.status;
  }
  if (typeof parsed.assistantMuted === "boolean") {
    set.assistantMuted = parsed.assistantMuted;
    if (parsed.assistantMuted) {
      set.assistantMuteReason = "manual";
      set.assistantMutedAt = new Date();
    } else {
      unset.assistantMuteReason = "";
      unset.assistantMutedAt = "";
    }
  }
  if (Object.keys(set).length === 0 && Object.keys(unset).length === 0) {
    return badRequest("Nothing to update.");
  }

  await connectDb();
  try {
    const updated = await Conversation.findOneAndUpdate(
      { _id: new Types.ObjectId(id), siteId },
      { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) },
      { new: true },
    ).lean<ConversationLean>();
    if (!updated) {
      return notFound("Conversation not found.");
    }
    return ok(toThreadLatestPage(updated));
  } catch {
    return serverError("Could not update the conversation.");
  }
}
