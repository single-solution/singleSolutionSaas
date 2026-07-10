import "server-only";

import { sanitizeErrorMessage } from "@/lib/logging/redact";
import { getRequestContext } from "@/lib/logging/requestContext";
import { logger } from "@/lib/logging/logger";

export interface ErrorTrackingAdapter {
  captureException(error: unknown, context?: Record<string, unknown>): void;
  captureMessage(message: string, context?: Record<string, unknown>): void;
}

class NoopErrorTrackingAdapter implements ErrorTrackingAdapter {
  captureException(): void {}

  captureMessage(): void {}
}

class DsnErrorTrackingAdapter implements ErrorTrackingAdapter {
  constructor(private readonly dsn: string) {}

  captureException(error: unknown, context: Record<string, unknown> = {}): void {
    logger.error("Captured server exception", {
      dsnConfigured: true,
      dsnSuffix: this.dsn.slice(-8),
      error: sanitizeErrorMessage(error),
      ...context,
    });
  }

  captureMessage(message: string, context: Record<string, unknown> = {}): void {
    logger.warn("Captured server message", {
      dsnConfigured: true,
      dsnSuffix: this.dsn.slice(-8),
      message,
      ...context,
    });
  }
}

let adapter: ErrorTrackingAdapter | null = null;

function resolveAdapter(): ErrorTrackingAdapter {
  if (adapter) {
    return adapter;
  }
  const dsn = process.env.ERROR_TRACKING_DSN?.trim();
  adapter = dsn ? new DsnErrorTrackingAdapter(dsn) : new NoopErrorTrackingAdapter();
  return adapter;
}

function buildTrackingContext(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const request = getRequestContext();
  return {
    requestId: request?.requestId,
    path: request?.path,
    method: request?.method,
    userId: request?.actorUserId ?? undefined,
    actorRole: request?.actorRole ?? undefined,
    ...extra,
  };
}

export function captureServerException(
  error: unknown,
  extra: Record<string, unknown> = {},
): void {
  resolveAdapter().captureException(error, buildTrackingContext(extra));
}

export function captureServerMessage(
  message: string,
  extra: Record<string, unknown> = {},
): void {
  resolveAdapter().captureMessage(message, buildTrackingContext(extra));
}

export function trackUnexpectedApiError(
  error: unknown,
  input: { path: string; method: string; statusCode?: number },
): void {
  if ((input.statusCode ?? 500) < 500) {
    return;
  }
  captureServerException(error, {
    path: input.path,
    method: input.method,
    statusCode: input.statusCode ?? 500,
  });
}
