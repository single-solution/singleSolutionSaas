import {
  Merchant,
  Product,
  ProductAccessToken,
  ProductUsage,
  Site,
  Subscription,
  Types,
} from "@/lib/db";
import type {
  ProductAccessTokenCreated,
  ProductAccessTokenSummary,
  ProductConfigSection,
  ProductPlan,
  ProductPlanQuota,
  ProductSummary,
  ProductTestAction,
  ProductUsageMetric,
  ProductUsageSummary,
  SubscriptionSummary,
} from "@/lib/types";
import {
  createPreviewToken,
  PREVIEW_TOKEN_TTL_SECONDS,
  resolveDraftConfig,
  resolvePublishedConfig,
} from "@/lib/services/productConfig.service";
import { generateProductToken, hashApiKey } from "@/lib/crypto";
import { ensureSubscriptionDataDb } from "@/lib/services/tenantDb";
import {
  type RequestActor,
  writeAuditLog,
} from "@/lib/services/platform.service";
import {
  fetchProductConversation,
  fetchProductConversations,
  fetchProductSchema,
  postProductConversationReply,
  postProductTest,
  ProductBridgeError,
} from "@/lib/services/productBridge";
import type { ProductConnectionStatus, ProductSubscriber } from "@/lib/types";

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
  counts?: { active: number; suspended: number },
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
          subscriberCount: counts.active + counts.suspended,
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
      _id: { productSlug: string; status: "active" | "suspended" };
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
    { active: number; suspended: number }
  >();
  for (const entry of subscriptionCounts) {
    const counts = countsByProduct.get(entry._id.productSlug) ?? {
      active: 0,
      suspended: 0,
    };
    counts[entry._id.status] = entry.count;
    countsByProduct.set(entry._id.productSlug, counts);
  }
  return products.map((product) =>
    mapProduct(
      product,
      countsByProduct.get(product.slug) ?? { active: 0, suspended: 0 },
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
        status: subscription.status,
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
    return {
      productSlug: product.slug,
      displayName: product.name,
      description: product.description ?? "",
      productStatus: product.status,
      status: subscription ? subscription.status : "unassigned",
      planCode: entitlement.planCode,
      planName: entitlement.planName,
      priceMonthly: entitlement.priceMonthly,
      currency: entitlement.currency,
      scopes: entitlement.scopes,
      quotas: entitlement.quotas,
      availablePlans: plans,
    };
  });
}

