/**
 * GET /api/internal/config-schema
 *
 * Platform-only. Returns this product's self-declared configuration schema and
 * test actions so the portal can sync them when connecting to this deployment.
 */

import { requireInternalAuth } from "@/lib/api/internalAuth";
import { ok } from "@/lib/api/responses";
import { CHATBOT_CONFIG_SCHEMA, CHATBOT_TEST_ACTIONS } from "@/lib/chat/configSchema";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const unauthorizedResponse = requireInternalAuth(request);
  if (unauthorizedResponse) return unauthorizedResponse;

  return ok({ configSchema: CHATBOT_CONFIG_SCHEMA, testActions: CHATBOT_TEST_ACTIONS });
}
