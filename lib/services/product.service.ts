import {
  Merchant,
  Product,
  ProductAccessToken,
  ProductUsage,
  ProductUsageEvent,
  Site,
  Subscription,
  Types,
} from "@/lib/db";
import type {
  ProductAccessTokenCreated,
  ProductAccessTokenRotation,
  ProductAccessTokenSummary,
  ProductConfigSection,
  ProductPlan,
  ProductPlanQuota,
  ProductSummary,
  ProductTestAction,
  ProductUsageMetric,
  ProductUsageSummary,
  SubscriptionStatus,
  SubscriptionSummary,
} from "@/lib/types";
import {
  createPreviewToken,
  PREVIEW_TOKEN_TTL_SECONDS,
  resolveDraftConfig,
  resolvePublishedConfig,
} from "@/lib/services/productConfig.service";
import { generateProductToken, hashApiKey } from "@/lib/crypto";
import { loadEnvironment } from "@/lib/env";
import mongoose from "mongoose";
import { ensureSubscriptionDataDb } from "@/lib/services/tenantDb";
import {
  type RequestActor,
  writeAuditLog,
} from "@/lib/services/platform.service";
import { OutboundUrlError, validateOutboundUrl } from "@/lib/security/outboundUrl";
import { isProduction } from "@/lib/utils";
import {
  fetchProductConversation,
  fetchProductConversations,
  fetchProductSchema,
  postProductConversationReply,
  postProductTest,
  ProductBridgeError,
} from "@/lib/services/productBridge";
import {
  assignSubscriptionPlan,
  isRetentionActive,
  normalizeLegacySubscriptionStatus,
  resolvePlanOnProduct,
  restoreSubscription,
  SubscriptionLifecycleError,
  transitionSubscription,
  unassignSubscription,
} from "@/lib/services/subscriptionLifecycle.service";
import {
  countAssignedSubscriptionsForProduct,
  findRemovedPlanConflicts,
} from "@/lib/services/subscriptionReconciliation.service";
import { resolveTenantBinding, TenantBindingError } from "@/lib/services/tenantBinding.service";
import type { ProductConnectionStatus, ProductSubscriber } from "@/lib/types";

export class ProductCatalogConflictError extends Error {
  constructor(
    message: string,
    readonly conflicts: { planCode: string; count: number }[],
  ) {
    super(message);
    this.name = "ProductCatalogConflictError";
  }
}

export class ProductBaseUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductBaseUrlError";
  }
}

async function assertAllowedProductBaseUrl(baseUrl: string): Promise<void> {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return;
  }
  const environment = loadEnvironment();
  try {
    await validateOutboundUrl(trimmed, {
      isProduction: isProduction(environment),
      allowLocalhost: true,
    });
  } catch (error) {
    const message =
      error instanceof OutboundUrlError ? error.message : "Product Base URL is not allowed.";
    throw new ProductBaseUrlError(message);
  }
}

function toIso(value: Date): string {
  return value.toISOString();
}

function normalizeDomains(domains: string[]): string[] {
  const cleaned = domains
    .map((domain) => domain.trim().toLowerCase())
    .filter((domain) => domain.length > 0);
  return [...new Set(cleaned)];
}

function currentPeriod(date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  return `${year}-${month}`;
}

function mapPlan(plan: {
  code: string;
  name: string;
  priceMonthly: number;
  currency: string;
  scopes: string[];
  quotas: { metric: string; limit: number; unit?: string | null }[];
}): ProductPlan {
  return {
    code: plan.code,
    name: plan.name,
    priceMonthly: plan.priceMonthly,
    currency: plan.currency,
    scopes: [...plan.scopes],
    quotas: plan.quotas.map((quota) => ({
      metric: quota.metric,
      limit: quota.limit,
      ...(quota.unit ? { unit: quota.unit } : {}),
    })),
  };
}

function mapConfigSchema(sections: unknown): ProductConfigSection[] {
  if (!Array.isArray(sections)) {
    return [];
  }
  return sections.map((section) => {
    const raw = section as Record<string, unknown>;
    const fields = Array.isArray(raw.fields)
      ? (raw.fields as Record<string, unknown>[])
      : [];
    return {
      key: String(raw.key ?? ""),
      title: String(raw.title ?? ""),
      description: String(raw.description ?? ""),
      kind: (raw.kind as ProductConfigSection["kind"]) ?? "settings",
      fields: fields.map((field) => ({
        key: String(field.key ?? ""),
        label: String(field.label ?? ""),
        type:
          (field.type as ProductConfigSection["fields"][number]["type"]) ??
          "string",
        default: field.default ?? null,
        help: String(field.help ?? ""),
        options: Array.isArray(field.options)
          ? (field.options as Record<string, unknown>[]).map((option) => ({
              value: String(option.value ?? ""),
              label: String(option.label ?? ""),
            }))
          : [],
        required: Boolean(field.required),
        secret: Boolean(field.secret),
        lockable: field.lockable === undefined ? true : Boolean(field.lockable),
        group: String(field.group ?? ""),
      })),
    };
  });
}

