/** Browser client for the in-product admin dashboard API. */

import type { ChatThread, ChatThreadSummary } from "@/lib/chat/types";

export interface ProductSiteRef {
  siteId: string;
  name: string;
  merchantName: string;
}

export interface OverviewData {
  totals: { total: number; open: number; "awaiting-customer": number; resolved: number };
  volume: { date: string; count: number }[];
  avgFirstResponseMs: number | null;
  windowDays: number;
}

export interface AdminSettings {
  autoReplyRules: string[];
  cannedReplies: string[];
  handoffMessage: string;
  fallbackMessage: string;
  escalationKeywords: string[];
  webhookUrl: string;
  webhookSecretSet: boolean;
}

export interface WebhookDeliveryRow {
  id: string;
  event: string;
  url: string;
  status: "success" | "failed";
  statusCode: number | null;
  error: string | null;
  responseSnippet: string;
  durationMs: number;
  createdAt: string;
}

export class AdminApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/admin${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const data = (await response.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      // keep default
    }
    throw new AdminApiError(message, response.status);
  }
  return (await response.json()) as T;
}

export const adminApi = {
  listSites() {
    return request<{ sites: ProductSiteRef[] }>("/sites");
  },
  overview(siteId: string) {
    return request<OverviewData>(`/overview?siteId=${encodeURIComponent(siteId)}`);
  },
  listConversations(siteId: string, params: { status?: string; search?: string; page?: number }) {
    const query = new URLSearchParams({ siteId });
    if (params.status) query.set("status", params.status);
    if (params.search) query.set("search", params.search);
    if (params.page) query.set("page", String(params.page));
    return request<{ conversations: ChatThreadSummary[]; total: number; page: number; pageSize: number }>(
      `/conversations?${query.toString()}`,
    );
  },
  getConversation(siteId: string, id: string) {
    return request<ChatThread>(`/conversations/${id}?siteId=${encodeURIComponent(siteId)}`);
  },
  replyConversation(siteId: string, id: string, body: string) {
    return request<ChatThread>(`/conversations/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({ siteId, body }),
    });
  },
  updateConversation(siteId: string, id: string, patch: { status?: string; assistantMuted?: boolean }) {
    return request<ChatThread>(`/conversations/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ siteId, ...patch }),
    });
  },
  getSettings(siteId: string) {
    return request<{ settings: AdminSettings }>(`/settings?siteId=${encodeURIComponent(siteId)}`);
  },
  saveSettings(siteId: string, settings: Partial<AdminSettings> & { webhookSecret?: string }) {
    return request<{ settings: AdminSettings }>("/settings", {
      method: "PUT",
      body: JSON.stringify({ siteId, ...settings }),
    });
  },
  listWebhooks(siteId: string) {
    return request<{ deliveries: WebhookDeliveryRow[] }>(`/webhooks?siteId=${encodeURIComponent(siteId)}`);
  },
  testWebhook(siteId: string) {
    return request<{ configured: boolean; delivered: boolean }>("/webhooks/test", {
      method: "POST",
      body: JSON.stringify({ siteId }),
    });
  },
  browseData(siteId: string, resource: "visitors" | "conversations" | "messages", page: number) {
    return request<{ resource: string; page: number; total?: number; rows: Record<string, unknown>[] }>(
      `/data?siteId=${encodeURIComponent(siteId)}&resource=${resource}&page=${page}`,
    );
  },
};
