/**
 * POST /api/internal/test
 *
 * Platform-only dry-run harness. The portal calls this with a declared test
 * `action`, sample `input`, and the site's draft `config`. Nothing is persisted;
 * it lets merchants and admins try config changes before publishing.
 */

import { requireInternalAuth } from "@/lib/api/internalAuth";
import { badRequest, ok } from "@/lib/api/responses";
import { generateAssistantReplies } from "@/lib/chat/assistant";

export const dynamic = "force-dynamic";

interface TestBody {
  action?: unknown;
  input?: unknown;
  config?: unknown;
}

export async function POST(request: Request) {
  const unauthorizedResponse = requireInternalAuth(request);
  if (unauthorizedResponse) return unauthorizedResponse;

  let parsed: TestBody;
  try {
    parsed = (await request.json()) as TestBody;
  } catch {
    return badRequest("Invalid request body.");
  }

  const action = typeof parsed.action === "string" ? parsed.action : "";
  const input = typeof parsed.input === "string" ? parsed.input : "";
  const config = parsed.config && typeof parsed.config === "object" ? (parsed.config as Record<string, unknown>) : {};

  if (action === "assistant-reply") {
    const { replies, escalate } = generateAssistantReplies(input, config);
    return ok({ result: { replies, escalate } });
  }

  return badRequest(`Unknown test action: ${action || "(none)"}`);
}
