const SECRET_KEY_PATTERN =
  /(secret|password|token|authorization|bearer|api[_-]?key|signature|dsn)/i;

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) {
    return "***";
  }
  const head = local.slice(0, 1);
  return `${head}***@${domain}`;
}

export function maskToken(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 8) {
    return "[redacted]";
  }
  return `...${trimmed.slice(-8)}`;
}

export function redactString(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(EMAIL_PATTERN, (email) => maskEmail(email))
    .replace(
      /(secret|password|token|api[_-]?key|dsn)\s*[:=]\s*\S+/gi,
      "$1=[redacted]",
    );
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) {
    return "[truncated]";
  }
  if (value == null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    if (SECRET_KEY_PATTERN.test(value) && value.length > 12) {
      return maskToken(value);
    }
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, depth + 1));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const redacted: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        redacted[key] =
          typeof entry === "string" ? maskToken(entry) : "[redacted]";
        continue;
      }
      if (key === "body" || key === "requestBody" || key === "rawBody") {
        redacted[key] = "[omitted]";
        continue;
      }
      redacted[key] = redactValue(entry, depth + 1);
    }
    return redacted;
  }
  return String(value);
}

export function sanitizeErrorMessage(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Unexpected error";
  const redacted = redactString(raw)
    .split("\n")
    .filter((line) => !SECRET_KEY_PATTERN.test(line))
    .join(" ")
    .trim();
  return redacted.slice(0, 500) || "Unexpected error";
}
