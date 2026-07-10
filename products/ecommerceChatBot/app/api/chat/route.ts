/**
 * GET /api/chat
 *
 * Bootstrap for the widget: verifies the merchant token + visitor, returns chat
 * settings and the visitor's existing conversation (if any). Polled on the
 * widget's focus/blur cadence.
 */

import { getTenantModels } from "@/lib/db/tenant";
import { resolveChatCaller } from "@/lib/api/productAuth";
import { preflight, withCors } from "@/lib/api/cors";
import { ok } from "@/lib/api/responses";
import { getChatSettings } from "@/lib/chat/settings";
import { summariseThread, type ConversationLean } from "@/lib/chat/serializer";

export const dynamic = "force-dynamic";

export function OPTIONS(request: Request) {
  return preflight(request);
}

export async function GET(request: Request) {
  return withCors(request, async () => {
    const caller = await resolveChatCaller(request);
    if (caller instanceof Response) return caller;

    const settings = getChatSettings(caller.entitlement.config);
    if (!settings.enabled) {
      return ok({ enabled: false, threads: [], settings });
    }

    const { Conversation } = await getTenantModels(caller.entitlement.dataDbName);
    const doc = await Conversation.findOne({
      siteId: caller.entitlement.siteId,
      visitorId: caller.visitorId,
    }).lean<ConversationLean>();

    return ok({
      enabled: true,
      threads: doc ? [summariseThread(doc)] : [],
      settings,
    });
  });
}
