import { CHAT_MESSAGE_AUTHORS, CHAT_STATUSES, type ChatMessageAuthor, type ChatStatus } from "./types";

const EPOCH = new Date(0);

export function coerceDate(value: unknown): Date | null {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function toIsoDate(value: unknown, fallback: Date = EPOCH): string {
  return (coerceDate(value) ?? fallback).toISOString();
}

export function toMillis(value: unknown, fallback = 0): number {
  return coerceDate(value)?.getTime() ?? fallback;
}

export function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function objectIdString(value: unknown): string {
  if (!value || typeof value !== "object" || !("toString" in value)) {
    return "";
  }
  return String(value);
}

export function normalizeChatStatus(value: unknown): ChatStatus {
  return typeof value === "string" && CHAT_STATUSES.includes(value as ChatStatus) ? (value as ChatStatus) : "open";
}

export function normalizeChatMessageAuthor(value: unknown): ChatMessageAuthor {
  return typeof value === "string" && CHAT_MESSAGE_AUTHORS.includes(value as ChatMessageAuthor) ? (value as ChatMessageAuthor) : "customer";
}
