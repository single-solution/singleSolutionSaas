import { SignJWT } from "jose";

import { isValidObjectId, Merchant, Product, Site, Subscription, Types, User } from "@/lib/db";
import { loadEnvironment } from "@/lib/env";
import { type RequestActor, writeAuditLog } from "@/lib/services/platform.service";
import { ensureSubscriptionDataDb } from "@/lib/services/tenantDb";

/** Short-lived so a leaked deep-link cannot be replayed. */
const DASHBOARD_SSO_TTL_SECONDS = 120;

export class DashboardSsoError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function ssoSecret(): Uint8Array {
  return new TextEncoder().encode(loadEnvironment().INTERNAL_API_SECRET);
}

/**
 * Mint a one-time deep-link into a product's advanced admin dashboard. The token
 * is signed with the shared internal secret and carries the admin identity plus
 * optional site context; the product exchanges it for its own admin cookie.
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
  if (siteId && !isValidObjectId(siteId)) {
    throw new DashboardSsoError("Invalid site.", 400);
  }

  const actorUser = await User.findById(actor.userId).lean();

  const token = await new SignJWT({
    name: actorUser?.name ?? "Administrator",
    productSlug: product.slug,
    ...(siteId ? { siteId } : {}),
    scope: "admin-dashboard",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(actor.userId)
    .setIssuedAt()
    .setExpirationTime(`${DASHBOARD_SSO_TTL_SECONDS}s`)
    .sign(ssoSecret());

  await writeAuditLog({
    merchantId: null,
    actorUserId: actor.userId,
    action: "product.dashboard_sso",
    resourceType: "product",
    resourceId: product._id.toString(),
    metadata: { slug: product.slug, siteId: siteId ?? null },
  });

  return {
    url: `${baseUrl}/admin/sso?token=${encodeURIComponent(token)}`,
    expiresInSeconds: DASHBOARD_SSO_TTL_SECONDS,
  };
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
  const subscriptions = await Subscription.find({ productSlug: slug }).lean();
  const siteIds = subscriptions.map((subscription) => subscription.siteId);
  const sites = await Site.find({ _id: { $in: siteIds } }).lean();
  const merchants = await Merchant.find({
    _id: { $in: [...new Set(sites.map((site) => site.merchantId.toString()))].map((id) => new Types.ObjectId(id)) },
  }).lean();
  const merchantById = new Map(merchants.map((merchant) => [merchant._id.toString(), merchant]));

  // Resolve (backfilling legacy rows) each subscription's tenant data database.
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
