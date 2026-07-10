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

export function captureServerException(
  error: unknown,
  extra: Record<string, unknown> = {},
): void {
  const request = getRequestContext();
  resolveAdapter().captureException(error, {
    requestId: request?.requestId,
    path: request?.path,
    method: request?.method,
    ...extra,
  });
}
