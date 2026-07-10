import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface RequestContext {
  requestId: string;
  method?: string;
  path?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

export function resolveRequestId(headerValue: string | null): string {
  const trimmed = headerValue?.trim();
  if (trimmed && trimmed.length >= 8 && trimmed.length <= 128) {
    return trimmed;
  }
  return randomUUID();
}

export function runWithRequestContext<T>(
  context: RequestContext,
  callback: () => T,
): T {
  return storage.run(context, callback);
}