export async function setSiteProductPlan(
  actor: RequestActor,
  siteId: string,
  productSlug: string,
  input: { planCode?: string | null; status?: "active" | "suspended" },
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

  if (
    input.planCode &&
    !product.plans.some((plan) => plan.code === input.planCode)
  ) {
    throw new Error("PLAN_NOT_FOUND");
  }

  const update: Record<string, unknown> = { merchantId: site.merchantId };
  if (input.planCode !== undefined) {
    update.planCode = input.planCode;
  }
  if (input.status !== undefined) {
    update.status = input.status;
  }

  const subscription = await Subscription.findOneAndUpdate(
    { siteId: new Types.ObjectId(siteId), productSlug: product.slug },
    { $set: update },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();

  // Provision the tenant's dedicated product data database on first assignment.
  if (subscription && !subscription.dataDbName) {
    await ensureSubscriptionDataDb({
      _id: subscription._id,
      merchantId: subscription.merchantId,
      siteId: subscription.siteId,
      productSlug: subscription.productSlug,
      dataDbName: subscription.dataDbName,
    });
  }

  await writeAuditLog({
    merchantId: site.merchantId.toString(),
    actorUserId: actor.userId,
    action: "subscription.plan_changed",
    resourceType: "subscription",
    resourceId: product.slug,
    metadata: { siteId, productSlug: product.slug, ...input },
  });

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
    subscription.status !== "active"
  ) {
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
  const token = await ProductAccessToken.create({
    merchantId: site.merchantId,
    siteId: site._id,
    productSlug: product.slug,
    name,
    tokenPrefix: generated.tokenPrefix,
    tokenHash: generated.tokenHash,
    scopes: entitlement.scopes,
    allowedDomains: domains,
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
    subscription.status !== "active" ||
    !subscription.planCode
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

export async function recordProductUsage(input: {
  token?: string;
  siteId?: string;
  productSlug?: string;
  metric: string;
  quantity: number;
}): Promise<{
  metric: string;
  used: number;
  limit: number | null;
  withinQuota: boolean;
} | null> {
  let siteId = input.siteId;
  let productSlug = input.productSlug;
  let merchantId: string | undefined;

  if (input.token) {
    const token = await ProductAccessToken.findOne({
      tokenHash: hashApiKey(input.token),
      revokedAt: null,
    }).lean();
    if (!token) {
      return null;
    }
    siteId = token.siteId.toString();
    productSlug = token.productSlug;
    merchantId = token.merchantId.toString();
  }

  if (!siteId || !productSlug) {
    return null;
  }

  const [product, subscription] = await Promise.all([
    Product.findOne({ slug: productSlug.toLowerCase() }).lean(),
    Subscription.findOne({
      siteId: new Types.ObjectId(siteId),
      productSlug: productSlug.toLowerCase(),
    }).lean(),
  ]);
  if (!product || !subscription || subscription.status !== "active") {
    return null;
  }
  merchantId = merchantId ?? subscription.merchantId.toString();

  const period = currentPeriod();
  const usage = await ProductUsage.findOneAndUpdate(
    {
      siteId: new Types.ObjectId(siteId),
      productSlug: product.slug,
      metric: input.metric,
      period,
    },
    {
      $inc: { quantity: input.quantity },
      $set: {
        lastEventAt: new Date(),
        merchantId: new Types.ObjectId(merchantId),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();

  const entitlement = resolveEntitlement(
    product.plans.map(mapPlan),
    subscription,
  );
  const quota =
    entitlement.quotas.find((candidate) => candidate.metric === input.metric) ??
    null;

  return {
    metric: input.metric,
    used: usage.quantity,
    limit: quota ? quota.limit : null,
    withinQuota: quota ? usage.quantity <= quota.limit : true,
  };
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
): Promise<{ baseUrl: string; dataDbName: string }> {
  const slug = productSlug.toLowerCase();
  const [product, subscription] = await Promise.all([
    Product.findOne({ slug }).lean(),
    Subscription.findOne({
      siteId: new Types.ObjectId(siteId),
      productSlug: slug,
    }).lean(),
  ]);
  if (!product) {
    throw new ProductBridgeError("Product not found.", 404);
  }
  if (!product.baseUrl) {
    throw new ProductBridgeError(
      "This product has no base URL configured, so conversations can't be loaded.",
      409,
    );
  }
  if (!subscription) {
    throw new ProductBridgeError(
      "This site is not subscribed to the product.",
      409,
    );
  }
  const dataDbName = await ensureSubscriptionDataDb({
    _id: subscription._id,
    merchantId: subscription.merchantId,
    siteId: subscription.siteId,
    productSlug: subscription.productSlug,
    dataDbName: subscription.dataDbName,
  });
  return { baseUrl: product.baseUrl, dataDbName };
}

export async function listSiteProductConversations(
  siteId: string,
  productSlug: string,
  query: { status?: string; page: number; pageSize: number },
) {
  const { baseUrl, dataDbName } = await resolveProductBridge(
    siteId,
    productSlug,
  );
  return fetchProductConversations(baseUrl, siteId, dataDbName, query);
}

export async function getSiteProductConversation(
  siteId: string,
  productSlug: string,
  conversationId: string,
) {
  const { baseUrl, dataDbName } = await resolveProductBridge(
    siteId,
    productSlug,
  );
  return fetchProductConversation(baseUrl, siteId, dataDbName, conversationId);
}

export async function replyToSiteProductConversation(
  siteId: string,
  productSlug: string,
  conversationId: string,
  body: string,
  agentName: string,
) {
  const { baseUrl, dataDbName } = await resolveProductBridge(
    siteId,
    productSlug,
  );
  return postProductConversationReply(
    baseUrl,
    siteId,
    dataDbName,
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
