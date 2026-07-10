import { randomBytes } from "node:crypto";

import { isValidObjectId, Merchant, Product, Site, SsoExchange, Subscription, Types, User } from "@/lib/db";
import { hashApiKey } from "@/lib/crypto";
import { loadEnvironment } from "@/lib/env";
import { type RequestActor, writeAuditLog } from "@/lib/services/platform.service";
import { ensureSubscriptionDataDb } from "@/lib/services/tenantDb";
import { OutboundUrlError, validateOutboundUrl } from "@/lib/security/outboundUrl";
import { isProduction } from "@/lib/utils";

/** Short-lived so a leaked deep-link cannot be replayed. */
const DASHBOARD_SSO_TTL_SECONDS = 120;

export class DashboardSsoError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface SsoExchangeClaims {
  userId: string;
  name: string;
  productSlug: string;
  siteId: string | null;
  sessionVersion: number;
}

function generateExchangeCode(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Mint a one-time deep-link into a product's advanced admin dashboard. The code
 * is stored hashed in the platform database; the product exchanges it over S2S.
 */
export async function mintDashboardSession(
  actor: RequestActor,
  productSlug: string,
  siteId?: string,
): Promise<{ url: string; expiresInSeconds: number }> {
  const product = await Product.findOne({ slug: productSlug.toLowerCase() }).lean();
  if (!product) {
    throw new DashboardSsoError("Product not found.", 404);
  }
  const baseUrl = (product.baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!baseUrl) {
    throw new DashboardSsoError("This product has no Base URL. Add one before opening its dashboard.", 400);
  }

  const environment = loadEnvironment();
  try {
    await validateOutboundUrl(baseUrl, {
      isProduction: isProduction(environment),
      allowLocalhost: true,
    });
  } catch (error) {
    const message =
      error instanceof OutboundUrlError ? error.message : "Product Base URL is not allowed.";
    throw new DashboardSsoError(message, 400);
  }

  if (siteId && !isValidObjectId(siteId)) {
    throw new DashboardSsoError("Invalid site.", 400);
  }
  if (siteId) {
    const subscription = await Subscription.findOne({
      siteId: new Types.ObjectId(siteId),
      productSlug: product.slug,
      status: "active",
      planCode: { $ne: null },
    }).lean();
    if (!subscription) {
      throw new DashboardSsoError(
        "This site does not have an active subscription with a valid plan.",
        409,
      );
    }
  }

  const actorUser = await User.findById(actor.userId).lean();
  if (!actorUser || actorUser.status !== "active" || !actorUser.passwordHash) {
    throw new DashboardSsoError("Administrator session is no longer valid.", 401);
  }
  if (!actorUser.isPlatformAdmin) {
    throw new DashboardSsoError("Only platform administrators can open product dashboards.", 403);
  }

  const code = generateExchangeCode();
  const expiresAt = new Date(Date.now() + DASHBOARD_SSO_TTL_SECONDS * 1000);
  await SsoExchange.create({
    codeHash: hashApiKey(code),
    productSlug: product.slug,
    siteId: siteId ? new Types.ObjectId(siteId) : null,
    userId: actorUser._id,
    sessionVersion: actorUser.sessionVersion,
    expiresAt,
    consumedAt: null,
  });

  await writeAuditLog({
    merchantId: null,
    actorUserId: actor.userId,
    action: "product.dashboard_sso",
    resourceType: "product",
    resourceId: product._id.toString(),
    metadata: { slug: product.slug, siteId: siteId ?? null },
  });

  const target = new URL(`${baseUrl}/admin/sso`);
  target.searchParams.set("code", code);
  if (siteId) {
    target.searchParams.set("siteId", siteId);
  }

  return {
    url: target.toString(),
    expiresInSeconds: DASHBOARD_SSO_TTL_SECONDS,
  };
}

/** Atomically consume a one-time SSO exchange code for a product dashboard handoff. */
export async function exchangeDashboardSsoCode(
  code: string,
  productSlug: string,
): Promise<SsoExchangeClaims | null> {
  const slug = productSlug.toLowerCase().trim();
  if (!slug) {
    return null;
  }
  const codeHash = hashApiKey(code.trim());
  const now = new Date();
  const record = await SsoExchange.findOneAndUpdate(
    {
      codeHash,
      productSlug: slug,
      consumedAt: null,
      expiresAt: { $gt: now },
    },
    { $set: { consumedAt: now } },
    { new: false },
  ).lean();

  if (!record) {
    return null;
  }

  const user = await User.findById(record.userId).lean();
  if (
    !user ||
    user.status !== "active" ||
    !user.passwordHash ||
    !user.isPlatformAdmin ||
    user.sessionVersion !== record.sessionVersion
  ) {
    return null;
  }

  return {
    userId: user._id.toString(),
    name: user.name,
    productSlug: slug,
    siteId: record.siteId ? record.siteId.toString() : null,
    sessionVersion: user.sessionVersion,
  };
}

export async function verifyPlatformAdminSession(
  userId: string,
  sessionVersion: number,
): Promise<boolean> {
  const user = await User.findById(userId).lean();
  if (!user) {
    return false;
  }
  return (
    user.status === "active" &&
    Boolean(user.passwordHash) &&
    user.isPlatformAdmin &&
    user.sessionVersion === sessionVersion
  );
}

export interface ProductSiteRef {
  siteId: string;
  name: string;
  merchantName: string;
  /** The site's dedicated product data database for this product. */
  dataDbName: string;
}

/** Sites subscribed to a product, for the in-product dashboard site switcher. */
export async function listProductSitesForSwitcher(productSlug: string): Promise<ProductSiteRef[]> {
  const slug = productSlug.toLowerCase();
  const subscriptions = await Subscription.find({
    productSlug: slug,
    status: "active",
    planCode: { $ne: null },
  }).lean();
  const siteIds = subscriptions.map((subscription) => subscription.siteId);
  const sites = await Site.find({ _id: { $in: siteIds } }).lean();
  const merchants = await Merchant.find({
    _id: { $in: [...new Set(sites.map((site) => site.merchantId.toString()))].map((id) => new Types.ObjectId(id)) },
  }).lean();
  const merchantById = new Map(merchants.map((merchant) => [merchant._id.toString(), merchant]));

  const dataDbBySite = new Map<string, string>();
  for (const subscription of subscriptions) {
    const dataDbName = await ensureSubscriptionDataDb({
      _id: subscription._id,
      merchantId: subscription.merchantId,
      siteId: subscription.siteId,
      productSlug: subscription.productSlug,
      dataDbName: subscription.dataDbName,
    });
    dataDbBySite.set(subscription.siteId.toString(), dataDbName);
  }

  return sites.map((site) => ({
    siteId: site._id.toString(),
    name: site.name,
    merchantName: merchantById.get(site.merchantId.toString())?.name ?? "Unknown",
    dataDbName: dataDbBySite.get(site._id.toString()) ?? "",
  }));
}
