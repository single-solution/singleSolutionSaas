import type {
  AuditLogSummary,
  InvitationInfo,
  MerchantBillingSummary,
  MerchantMemberSummary,
  MerchantOffboardingSummary,
  MerchantSummary,
  PaginatedResponse,
  ProductAccessTokenCreated,
  ProductAccessTokenRotation,
  ProductAccessTokenSummary,
  ProductConnectionStatus,
  ProductConversation,
  ProductConversationStatus,
  ProductConversationSummary,
  ProductDefaultConfigSummary,
  ProductSubscriber,
  ProductSummary,
  ProductUsageSummary,
  SiteDomainReadiness,
  SiteSummary,
  SubscriptionConfigSummary,
  SubscriptionHistoryEntry,
  SubscriptionSummary,
  UserSummary,
} from "@/lib/types";

export class PlatformApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "PlatformApiError";
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!response.ok) {
    throw new PlatformApiError(body.error ?? "Request failed", response.status, body.code);
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
  logout(scope: "current" | "all" = "current") {
    return request<{ success: boolean; scope: "current" | "all" }>("/api/auth/sessions", {
      method: "DELETE",
      body: JSON.stringify({ scope }),
    });
  },
  me() {
    return request<{ user: UserSummary }>("/api/auth/me");
  },
  updateProfile(input: { name: string; email?: string }) {
    return request<{
      user: UserSummary;
      sessionInvalidated?: boolean;
      message?: string;
    }>("/api/auth/me", {
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
    return request<{ merchant: MerchantSummary }>(
      `/api/merchants/${merchantId}`,
    );
  },
  listSites(merchantId: string) {
    return request<{ items: SiteSummary[] }>(
      `/api/merchants/${merchantId}/sites`,
    );
  },
  listAllSitesAdmin() {
    return request<{ items: SiteSummary[] }>("/api/admin/sites");
  },
  createSite(
    merchantId: string,
    input: { name: string; primaryDomain?: string },
  ) {
    return request<{ site: SiteSummary }>(
      `/api/merchants/${merchantId}/sites`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
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
  getSiteDomainReadiness(siteId: string) {
    return request<{ readiness: SiteDomainReadiness }>(
      `/api/sites/${siteId}/domain-readiness`,
    );
  },
  verifySiteDomain(siteId: string) {
    return request<{
      verified: boolean;
      verifiedAt: string | null;
      message: string;
      site: SiteDomainReadiness;
    }>(`/api/sites/${siteId}/domain-verifications`, { method: "POST" });
  },
  syncSiteTokenDomains(siteId: string) {
    return request<{ updated: number }>(
      `/api/sites/${siteId}/token-domain-syncs`,
      { method: "POST" },
    );
  },
  listSiteProducts(siteId: string) {
    return request<{ items: SubscriptionSummary[] }>(
      `/api/sites/${siteId}/products`,
    );
  },
  setSiteProductPlan(
    siteId: string,
    productSlug: string,
    input: {
      planCode?: string | null;
      status?: "active" | "suspended";
      action?: "restore" | "unassign";
      scopeOverrides?: string[] | null;
      quotaOverrides?: Array<{ metric: string; limit: number; unit?: string }> | null;
    },
  ) {
    return request<{ product: SubscriptionSummary }>(
      `/api/sites/${siteId}/products/${productSlug}`,
      {
        method: "PATCH",
        body: JSON.stringify(input),
      },
    );
  },
  listProductTokens(siteId: string, productSlug: string) {
    return request<{ items: ProductAccessTokenSummary[] }>(
      `/api/sites/${siteId}/products/${productSlug}/tokens`,
    );
  },
  createProductToken(
    siteId: string,
    productSlug: string,
    name: string,
    allowedDomains: string[] = [],
    expiresInDays?: number,
  ) {
    return request<{ token: ProductAccessTokenCreated }>(
      `/api/sites/${siteId}/products/${productSlug}/tokens`,
      {
        method: "POST",
        body: JSON.stringify({ name, allowedDomains, expiresInDays }),
      },
    );
  },
  rotateProductToken(
    siteId: string,
    productSlug: string,
    tokenId: string,
    input: { name?: string; revokePrevious?: boolean; expiresInDays?: number } = {},
  ) {
    return request<{ rotation: ProductAccessTokenRotation }>(
      `/api/sites/${siteId}/products/${productSlug}/tokens/${tokenId}/rotations`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
  },
  revokeProductToken(siteId: string, productSlug: string, tokenId: string) {
    return request<{ success: boolean }>(
      `/api/sites/${siteId}/products/${productSlug}/tokens/${tokenId}`,
      {
        method: "DELETE",
      },
    );
  },
  getProductUsage(siteId: string, productSlug: string) {
    return request<{ usage: ProductUsageSummary }>(
      `/api/sites/${siteId}/products/${productSlug}/usage`,
    );
  },
  listProductConversations(
    siteId: string,
    productSlug: string,
    query: {
      status?: ProductConversationStatus;
      page?: number;
      pageSize?: number;
    } = {},
  ) {
    const params = new URLSearchParams();
    if (query.status) params.set("status", query.status);
    if (query.page) params.set("page", String(query.page));
    if (query.pageSize) params.set("pageSize", String(query.pageSize));
    const suffix = params.toString() ? `?${params.toString()}` : "";
    return request<{
      conversations: ProductConversationSummary[];
      total: number;
      page: number;
      pageSize: number;
    }>(`/api/sites/${siteId}/products/${productSlug}/conversations${suffix}`);
  },
  getProductConversation(
    siteId: string,
    productSlug: string,
    conversationId: string,
  ) {
    return request<{ conversation: ProductConversation }>(
      `/api/sites/${siteId}/products/${productSlug}/conversations/${conversationId}`,
    );
  },
  sendProductConversationMessage(
    siteId: string,
    productSlug: string,
    conversationId: string,
    body: string,
  ) {
    return request<{ conversation: ProductConversation }>(
      `/api/sites/${siteId}/products/${productSlug}/conversations/${conversationId}/messages`,
      { method: "POST", body: JSON.stringify({ body }) },
    );
  },
  getProductConfig(siteId: string, productSlug: string) {
    return request<{ config: SubscriptionConfigSummary }>(
      `/api/sites/${siteId}/products/${productSlug}/config`,
    );
  },
  saveProductConfigDraft(
    siteId: string,
    productSlug: string,
    input: {
      values?: Record<string, unknown>;
      lockedFields?: string[];
      clearKeys?: string[];
    },
  ) {
    return request<{ config: SubscriptionConfigSummary }>(
      `/api/sites/${siteId}/products/${productSlug}/config`,
      {
        method: "PATCH",
        body: JSON.stringify(input),
      },
    );
  },
  publishProductConfig(siteId: string, productSlug: string) {
    return request<{ config: SubscriptionConfigSummary }>(
      `/api/sites/${siteId}/products/${productSlug}/config/publish`,
      { method: "POST" },
    );
  },
  getProductDefaults(productSlug: string) {
    return request<{ config: ProductDefaultConfigSummary }>(
      `/api/admin/products/${productSlug}/config`,
    );
  },
  saveProductDefaults(
    productSlug: string,
    input: { values?: Record<string, unknown>; lockedFields?: string[] },
  ) {
    return request<{ config: ProductDefaultConfigSummary }>(
      `/api/admin/products/${productSlug}/config`,
      {
        method: "PATCH",
        body: JSON.stringify(input),
      },
    );
  },
  publishProductDefaults(productSlug: string) {
    return request<{ config: ProductDefaultConfigSummary }>(
      `/api/admin/products/${productSlug}/config/publish`,
      {
        method: "POST",
      },
    );
  },
  openProductDashboard(productSlug: string, siteId?: string) {
    return request<{ url: string; expiresInSeconds: number }>(
      `/api/admin/products/${productSlug}/dashboard-session`,
      {
        method: "POST",
        body: JSON.stringify(siteId ? { siteId } : {}),
      },
    );
  },
  previewProduct(siteId: string, productSlug: string) {
    return request<{ embedUrl: string; expiresInSeconds: number }>(
      `/api/sites/${siteId}/products/${productSlug}/preview`,
      { method: "POST" },
    );
  },
  runProductTest(
    siteId: string,
    productSlug: string,
    action: string,
    input: string,
  ) {
    return request<{ result: unknown }>(
      `/api/sites/${siteId}/products/${productSlug}/test`,
      {
        method: "POST",
        body: JSON.stringify({ action, input }),
      },
    );
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
    return request<{ items: ProductSubscriber[] }>(
      `/api/admin/products/${slug}/subscribers`,
    );
  },
  testProductConnection(slug: string) {
    return request<{ status: ProductConnectionStatus }>(
      `/api/admin/products/${slug}/connection-test`,
      {
        method: "POST",
      },
    );
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
        | "name"
        | "description"
        | "baseUrl"
        | "status"
        | "availableScopes"
        | "plans"
        | "configSchema"
        | "testActions"
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
  createMerchant(input: {
    merchantName: string;
    ownerName: string;
    ownerEmail: string;
  }) {
    return request<{
      merchant: MerchantSummary;
      owner: UserSummary;
      inviteToken: string;
      emailSent: boolean;
      emailQueued: boolean;
    }>("/api/admin/merchants", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  resendMerchantInvite(merchantId: string) {
    return request<{
      inviteToken: string;
      emailSent: boolean;
      emailQueued: boolean;
      ownerEmail: string;
    }>(`/api/admin/merchants/${merchantId}/invitation`, { method: "POST" });
  },
  getMerchantBilling(merchantId: string) {
    return request<{ billing: MerchantBillingSummary }>(
      `/api/merchants/${merchantId}/billing`,
    );
  },
  listMerchantMembers(merchantId: string) {
    return request<{ items: MerchantMemberSummary[] }>(
      `/api/merchants/${merchantId}/members`,
    );
  },
  inviteMerchantMember(
    merchantId: string,
    input: { email: string; name: string; role: "admin" | "member" },
  ) {
    return request<{ member: MerchantMemberSummary }>(
      `/api/merchants/${merchantId}/members`,
      { method: "POST", body: JSON.stringify(input) },
    );
  },
  updateMerchantMemberRole(
    merchantId: string,
    userId: string,
    role: "owner" | "admin" | "member",
  ) {
    return request<{ member: MerchantMemberSummary }>(
      `/api/merchants/${merchantId}/members/${userId}`,
      { method: "PATCH", body: JSON.stringify({ role }) },
    );
  },
  removeMerchantMember(merchantId: string, userId: string) {
    return request<{ success: boolean }>(
      `/api/merchants/${merchantId}/members/${userId}`,
      { method: "DELETE" },
    );
  },
  sendOwnerRecovery(merchantId: string) {
    return request<{
      emailSent: boolean;
      emailQueued: boolean;
      ownerEmail: string;
    }>(`/api/merchants/${merchantId}/owner-recoveries`, { method: "POST" });
  },
  listSubscriptionHistory(merchantId: string, page = 1, pageSize = 20) {
    return request<PaginatedResponse<SubscriptionHistoryEntry>>(
      `/api/merchants/${merchantId}/subscription-histories?page=${page}&pageSize=${pageSize}`,
    );
  },
  getMerchantOffboarding(merchantId: string) {
    return request<{ offboarding: MerchantOffboardingSummary }>(
      `/api/merchants/${merchantId}/offboarding`,
    );
  },
  startMerchantOffboarding(merchantId: string) {
    return request<{ offboarding: MerchantOffboardingSummary }>(
      `/api/merchants/${merchantId}/offboarding`,
      { method: "POST" },
    );
  },
  restoreMerchant(merchantId: string) {
    return request<{ offboarding: MerchantOffboardingSummary }>(
      `/api/merchants/${merchantId}/offboarding/restorations`,
      { method: "POST" },
    );
  },
  requestMerchantExport(merchantId: string) {
    return request<{ offboarding: MerchantOffboardingSummary }>(
      `/api/merchants/${merchantId}/offboarding/exports`,
      { method: "POST" },
    );
  },
  scheduleMerchantDeletion(merchantId: string) {
    return request<{ offboarding: MerchantOffboardingSummary }>(
      `/api/merchants/${merchantId}/offboarding/deletions`,
      { method: "POST" },
    );
  },
  getInvitation(token: string) {
    return request<{ invitation: InvitationInfo }>(
      `/api/auth/invitations/${encodeURIComponent(token)}`,
    );
  },
  acceptInvitation(token: string, password: string) {
    return request<{ user: UserSummary }>("/api/auth/invitations/acceptance", {
      method: "POST",
      body: JSON.stringify({ token, password }),
    });
  },
};