function mapTestActions(actions: unknown): ProductTestAction[] {
  if (!Array.isArray(actions)) {
    return [];
  }
  return actions.map((action) => {
    const raw = action as Record<string, unknown>;
    return {
      key: String(raw.key ?? ""),
      label: String(raw.label ?? ""),
      description: String(raw.description ?? ""),
      inputLabel: String(raw.inputLabel ?? "Sample input"),
      inputPlaceholder: String(raw.inputPlaceholder ?? ""),
    };
  });
}

function mapProduct(
  product: {
    slug: string;
    name: string;
    description?: string | null;
    baseUrl?: string | null;
    status: "active" | "inactive";
    availableScopes: string[];
    plans: Parameters<typeof mapPlan>[0][];
    configSchema?: unknown;
    testActions?: unknown;
    createdAt: Date;
  },
  counts?: { active: number; suspended: number; archived: number },
): ProductSummary {
  return {
    slug: product.slug,
    name: product.name,
    description: product.description ?? "",
    baseUrl: product.baseUrl ?? "",
    status: product.status,
    availableScopes: [...product.availableScopes],
    plans: product.plans.map(mapPlan),
    configSchema: mapConfigSchema(product.configSchema),
    testActions: mapTestActions(product.testActions),
    createdAt: toIso(product.createdAt),
    ...(counts
      ? {
          subscriberCount: counts.active + counts.suspended + counts.archived,
          activeSubscriberCount: counts.active,
          suspendedSubscriberCount: counts.suspended,
        }
      : {}),
  };
}

interface Entitlement {
  planCode: string | null;
  planName: string | null;
  priceMonthly: number | null;
  currency: string | null;
  scopes: string[];
  quotas: ProductPlanQuota[];
}

function resolveEntitlement(
  plans: ProductPlan[],
  subscription: {
    planCode?: string | null;
    scopeOverrides?: string[] | null;
    quotaOverrides?: { metric: string; limit: number }[] | null;
  } | null,
): Entitlement {
  if (!subscription || !subscription.planCode) {
    return {
      planCode: null,
      planName: null,
      priceMonthly: null,
      currency: null,
      scopes: [],
      quotas: [],
    };
  }

  const plan =
    plans.find((candidate) => candidate.code === subscription.planCode) ?? null;
  const scopes = subscription.scopeOverrides ?? plan?.scopes ?? [];

  const overrideByMetric = new Map(
    (subscription.quotaOverrides ?? []).map((quota) => [
      quota.metric,
      quota.limit,
    ]),
  );
  const quotas: ProductPlanQuota[] = (plan?.quotas ?? []).map((quota) => ({
    metric: quota.metric,
    limit: overrideByMetric.get(quota.metric) ?? quota.limit,
    ...(quota.unit ? { unit: quota.unit } : {}),
  }));

  return {
    planCode: subscription.planCode,
    planName: plan?.name ?? null,
    priceMonthly: plan?.priceMonthly ?? null,
    currency: plan?.currency ?? null,
    scopes: [...scopes],
    quotas,
  };
}

export async function listProducts(): Promise<ProductSummary[]> {
  const [products, subscriptionCounts] = await Promise.all([
    Product.find().sort({ createdAt: -1 }).lean(),
    Subscription.aggregate<{
      _id: { productSlug: string; status: "active" | "suspended" | "archived" };
      count: number;
    }>([
      { $match: { planCode: { $ne: null } } },
      {
        $group: {
          _id: { productSlug: "$productSlug", status: "$status" },
          count: { $sum: 1 },
        },
      },
    ]),
  ]);
  const countsByProduct = new Map<
    string,
    { active: number; suspended: number; archived: number }
  >();
  for (const entry of subscriptionCounts) {
    const counts = countsByProduct.get(entry._id.productSlug) ?? {
      active: 0,
      suspended: 0,
      archived: 0,
    };
    counts[entry._id.status] = entry.count;
    countsByProduct.set(entry._id.productSlug, counts);
  }
  return products.map((product) =>
    mapProduct(
      product,
      countsByProduct.get(product.slug) ?? {
        active: 0,
        suspended: 0,
        archived: 0,
      },
    ),
  );
}

export async function getProduct(slug: string): Promise<ProductSummary | null> {
  const product = await Product.findOne({ slug: slug.toLowerCase() }).lean();
  return product ? mapProduct(product) : null;
}

function countFields(sections: ProductConfigSection[]): number {
  return sections.reduce((total, section) => total + section.fields.length, 0);
}

/**
 * Pings the running product at its Base URL and syncs its self-declared config
 * schema + test actions into the catalog. This is how the portal "connects" to a
 * running product deployment.
 */
