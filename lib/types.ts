export type MerchantId = string;
export type SiteId = string;
export type UserId = string;

export type MerchantMemberRole = "owner" | "admin" | "member";

export interface UserSummary {
  id: UserId;
  email: string;
  name: string;
  isPlatformAdmin: boolean;
}

export interface InvitationInfo {
  email: string;
  name: string;
  merchantName: string;
}

export interface MerchantSummary {
  id: MerchantId;
  name: string;
  slug: string;
  role: MerchantMemberRole;
  createdAt: string;
  /** Owner still has an unaccepted invitation (admin list only). */
  pendingInvite?: boolean;
}

export interface SiteSummary {
  id: SiteId;
  merchantId: MerchantId;
  name: string;
  slug: string;
  primaryDomain: string;
  createdAt: string;
}

export interface ProductPlanQuota {
  metric: string;
  limit: number;
  unit?: string;
}

export interface ProductPlan {
  code: string;
  name: string;
  priceMonthly: number;
  currency: string;
  scopes: string[];
  quotas: ProductPlanQuota[];
}

export type ProductConfigFieldType =
  | "string"
  | "text"
  | "number"
  | "boolean"
  | "select"
  | "color"
  | "url"
  | "secret"
  | "list";

export type ProductConfigSectionKind = "settings" | "connection" | "integration";

export interface ProductConfigFieldOption {
  value: string;
  label: string;
}

export interface ProductConfigField {
  key: string;
  label: string;
  type: ProductConfigFieldType;
  default?: unknown;
  help: string;
  options: ProductConfigFieldOption[];
  required: boolean;
  secret: boolean;
  lockable: boolean;
  group: string;
}

export interface ProductConfigSection {
  key: string;
  title: string;
  description: string;
  kind: ProductConfigSectionKind;
  fields: ProductConfigField[];
}

export interface ProductTestAction {
  key: string;
  label: string;
  description: string;
  inputLabel: string;
  inputPlaceholder: string;
}

export interface ProductSummary {
  slug: string;
  name: string;
  description: string;
  baseUrl: string;
  status: "active" | "inactive";
  availableScopes: string[];
  plans: ProductPlan[];
  configSchema: ProductConfigSection[];
  testActions: ProductTestAction[];
  createdAt: string;
}

/** Result of pinging a running product at its Base URL and syncing its schema. */
export interface ProductConnectionStatus {
  reachable: boolean;
  latencyMs: number | null;
  error: string | null;
  fieldCount: number;
  actionCount: number;
  baseUrl: string;
}

/** A site + merchant currently subscribed to a product. */
export interface ProductSubscriber {
  siteId: SiteId;
  siteName: string;
  siteSlug: string;
  primaryDomain: string;
  merchantId: MerchantId;
  merchantName: string;
  planCode: string | null;
  planName: string | null;
  status: "active" | "suspended";
}

/**
 * Per-subscription (site + product) config as returned to the portal editor.
 * Secret field values are never returned; they are masked as `{ set }`.
 */
export interface SubscriptionConfigSummary {
  siteId: SiteId;
  productSlug: string;
  schema: ProductConfigSection[];
  testActions: ProductTestAction[];
  previewAvailable: boolean;
  draft: Record<string, unknown>;
  published: Record<string, unknown>;
  lockedFields: string[];
  /** Resolved product-default values a site inherits when it has no own value. Secrets masked as `{ set }`. */
  inheritedDefaults: Record<string, unknown>;
  /** Field keys the product default enforces globally; sites cannot override these. */
  enforcedFields: string[];
  /** Field keys this site has explicitly set (everything else inherits the product default). */
  overriddenFields: string[];
  version: number;
  hasUnpublishedChanges: boolean;
  publishedAt: string | null;
  draftUpdatedAt: string | null;
}

/**
 * Product-wide default config as returned to the admin editor (product scope).
 * Shares the draft/publish shape with site config; `lockedFields` here enforce a
 * default across every site.
 */
export interface ProductDefaultConfigSummary {
  productSlug: string;
  schema: ProductConfigSection[];
  testActions: ProductTestAction[];
  draft: Record<string, unknown>;
  published: Record<string, unknown>;
  lockedFields: string[];
  version: number;
  hasUnpublishedChanges: boolean;
  publishedAt: string | null;
  draftUpdatedAt: string | null;
}

export type SubscriptionStatus = "active" | "suspended" | "unassigned";

export interface SubscriptionSummary {
  productSlug: string;
  displayName: string;
  description: string;
  productStatus: "active" | "inactive";
  status: SubscriptionStatus;
  planCode: string | null;
  planName: string | null;
  priceMonthly: number | null;
  currency: string | null;
  scopes: string[];
  quotas: ProductPlanQuota[];
  availablePlans: ProductPlan[];
}

export interface ProductAccessTokenSummary {
  id: string;
  merchantId: MerchantId;
  siteId: SiteId;
  productSlug: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  allowedDomains: string[];
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface ProductAccessTokenCreated extends ProductAccessTokenSummary {
  plaintextToken: string;
}

export interface ProductUsageMetric {
  metric: string;
  used: number;
  limit: number | null;
  unit?: string;
  withinQuota: boolean;
}

export interface ProductUsageSummary {
  productSlug: string;
  period: string;
  metrics: ProductUsageMetric[];
  estimatedCost: number;
  currency: string;
}

export type ProductConversationStatus = "open" | "awaiting-customer" | "resolved";
export type ProductConversationAuthor = "customer" | "agent" | "assistant";

export interface ProductConversationSummary {
  id: string;
  customerName: string;
  status: ProductConversationStatus;
  lastMessageAt: string;
  lastMessagePreview: string;
  lastMessageAuthor: ProductConversationAuthor;
  unreadByTeam: number;
  assistantPaused: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProductConversationMessage {
  id: string;
  author: ProductConversationAuthor;
  authorName?: string;
  body: string;
  createdAt: string;
}

export interface ProductConversation extends ProductConversationSummary {
  messages: ProductConversationMessage[];
  hasMoreOlder?: boolean;
}

export interface AuditLogSummary {
  id: string;
  merchantId: MerchantId | null;
  actorUserId: UserId | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}
