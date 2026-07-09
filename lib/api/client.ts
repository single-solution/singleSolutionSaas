import type {
  AuditLogSummary,
  InvitationInfo,
  MerchantSummary,
  PaginatedResponse,
  ProductAccessTokenCreated,
  ProductAccessTokenSummary,
  ProductConnectionStatus,
  ProductConversation,
  ProductConversationStatus,
  ProductConversationSummary,
  ProductDefaultConfigSummary,
  ProductSubscriber,
  ProductSummary,
  ProductUsageSummary,
  SiteSummary,
  SubscriptionConfigSummary,
  SubscriptionSummary,
  UserSummary,
} from "@/lib/types";

export class PlatformApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PlatformApiError";
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new PlatformApiError(body.error ?? "Request failed", response.status);
  }
  return body as T;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      ...(init?.headers ?? {}),
    },
  });
  return parseResponse<T>(response);
}

export const platformApi = {
  login(email: string, password: string) {
    return request<{ user: UserSummary }>("/api/auth/sessions", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
  },
  logout() {
    return request<{ success: boolean }>("/api/auth/sessions", { method: "DELETE" });
  },
  me() {
    return request<{ user: UserSummary }>("/api/auth/me");
  },
  updateProfile(input: { name: string; email?: string }) {
    return request<{ user: UserSummary }>("/api/auth/me", {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  },
  changePassword(currentPassword: string, newPassword: string) {
    return request<{ user: UserSummary }>("/api/auth/password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    });
  },
  listMerchants() {
    return request<{ items: MerchantSummary[] }>("/api/merchants");
  },
  getMerchant(merchantId: string) {
    return request<{ merchant: MerchantSummary }>(`/api/merchants/${merchantId}`);
  },
  listSites(merchantId: string) {
    return request<{ items: SiteSummary[] }>(`/api/merchants/${merchantId}/sites`);
  },
  createSite(merchantId: string, input: { name: string; primaryDomain?: string }) {
    return request<{ site: SiteSummary }>(`/api/merchants/${merchantId}/sites`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  getSite(siteId: string) {
    return request<{ site: SiteSummary }>(`/api/sites/${siteId}`);
  },
  updateSite(siteId: string, input: { name?: string; primaryDomain?: string }) {
    return request<{ site: SiteSummary }>(`/api/sites/${siteId}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  },
  listSiteProducts(siteId: string) {
    return request<{ items: SubscriptionSummary[] }>(`/api/sites/${siteId}/products`);
  },
  setSiteProductPlan(
    siteId: string,
    productSlug: string,
    input: { planCode?: string | null; status?: "active" | "suspended" },
  ) {
    return request<{ product: SubscriptionSummary }>(`/api/sites/${siteId}/products/${productSlug}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  },
  listProductTokens(siteId: string, productSlug: string) {
    return request<{ items: ProductAccessTokenSummary[] }>(`/api/sites/${siteId}/products/${productSlug}/tokens`);
  },
  createProductToken(siteId: string, productSlug: string, name: string, allowedDomains: string[] = []) {
    return request<{ token: ProductAccessTokenCreated }>(`/api/sites/${siteId}/products/${productSlug}/tokens`, {
      method: "POST",
      body: JSON.stringify({ name, allowedDomains }),
    });
  },
  revokeProductToken(siteId: string, productSlug: string, tokenId: string) {
    return request<{ success: boolean }>(`/api/sites/${siteId}/products/${productSlug}/tokens/${tokenId}`, {
      method: "DELETE",
    });
  },
  getProductUsage(siteId: string, productSlug: string) {
    return request<{ usage: ProductUsageSummary }>(`/api/sites/${siteId}/products/${productSlug}/usage`);
  },
  listProductConversations(
    siteId: string,
    productSlug: string,
    query: { status?: ProductConversationStatus; page?: number; pageSize?: number } = {},
  ) {
    const params = new URLSearchParams();
    if (query.status) params.set("status", query.status);
    if (query.page) params.set("page", String(query.page));
    if (query.pageSize) params.set("pageSize", String(query.pageSize));
    const suffix = params.toString() ? `?${params.toString()}` : "";
    return request<{ conversations: ProductConversationSummary[]; total: number; page: number; pageSize: number }>(
      `/api/sites/${siteId}/products/${productSlug}/conversations${suffix}`,
    );
  },
  getProductConversation(siteId: string, productSlug: string, conversationId: string) {
    return request<{ conversation: ProductConversation }>(
      `/api/sites/${siteId}/products/${productSlug}/conversations/${conversationId}`,
    );
  },
  sendProductConversationMessage(siteId: string, productSlug: string, conversationId: string, body: string) {
    return request<{ conversation: ProductConversation }>(
      `/api/sites/${siteId}/products/${productSlug}/conversations/${conversationId}/messages`,
      { method: "POST", body: JSON.stringify({ body }) },
    );
  },
  getProductConfig(siteId: string, productSlug: string) {
    return request<{ config: SubscriptionConfigSummary }>(`/api/sites/${siteId}/products/${productSlug}/config`);
  },
  saveProductConfigDraft(
    siteId: string,
    productSlug: string,
    input: { values?: Record<string, unknown>; lockedFields?: string[]; clearKeys?: string[] },
  ) {
    return request<{ config: SubscriptionConfigSummary }>(`/api/sites/${siteId}/products/${productSlug}/config`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  },
  publishProductConfig(siteId: string, productSlug: string) {
    return request<{ config: SubscriptionConfigSummary }>(
      `/api/sites/${siteId}/products/${productSlug}/config/publish`,
      { method: "POST" },
    );
  },
  getProductDefaults(productSlug: string) {
    return request<{ config: ProductDefaultConfigSummary }>(`/api/admin/products/${productSlug}/config`);
  },
  saveProductDefaults(productSlug: string, input: { values?: Record<string, unknown>; lockedFields?: string[] }) {
    return request<{ config: ProductDefaultConfigSummary }>(`/api/admin/products/${productSlug}/config`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  },
  publishProductDefaults(productSlug: string) {
    return request<{ config: ProductDefaultConfigSummary }>(`/api/admin/products/${productSlug}/config/publish`, {
      method: "POST",
    });
  },
  openProductDashboard(productSlug: string, siteId?: string) {
    return request<{ url: string; expiresInSeconds: number }>(`/api/admin/products/${productSlug}/dashboard-session`, {
      method: "POST",
      body: JSON.stringify(siteId ? { siteId } : {}),
    });
  },
  previewProduct(siteId: string, productSlug: string) {
    return request<{ embedUrl: string; expiresInSeconds: number }>(
      `/api/sites/${siteId}/products/${productSlug}/preview`,
      { method: "POST" },
    );
  },
  runProductTest(siteId: string, productSlug: string, action: string, input: string) {
    return request<{ result: unknown }>(`/api/sites/${siteId}/products/${productSlug}/test`, {
      method: "POST",
      body: JSON.stringify({ action, input }),
    });
  },
  listProducts() {
    return request<{ items: ProductSummary[] }>("/api/products");
  },
  listAdminProducts() {
    return request<{ items: ProductSummary[] }>("/api/admin/products");
  },
  getAdminProduct(slug: string) {
    return request<{ product: ProductSummary }>(`/api/admin/products/${slug}`);
  },
  listProductSubscribers(slug: string) {
    return request<{ items: ProductSubscriber[] }>(`/api/admin/products/${slug}/subscribers`);
  },
  testProductConnection(slug: string) {
    return request<{ status: ProductConnectionStatus }>(`/api/admin/products/${slug}/connection-test`, {
      method: "POST",
    });
  },
  registerProduct(input: {
    slug: string;
    name: string;
    description?: string;
    baseUrl?: string;
    availableScopes?: string[];
    plans?: ProductSummary["plans"];
    configSchema?: ProductSummary["configSchema"];
    testActions?: ProductSummary["testActions"];
  }) {
    return request<{ product: ProductSummary }>("/api/admin/products", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  updateProduct(
    slug: string,
    input: Partial<
      Pick<
        ProductSummary,
        "name" | "description" | "baseUrl" | "status" | "availableScopes" | "plans" | "configSchema" | "testActions"
      >
    >,
  ) {
    return request<{ product: ProductSummary }>(`/api/admin/products/${slug}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  },
  listAuditLogs(merchantId: string, page = 1, pageSize = 20) {
    return request<PaginatedResponse<AuditLogSummary>>(
      `/api/merchants/${merchantId}/audit-logs?page=${page}&pageSize=${pageSize}`,
    );
  },
  listAllMerchantsAdmin() {
    return request<{ items: MerchantSummary[] }>("/api/admin/merchants");
  },
  createMerchant(input: { merchantName: string; ownerName: string; ownerEmail: string }) {
    return request<{ merchant: MerchantSummary; owner: UserSummary; inviteToken: string; emailSent: boolean }>(
      "/api/admin/merchants",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
  },
  resendMerchantInvite(merchantId: string) {
    return request<{ inviteToken: string; emailSent: boolean; ownerEmail: string }>(
      `/api/admin/merchants/${merchantId}/invitation`,
      { method: "POST" },
    );
  },
  getInvitation(token: string) {
    return request<{ invitation: InvitationInfo }>(`/api/auth/invitations/${encodeURIComponent(token)}`);
  },
  acceptInvitation(token: string, password: string) {
    return request<{ user: UserSummary }>("/api/auth/invitations/acceptance", {
      method: "POST",
      body: JSON.stringify({ token, password }),
    });
  },
};