export async function testProductConnection(
  actor: RequestActor,
  slug: string,
): Promise<ProductConnectionStatus | null> {
  const product = await Product.findOne({ slug: slug.toLowerCase() });
  if (!product) {
    return null;
  }
  const baseUrl = (product.baseUrl ?? "").trim();
  if (!baseUrl) {
    return {
      reachable: false,
      latencyMs: null,
      error: "No Base URL set for this product.",
      fieldCount: 0,
      actionCount: 0,
      baseUrl: "",
    };
  }

  const startedAt = Date.now();
  try {
    const schema = await fetchProductSchema(baseUrl);
    const latencyMs = Date.now() - startedAt;
    const configSchema = mapConfigSchema(schema.configSchema);
    const testActions = mapTestActions(schema.testActions);
    product.set("configSchema", configSchema);
    product.set("testActions", testActions);
    await product.save();

    await writeAuditLog({
      merchantId: null,
      actorUserId: actor.userId,
      action: "product.connection_synced",
      resourceType: "product",
      resourceId: product._id.toString(),
      metadata: {
        slug: product.slug,
        fields: countFields(configSchema),
        actions: testActions.length,
      },
    });

    return {
      reachable: true,
      latencyMs,
      error: null,
      fieldCount: countFields(configSchema),
      actionCount: testActions.length,
      baseUrl,
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const message =
      error instanceof ProductBridgeError
        ? error.message
        : "Product service is unreachable.";
    return {
      reachable: false,
      latencyMs,
      error: message,
      fieldCount: countFields(mapConfigSchema(product.configSchema)),
      actionCount: mapTestActions(product.testActions).length,
      baseUrl,
    };
  }
}

/** Every site/merchant currently subscribed to this product, with plan + status. */
export async function listProductSubscribers(
  slug: string,
): Promise<ProductSubscriber[] | null> {
  const product = await Product.findOne({ slug: slug.toLowerCase() }).lean();
  if (!product) {
    return null;
  }
  const subscriptions = await Subscription.find({
    productSlug: product.slug,
  }).lean();
  const sites = await Site.find({
    _id: { $in: subscriptions.map((subscription) => subscription.siteId) },
  }).lean();
  const siteById = new Map(sites.map((site) => [site._id.toString(), site]));
  const merchants = await Merchant.find({
    _id: {
      $in: [...new Set(sites.map((site) => site.merchantId.toString()))].map(
        (id) => new Types.ObjectId(id),
      ),
    },
  }).lean();
  const merchantById = new Map(
    merchants.map((merchant) => [merchant._id.toString(), merchant]),
  );

  return subscriptions
    .map((subscription) => {
      const site = siteById.get(subscription.siteId.toString());
      if (!site) {
        return null;
      }
      const merchant = merchantById.get(site.merchantId.toString());
      const plan =
        product.plans.find(
          (candidate) => candidate.code === subscription.planCode,
        ) ?? null;
      return {
        siteId: site._id.toString(),
        siteName: site.name,
        siteSlug: site.slug,
        primaryDomain: site.primaryDomain ?? "",
        merchantId: site.merchantId.toString(),
        merchantName: merchant?.name ?? "Unknown",
        planCode: subscription.planCode ?? null,
        planName: plan?.name ?? null,
        status: normalizeLegacySubscriptionStatus(subscription),
      } satisfies ProductSubscriber;
    })
    .filter((entry): entry is ProductSubscriber => entry !== null);
}

export async function registerProduct(
  actor: RequestActor,
  input: {
    slug: string;
    name: string;
    description?: string;
    baseUrl?: string;
    availableScopes?: string[];
    plans?: ProductPlan[];
    configSchema?: ProductConfigSection[];
    testActions?: ProductTestAction[];
  },
): Promise<ProductSummary> {
  if (input.baseUrl) {
    await assertAllowedProductBaseUrl(input.baseUrl);
  }
  const product = await Product.create({
    slug: input.slug.toLowerCase(),
    name: input.name,
    description: input.description ?? "",
    baseUrl: input.baseUrl ?? "",
    availableScopes: input.availableScopes ?? [],
    plans: input.plans ?? [],
    configSchema: input.configSchema ?? [],
    testActions: input.testActions ?? [],
  });

  await writeAuditLog({
    merchantId: null,
    actorUserId: actor.userId,
    action: "product.registered",
    resourceType: "product",
    resourceId: product._id.toString(),
    metadata: { slug: product.slug, name: product.name },
  });

  return mapProduct(product);
}

export async function updateProduct(
  actor: RequestActor,
  slug: string,
  input: {
    name?: string;
    description?: string;
    baseUrl?: string;
    status?: "active" | "inactive";
    availableScopes?: string[];
    plans?: ProductPlan[];
    configSchema?: ProductConfigSection[];
    testActions?: ProductTestAction[];
  },
): Promise<ProductSummary | null> {
  const existing = await Product.findOne({ slug: slug.toLowerCase() }).lean();
  if (!existing) {
    return null;
  }

  if (input.baseUrl !== undefined) {
    await assertAllowedProductBaseUrl(input.baseUrl);
  }

  if (input.plans) {
    const nextPlanCodes = input.plans.map((plan) => plan.code);
    const conflicts = await findRemovedPlanConflicts(existing.slug, nextPlanCodes);
    if (conflicts.length > 0) {
      const summary = conflicts
        .map((conflict) => `${conflict.planCode} (${conflict.count} subscriptions)`)
        .join(", ");
      throw new ProductCatalogConflictError(
        `Cannot remove or rename plans still assigned to subscriptions: ${summary}. Reassign those sites first.`,
        conflicts,
      );
    }
  }

  if (input.status === "inactive") {
    const assignedCount = await countAssignedSubscriptionsForProduct(existing.slug);
    if (assignedCount > 0) {
      throw new ProductCatalogConflictError(
        `Cannot deactivate product while ${assignedCount} active or suspended subscriptions remain. Unassign those sites first.`,
        [{ planCode: "*", count: assignedCount }],
      );
    }
  }

  const product = await Product.findOneAndUpdate(
    { slug: slug.toLowerCase() },
    input,
    { new: true },
  ).lean();
  if (!product) {
    return null;
  }

  await writeAuditLog({
    merchantId: null,
    actorUserId: actor.userId,
    action: "product.updated",
    resourceType: "product",
    resourceId: product._id.toString(),
    metadata: { slug: product.slug },
  });

  return mapProduct(product);
}

export async function listSiteProducts(
  siteId: string,
): Promise<SubscriptionSummary[]> {
  const [products, subscriptions] = await Promise.all([
    Product.find({ status: "active" }).sort({ name: 1 }).lean(),
    Subscription.find({ siteId: new Types.ObjectId(siteId) }).lean(),
  ]);

  const subscriptionBySlug = new Map(
    subscriptions.map((subscription) => [
      subscription.productSlug,
      subscription,
    ]),
  );

  return products.map((product) => {
    const subscription = subscriptionBySlug.get(product.slug) ?? null;
    const plans = product.plans.map(mapPlan);
    const entitlement = resolveEntitlement(plans, subscription);
    let status: SubscriptionStatus = "unassigned";
    if (subscription) {
      status = normalizeLegacySubscriptionStatus(subscription);
    }
    return {
      productSlug: product.slug,
      displayName: product.name,
      description: product.description ?? "",
      productStatus: product.status,
      status,
      planCode: entitlement.planCode,
      planName: entitlement.planName,
      priceMonthly: entitlement.priceMonthly,
      currency: entitlement.currency,
      scopes: entitlement.scopes,
      quotas: entitlement.quotas,
      scopeOverrides: subscription?.scopeOverrides ?? null,
      quotaOverrides: subscription?.quotaOverrides
        ? subscription.quotaOverrides.map((quota) => ({
            metric: quota.metric,
            limit: quota.limit,
          }))
        : null,
      availablePlans: plans,
      deletionEligibleAt: subscription?.deletionEligibleAt
        ? toIso(subscription.deletionEligibleAt)
        : null,
      canRestore:
        subscription?.status === "archived" &&
        isRetentionActive(subscription.deletionEligibleAt) &&
        Boolean(subscription.planCode),
    };
  });
}

export async function setSiteProductPlan(
  actor: RequestActor,
  siteId: string,
  productSlug: string,
  input: {
    planCode?: string | null;
    status?: "active" | "suspended";
    action?: "restore" | "unassign";
    scopeOverrides?: string[] | null;
    quotaOverrides?: { metric: string; limit: number; unit?: string }[] | null;
  },
): Promise<SubscriptionSummary | null> {
  const [site, product] = await Promise.all([
    Site.findById(siteId).lean(),
    Product.findOne({
      slug: productSlug.toLowerCase(),
      status: "active",
    }).lean(),
  ]);
  if (!site || !product) {
    return null;
  }

  const transitionActor = {
    userId: actor.userId,
    reason: "portal subscription update",
  };

  let subscription = await Subscription.findOne({
    siteId: new Types.ObjectId(siteId),
    productSlug: product.slug,
  });

  if (input.action === "unassign") {
    if (!subscription) {
      return null;
    }
    await unassignSubscription(subscription, transitionActor);
    const summaries = await listSiteProducts(siteId);
    return (
      summaries.find((summary) => summary.productSlug === product.slug) ?? null
    );
  }

  if (input.action === "restore") {
    if (!subscription) {
      throw new SubscriptionLifecycleError(
        "No archived subscription to restore.",
        "NOT_FOUND",
      );
    }
    await restoreSubscription(subscription, transitionActor);
    const summaries = await listSiteProducts(siteId);
    return (
      summaries.find((summary) => summary.productSlug === product.slug) ?? null
    );
  }

  if (input.planCode === null) {
    if (!subscription) {
      return null;
    }
    await unassignSubscription(subscription, transitionActor);
    const summaries = await listSiteProducts(siteId);
    return (
      summaries.find((summary) => summary.productSlug === product.slug) ?? null
    );
  }

  if (input.planCode) {
    if (!site.primaryDomain?.trim()) {
      throw new SubscriptionLifecycleError(
        "Configure a primary domain before assigning products.",
        "DOMAIN_REQUIRED",
      );
    }
    await assignSubscriptionPlan({
      siteId,
      merchantId: site.merchantId as unknown as Types.ObjectId,
      productSlug: product.slug,
      planCode: input.planCode,
      actor: transitionActor,
    });
    await writeAuditLog({
      merchantId: site.merchantId.toString(),
      actorUserId: actor.userId,
      action: "subscription.plan_changed",
      resourceType: "subscription",
      resourceId: product.slug,
      metadata: { siteId, productSlug: product.slug, planCode: input.planCode },
    });
    subscription = await Subscription.findOne({
      siteId: new Types.ObjectId(siteId),
      productSlug: product.slug,
    });
  }

  if (input.scopeOverrides !== undefined && subscription) {
    subscription.scopeOverrides = input.scopeOverrides;
    await subscription.save();
    await writeAuditLog({
      merchantId: site.merchantId.toString(),
      actorUserId: actor.userId,
      action: "subscription.scopes_overridden",
      resourceType: "subscription",
      resourceId: product.slug,
      metadata: { siteId, productSlug: product.slug },
    });
  }

  if (input.quotaOverrides !== undefined && subscription) {
    subscription.set(
      "quotaOverrides",
      input.quotaOverrides?.map((quota) => ({
        metric: quota.metric,
        limit: quota.limit,
      })) ?? null,
    );
    await subscription.save();
    await writeAuditLog({
      merchantId: site.merchantId.toString(),
      actorUserId: actor.userId,
      action: "subscription.quotas_overridden",
      resourceType: "subscription",
      resourceId: product.slug,
      metadata: { siteId, productSlug: product.slug },
    });
  }

  if (input.status && subscription) {
    const currentStatus = normalizeLegacySubscriptionStatus(subscription);
    if (currentStatus !== input.status) {
      await transitionSubscription(
        subscription,
        input.status,
        transitionActor,
      );
      await writeAuditLog({
        merchantId: site.merchantId.toString(),
        actorUserId: actor.userId,
        action:
          input.status === "suspended"
            ? "subscription.suspended"
            : "subscription.resumed",
        resourceType: "subscription",
        resourceId: product.slug,
        metadata: { siteId, productSlug: product.slug },
      });
    }
  }

  const summaries = await listSiteProducts(siteId);
  return (
    summaries.find((summary) => summary.productSlug === product.slug) ?? null
  );
}

function mapToken(token: {
  _id: { toString(): string };
  merchantId: { toString(): string };
  siteId: { toString(): string };
  productSlug: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  allowedDomains?: string[];
  lastUsedAt?: Date | null;
  revokedAt?: Date | null;
  expiresAt?: Date | null;
  createdAt: Date;
}): ProductAccessTokenSummary {
  return {
    id: token._id.toString(),
    merchantId: token.merchantId.toString(),
    siteId: token.siteId.toString(),
    productSlug: token.productSlug,
    name: token.name,
    tokenPrefix: token.tokenPrefix,
    scopes: [...token.scopes],
    allowedDomains: [...(token.allowedDomains ?? [])],
    lastUsedAt: token.lastUsedAt ? toIso(token.lastUsedAt) : null,
    revokedAt: token.revokedAt ? toIso(token.revokedAt) : null,
    expiresAt: token.expiresAt ? toIso(token.expiresAt) : null,
    createdAt: toIso(token.createdAt),
  };
}

export async function listProductTokens(
  siteId: string,
  productSlug: string,
): Promise<ProductAccessTokenSummary[]> {
  const tokens = await ProductAccessToken.find({
    siteId: new Types.ObjectId(siteId),
    productSlug: productSlug.toLowerCase(),
  })
    .sort({ createdAt: -1 })
    .lean();
  return tokens.map(mapToken);
}

export async function createProductToken(
  actor: RequestActor,
  siteId: string,
  productSlug: string,
  name: string,
  allowedDomains: string[] = [],
  expiresInDays?: number,
): Promise<ProductAccessTokenCreated> {
  const [site, product, subscription] = await Promise.all([
    Site.findById(siteId).lean(),
    Product.findOne({
      slug: productSlug.toLowerCase(),
      status: "active",
    }).lean(),
    Subscription.findOne({
      siteId: new Types.ObjectId(siteId),
      productSlug: productSlug.toLowerCase(),
    }).lean(),
  ]);

  if (!site || !product) {
    throw new Error("PRODUCT_NOT_FOUND");
  }
  if (
    !subscription ||
    !subscription.planCode ||
    normalizeLegacySubscriptionStatus(subscription) !== "active"
  ) {
    throw new Error("PRODUCT_NOT_GRANTED");
  }
  if (!resolvePlanOnProduct(product, subscription.planCode)) {
    throw new Error("PRODUCT_NOT_GRANTED");
  }

  const entitlement = resolveEntitlement(
    product.plans.map(mapPlan),
    subscription,
  );
  const domains = normalizeDomains(
    allowedDomains.length > 0
      ? allowedDomains
      : site.primaryDomain
        ? [site.primaryDomain]
        : [],
  );
  const generated = generateProductToken();
  const expiresAt =
    expiresInDays && expiresInDays > 0
      ? new Date(Date.now() + expiresInDays * 24 * 60 * 60_000)
      : null;
  const token = await ProductAccessToken.create({
    merchantId: site.merchantId,
    siteId: site._id,
    productSlug: product.slug,
    name,
    tokenPrefix: generated.tokenPrefix,
    tokenHash: generated.tokenHash,
    scopes: entitlement.scopes,
    allowedDomains: domains,
    expiresAt,
  });

  await writeAuditLog({
    merchantId: site.merchantId.toString(),
    actorUserId: actor.userId,
    action: "product_token.created",
    resourceType: "product_token",
    resourceId: token._id.toString(),
    metadata: {
      siteId,
      productSlug: product.slug,
      name,
      allowedDomains: domains.length,
    },
  });

  return { ...mapToken(token), plaintextToken: generated.plaintextToken };
}

export async function rotateProductToken(
  actor: RequestActor,
  siteId: string,
  productSlug: string,
  tokenId: string,
  input: {
    name?: string;
    revokePrevious?: boolean;
    expiresInDays?: number;
  } = {},
): Promise<ProductAccessTokenRotation | null> {
  const previous = await ProductAccessToken.findOne({
    _id: new Types.ObjectId(tokenId),
    siteId: new Types.ObjectId(siteId),
    productSlug: productSlug.toLowerCase(),
    revokedAt: null,
  });
  if (!previous) {
    return null;
  }

  const newToken = await createProductToken(
    actor,
    siteId,
    productSlug,
    input.name ?? `${previous.name} (rotated)`,
    [...(previous.allowedDomains ?? [])],
    input.expiresInDays,
  );

  let previousRevoked = false;
  if (input.revokePrevious !== false) {
    previousRevoked = await revokeProductToken(
      actor,
      siteId,
      productSlug,
      tokenId,
    );
  }

  await writeAuditLog({
    merchantId: previous.merchantId.toString(),
    actorUserId: actor.userId,
    action: "product_token.rotated",
    resourceType: "product_token",
    resourceId: tokenId,
    metadata: {
      siteId,
      productSlug,
      newTokenId: newToken.id,
      previousRevoked,
    },
  });

  return {
    newToken,
    previousTokenId: tokenId,
    previousRevoked,
  };
}

export async function revokeProductToken(
  actor: RequestActor,
  siteId: string,
  productSlug: string,
  tokenId: string,
): Promise<boolean> {
  const token = await ProductAccessToken.findOneAndUpdate(
    {
      _id: new Types.ObjectId(tokenId),
      siteId: new Types.ObjectId(siteId),
      productSlug: productSlug.toLowerCase(),
      revokedAt: null,
    },
    { revokedAt: new Date() },
    { new: true },
  );

  if (!token) {
    return false;
  }

  await writeAuditLog({
    merchantId: token.merchantId.toString(),
    actorUserId: actor.userId,
    action: "product_token.revoked",
    resourceType: "product_token",
    resourceId: tokenId,
    metadata: { siteId, productSlug },
  });

  return true;
}

async function usageMetrics(
  siteId: string,
  productSlug: string,
  quotas: ProductPlanQuota[],
  period: string,
): Promise<ProductUsageMetric[]> {
  const rows = await ProductUsage.find({
    siteId: new Types.ObjectId(siteId),
    productSlug,
    period,
  }).lean();
  const usedByMetric = new Map(rows.map((row) => [row.metric, row.quantity]));

  const metricNames = new Set<string>([
    ...quotas.map((quota) => quota.metric),
    ...usedByMetric.keys(),
  ]);
  return [...metricNames].map((metric) => {
    const quota =
      quotas.find((candidate) => candidate.metric === metric) ?? null;
    const used = usedByMetric.get(metric) ?? 0;
    return {
      metric,
      used,
      limit: quota ? quota.limit : null,
      ...(quota?.unit ? { unit: quota.unit } : {}),
      withinQuota: quota ? used <= quota.limit : true,
    };
  });
}

export async function getProductUsage(
  siteId: string,
  productSlug: string,
): Promise<ProductUsageSummary | null> {
  const [product, subscription] = await Promise.all([
    Product.findOne({ slug: productSlug.toLowerCase() }).lean(),
    Subscription.findOne({
      siteId: new Types.ObjectId(siteId),
      productSlug: productSlug.toLowerCase(),
    }).lean(),
  ]);
  if (!product) {
    return null;
  }

  const entitlement = resolveEntitlement(
    product.plans.map(mapPlan),
    subscription,
  );
  const period = currentPeriod();
  const metrics = await usageMetrics(
    siteId,
    product.slug,
    entitlement.quotas,
    period,
  );

  return {
    productSlug: product.slug,
    period,
    metrics,
    estimatedCost: entitlement.priceMonthly ?? 0,
    currency: entitlement.currency ?? "USD",
  };
}

export async function verifyProductToken(plaintextToken: string) {
  const tokenHash = hashApiKey(plaintextToken);
  const token = await ProductAccessToken.findOne({
    tokenHash,
    revokedAt: null,
  }).lean();
  if (!token) {
    return null;
  }
  if (token.expiresAt && token.expiresAt.getTime() < Date.now()) {
    return null;
  }

  const [product, subscription, site, merchant] = await Promise.all([
    Product.findOne({ slug: token.productSlug, status: "active" }).lean(),
    Subscription.findOne({
      siteId: token.siteId,
      productSlug: token.productSlug,
    }).lean(),
    Site.findById(token.siteId).lean(),
    Merchant.findById(token.merchantId).lean(),
  ]);

  if (
    !product ||
    !site ||
    !merchant ||
    !subscription ||
    normalizeLegacySubscriptionStatus(subscription) !== "active" ||
    !subscription.planCode ||
    !resolvePlanOnProduct(product, subscription.planCode)
  ) {
    return null;
  }

  // Resolve (backfilling for legacy subscriptions) the tenant's data database.
  const dataDbName = await ensureSubscriptionDataDb({
    _id: subscription._id,
    merchantId: subscription.merchantId,
    siteId: subscription.siteId,
    productSlug: subscription.productSlug,
    dataDbName: subscription.dataDbName,
  });

  const entitlement = resolveEntitlement(
    product.plans.map(mapPlan),
    subscription,
  );
  const period = currentPeriod();
  const metrics = await usageMetrics(
    token.siteId.toString(),
    token.productSlug,
    entitlement.quotas,
    period,
  );
  const config = await resolvePublishedConfig(
    mapConfigSchema(product.configSchema),
    token.siteId.toString(),
    token.productSlug,
  );

  await ProductAccessToken.updateOne(
    { _id: token._id },
    { lastUsedAt: new Date() },
  );

  return {
    merchantId: token.merchantId.toString(),
    merchantSlug: merchant.slug,
    siteId: token.siteId.toString(),
    siteSlug: site.slug,
    productSlug: token.productSlug,
    plan: { code: entitlement.planCode, name: entitlement.planName },
    scopes: token.scopes,
    allowedDomains: [...(token.allowedDomains ?? [])],
    quotas: entitlement.quotas,
    usage: metrics,
    withinQuota: metrics.every((metric) => metric.withinQuota),
    config,
    dataDbName,
  };
}

export type UsageRecordResult = {
  metric: string;
  used: number;
  limit: number | null;
  withinQuota: boolean;
  denied?: boolean;
};

export async function recordProductUsage(input: {
  token: string;
  metric: string;
  quantity: number;
  idempotencyKey: string;
}): Promise<UsageRecordResult | null> {
  const token = await ProductAccessToken.findOne({
    tokenHash: hashApiKey(input.token),
    revokedAt: null,
  }).lean();
  if (!token) {
    return null;
  }

  const existingEvent = await ProductUsageEvent.findOne({
    idempotencyKey: input.idempotencyKey,
  }).lean();
  if (existingEvent) {
    return {
      metric: existingEvent.metric,
      used: existingEvent.usedAfter,
      limit: existingEvent.limit ?? null,
      withinQuota: existingEvent.withinQuota,
      denied: existingEvent.denied,
    };
  }

  const [product, subscription] = await Promise.all([
    Product.findOne({ slug: token.productSlug.toLowerCase() }).lean(),
    Subscription.findOne({
      siteId: token.siteId,
      productSlug: token.productSlug,
    }).lean(),
  ]);
  if (
    !product ||
    !subscription ||
    normalizeLegacySubscriptionStatus(subscription) !== "active" ||
    !subscription.planCode ||
    !resolvePlanOnProduct(product, subscription.planCode)
  ) {
    return null;
  }

  const entitlement = resolveEntitlement(
    product.plans.map(mapPlan),
    subscription,
  );
  const quota =
    entitlement.quotas.find((candidate) => candidate.metric === input.metric) ??
    null;
  const period = currentPeriod();
  const siteObjectId = token.siteId;
  const productSlug = token.productSlug;
  const limit = quota?.limit ?? null;

  const session = await mongoose.startSession();
  try {
    let result: UsageRecordResult | null = null;
    await session.withTransaction(async () => {
      const duplicate = await ProductUsageEvent.findOne({
        idempotencyKey: input.idempotencyKey,
      })
        .session(session)
        .lean();
      if (duplicate) {
        result = {
          metric: duplicate.metric,
          used: duplicate.usedAfter,
          limit: duplicate.limit ?? null,
          withinQuota: duplicate.withinQuota,
          denied: duplicate.denied,
        };
        return;
      }

      const currentUsage = await ProductUsage.findOne({
        siteId: siteObjectId,
        productSlug,
        metric: input.metric,
        period,
      })
        .session(session)
        .lean();
      const usedBefore = currentUsage?.quantity ?? 0;
      const wouldExceed =
        limit !== null && usedBefore + input.quantity > limit;

      if (wouldExceed) {
        await ProductUsageEvent.create(
          [
            {
              idempotencyKey: input.idempotencyKey,
              merchantId: token.merchantId,
              siteId: siteObjectId,
              productSlug,
              tokenId: token._id,
              metric: input.metric,
              period,
              quantity: input.quantity,
              usedAfter: usedBefore,
              limit: limit ?? null,
              withinQuota: false,
              denied: true,
            },
          ],
          { session },
        );
        result = {
          metric: input.metric,
          used: usedBefore,
          limit: limit ?? null,
          withinQuota: false,
          denied: true,
        };
        return;
      }

      const usage = await ProductUsage.findOneAndUpdate(
        {
          siteId: siteObjectId,
          productSlug,
          metric: input.metric,
          period,
        },
        {
          $inc: { quantity: input.quantity },
          $set: {
            lastEventAt: new Date(),
            merchantId: token.merchantId,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true, session },
      ).lean();

      const withinQuota = quota ? usage.quantity <= quota.limit : true;
      await ProductUsageEvent.create(
        [
          {
            idempotencyKey: input.idempotencyKey,
            merchantId: token.merchantId,
            siteId: siteObjectId,
            productSlug,
            tokenId: token._id,
            metric: input.metric,
            period,
            quantity: input.quantity,
            usedAfter: usage.quantity,
            limit: limit ?? null,
            withinQuota,
            denied: false,
          },
        ],
        { session },
      );
      result = {
        metric: input.metric,
        used: usage.quantity,
        limit,
        withinQuota,
      };
    });
    return result;
  } finally {
    await session.endSession();
  }
}

async function resolveProductBaseUrl(productSlug: string): Promise<string> {
  const product = await Product.findOne({
    slug: productSlug.toLowerCase(),
  }).lean();
  if (!product) {
    throw new ProductBridgeError("Product not found.", 404);
  }
  if (!product.baseUrl) {
    throw new ProductBridgeError(
      "This product has no base URL configured, so conversations can't be loaded.",
      409,
    );
  }
  return product.baseUrl;
}

async function resolveProductBridge(
  siteId: string,
  productSlug: string,
): Promise<{ baseUrl: string }> {
  const slug = productSlug.toLowerCase();
  const product = await Product.findOne({ slug }).lean();
  if (!product) {
    throw new ProductBridgeError("Product not found.", 404);
  }
  if (!product.baseUrl) {
    throw new ProductBridgeError(
      "This product has no base URL configured, so conversations can't be loaded.",
      409,
    );
  }
  try {
    await resolveTenantBinding(siteId, slug, { requireBridgeAccess: true });
  } catch (error) {
    if (error instanceof TenantBindingError) {
      throw new ProductBridgeError(error.message, error.status);
    }
    throw error;
  }
  return { baseUrl: product.baseUrl };
}

export async function listSiteProductConversations(
  siteId: string,
  productSlug: string,
  query: { status?: string; page: number; pageSize: number },
) {
  const { baseUrl } = await resolveProductBridge(siteId, productSlug);
  return fetchProductConversations(baseUrl, siteId, productSlug, query);
}

export async function getSiteProductConversation(
  siteId: string,
  productSlug: string,
  conversationId: string,
) {
  const { baseUrl } = await resolveProductBridge(siteId, productSlug);
  return fetchProductConversation(baseUrl, siteId, productSlug, conversationId);
}

export async function replyToSiteProductConversation(
  siteId: string,
  productSlug: string,
  conversationId: string,
  body: string,
  agentName: string,
) {
  const { baseUrl } = await resolveProductBridge(siteId, productSlug);
  return postProductConversationReply(
    baseUrl,
    siteId,
    productSlug,
    conversationId,
    body,
    agentName,
  );
}

export async function buildProductPreview(
  siteId: string,
  productSlug: string,
): Promise<{ embedUrl: string; expiresInSeconds: number }> {
  const baseUrl = await resolveProductBaseUrl(productSlug);
  const token = await createPreviewToken(siteId, productSlug);
  const embedUrl = `${baseUrl.replace(/\/$/, "")}/embed?preview=${encodeURIComponent(token)}`;
  return { embedUrl, expiresInSeconds: PREVIEW_TOKEN_TTL_SECONDS };
}

export async function runSiteProductTest(
  siteId: string,
  productSlug: string,
  action: string,
  input: string,
) {
  const baseUrl = await resolveProductBaseUrl(productSlug);
  const config = await resolveDraftConfig(siteId, productSlug);
  const response = await postProductTest(baseUrl, { action, input, config });
  return response.result;
}
