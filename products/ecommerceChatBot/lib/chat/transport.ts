"use client";

/** Client fetch wrappers for the chat API (polling today). */

import { getChatSessionHeaders } from "./session";
import type { ChatSettings } from "./settings";
import type { ChatMessage, ChatThread, ChatThreadSummary } from "./types";

export interface ChatBootstrap {
  enabled: boolean;
  threads: ChatThreadSummary[];
  settings: ChatSettings;
}

export class ChatRequestError extends Error {
  code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

async function jsonOrThrow(res: Response): Promise<unknown> {
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    let code: string | undefined;
    try {
      const body = (await res.json()) as { error?: string; code?: string };
      if (body?.error) message = body.error;
      code = body?.code;
    } catch {
      // ignore
    }
    throw new ChatRequestError(message, code);
  }
  return res.json();
}

function headers(extra?: Record<string, string>): Record<string, string> {
  return { ...getChatSessionHeaders(), ...extra };
}

export async function fetchChatBootstrap(): Promise<ChatBootstrap> {
  const res = await fetch("/api/chat", { method: "GET", cache: "no-store", headers: headers() });
  return (await jsonOrThrow(res)) as ChatBootstrap;
}

export async function fetchChatThread(id: string): Promise<ChatThread> {
  const res = await fetch(`/api/chat/${encodeURIComponent(id)}`, { method: "GET", cache: "no-store", headers: headers() });
  return (await jsonOrThrow(res)) as ChatThread;
}

export async function fetchOlderChatMessages(id: string, beforeId: string): Promise<ChatThread> {
  const params = new URLSearchParams({ before: beforeId });
  const res = await fetch(`/api/chat/${encodeURIComponent(id)}?${params}`, { method: "GET", cache: "no-store", headers: headers() });
  return (await jsonOrThrow(res)) as ChatThread;
}

export async function pollChatThread(id: string, since: string, etag?: string): Promise<ChatThread | null> {
  const params = new URLSearchParams({ since });
  const res = await fetch(`/api/chat/${encodeURIComponent(id)}?${params}`, {
    method: "GET",
    cache: "no-store",
    headers: headers(etag ? { "If-None-Match": etag } : undefined),
  });
  if (res.status === 304) return null;
  return (await jsonOrThrow(res)) as ChatThread;
}

export async function markChatThreadRead(threadId: string): Promise<void> {
  const res = await fetch(`/api/chat/${encodeURIComponent(threadId)}/read-receipts`, { method: "POST", headers: headers() });
  if (res.status === 204 || res.status === 304) return;
  if (!res.ok) {
    await jsonOrThrow(res);
  }
}

export async function startChatThread(): Promise<ChatThread> {
  const res = await fetch("/api/chat/conversations", { method: "POST", headers: headers({ "Content-Type": "application/json" }), body: "{}" });
  return (await jsonOrThrow(res)) as ChatThread;
}

export async function sendChatMessage(threadId: string, body: string): Promise<ChatThread> {
  const res = await fetch(`/api/chat/${encodeURIComponent(threadId)}/messages`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify({ body }),
  });
  return (await jsonOrThrow(res)) as ChatThread;
}

export function makeOptimisticMessage(args: { body: string; authorName?: string }): ChatMessage {
  return {
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    author: "customer",
    authorName: args.authorName,
    body: args.body,
    createdAt: new Date().toISOString(),
  };
}
