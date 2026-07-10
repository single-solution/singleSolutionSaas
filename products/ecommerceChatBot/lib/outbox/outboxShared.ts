export const OUTBOX_STATUSES = ["pending", "processing", "completed", "dead"] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export const OUTBOX_DEFAULT_MAX_ATTEMPTS = 8;
export const OUTBOX_LEASE_MS = 60_000;
export const OUTBOX_BATCH_LIMIT = 25;

const SECRET_PATTERN =
  /(secret|password|token|authorization|bearer|api[_-]?key|signature)/i;

export function computeOutboxBackoff(attempts: number): Date {
  const cappedExponent = Math.min(attempts, 10);
  const delayMs = Math.min(3_600_000, 30_000 * 2 ** cappedExponent);
  const jitterMs = Math.floor(Math.random() * 5_000);
  return new Date(Date.now() + delayMs + jitterMs);
}

export function sanitizeOutboxError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Delivery failed";
  const redacted = raw
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(secret|password|token|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]");
  const lines = redacted
    .split("\n")
    .filter((line) => !SECRET_PATTERN.test(line))
    .join(" ")
    .trim();
  return lines.slice(0, 500) || "Delivery failed";
}

export function outboxLeaseUntil(): Date {
  return new Date(Date.now() + OUTBOX_LEASE_MS);
}
