import { loadEnvironment } from "@/lib/env";
import { getRequestContext } from "@/lib/logging/requestContext";
import { redactValue } from "@/lib/logging/redact";

export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug";

const LEVEL_RANK: Record<LogLevel, number> = {
  fatal: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

const SERVICE_NAME = "ecommerce-chatbot";

function resolveMinLevel(): LogLevel {
  const configured = process.env.LOG_LEVEL?.trim().toLowerCase();
  if (
    configured === "fatal" ||
    configured === "error" ||
    configured === "warn" ||
    configured === "info" ||
    configured === "debug"
  ) {
    return configured;
  }
  return loadEnvironment().nodeEnv === "production" ? "info" : "debug";
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_RANK[level] <= LEVEL_RANK[resolveMinLevel()];
}

function write(level: LogLevel, summary: string, fields: Record<string, unknown> = {}): void {
  if (!shouldLog(level)) {
    return;
  }
  const context = getRequestContext();
  const payload = redactValue({
    timestamp: new Date().toISOString(),
    level: level.toUpperCase(),
    summary,
    service: SERVICE_NAME,
    requestId: context?.requestId,
    method: context?.method,
    path: context?.path,
    ...fields,
  }) as Record<string, unknown>;

  const line =
    loadEnvironment().nodeEnv === "production"
      ? JSON.stringify(payload)
      : `[${payload.level}] ${payload.summary}${payload.requestId ? ` requestId=${payload.requestId}` : ""}${
          Object.keys(fields).length > 0 ? ` ${JSON.stringify(redactValue(fields))}` : ""
        }`;

  if (level === "fatal" || level === "error") {
    process.stderr.write(`${line}\n`);
    return;
  }
  process.stdout.write(`${line}\n`);
}

export const logger = {
  fatal(summary: string, fields?: Record<string, unknown>) {
    write("fatal", summary, fields);
  },
  error(summary: string, fields?: Record<string, unknown>) {
    write("error", summary, fields);
  },
  warn(summary: string, fields?: Record<string, unknown>) {
    write("warn", summary, fields);
  },
  info(summary: string, fields?: Record<string, unknown>) {
    write("info", summary, fields);
  },
  debug(summary: string, fields?: Record<string, unknown>) {
    write("debug", summary, fields);
  },
};
