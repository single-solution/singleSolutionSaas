const CLIENT_MESSAGE_ID_MAX = 120;

function randomUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export function createClientMessageId(): string {
  return randomUuid();
}

export function createAgentClientMessageId(): string {
  return `agent:${randomUuid()}`;
}

export function createAssistantClientMessageId(
  parentClientMessageId: string,
  index: number,
): string {
  const parent = parentClientMessageId.slice(0, 80);
  return `assistant:${parent}:${index}`.slice(0, CLIENT_MESSAGE_ID_MAX);
}

export function normalizeClientMessageId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length < 8 || trimmed.length > CLIENT_MESSAGE_ID_MAX) {
    return null;
  }
  return trimmed;
}

export function usageIdempotencyKey(
  conversationId: string,
  clientMessageId: string,
): string {
  return `message:${conversationId}:${clientMessageId}`;
}

export function webhookIdempotencyKey(
  conversationId: string,
  clientMessageId: string,
  event: string,
): string {
  return `webhook:${event}:${conversationId}:${clientMessageId}`;
}
