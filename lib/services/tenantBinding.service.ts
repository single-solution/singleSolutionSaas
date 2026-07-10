import { Product, Subscription, Types } from "@/lib/db";
import {
  normalizeLegacySubscriptionStatus,
  resolvePlanOnProduct,
} from "@/lib/services/subscriptionLifecycle.service";
import { ensureSubscriptionDataDb } from "@/lib/services/tenantDb";

export class TenantBindingError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "TenantBindingError";
  }
}

export interface TenantBinding {
  siteId: string;
  productSlug: string;
  merchantId: string;
  subscriptionId: string;
  status: "active" | "suspended" | "archived";
  planCode: string | null;
  dataDbName: string;
}

/**
 * Resolves the authoritative tenant database for a site + product. Bridge callers
 * require an active assigned subscription with a plan that still exists on the product.
 */
export async function resolveTenantBinding(
  siteId: string,
  productSlug: string,
  options?: { requireBridgeAccess?: boolean },
): Promise<TenantBinding> {
  const slug = productSlug.toLowerCase();
  const [product, subscription] = await Promise.all([
    Product.findOne({ slug }).lean(),
    Subscription.findOne({
      siteId: new Types.ObjectId(siteId),
      productSlug: slug,
    }).lean(),
  ]);

  if (!product) {
    throw new TenantBindingError("Product not found.", 404);
  }
  if (!subscription) {
    throw new TenantBindingError("This site is not subscribed to the product.", 409);
  }

  const normalizedStatus = normalizeLegacySubscriptionStatus(subscription);
  const plan = resolvePlanOnProduct(product, subscription.planCode);

  if (options?.requireBridgeAccess) {
    if (normalizedStatus !== "active") {
      throw new TenantBindingError(
        "Subscription is not active. Resume or restore access first.",
        409,
      );
    }
    if (!subscription.planCode || !plan) {
      throw new TenantBindingError(
        "Subscription has no valid plan. Assign a current plan first.",
        409,
      );
    }
    if (product.status !== "active") {
      throw new TenantBindingError("Product is inactive.", 409);
    }
  }

  const dataDbName = await ensureSubscriptionDataDb({
    _id: subscription._id,
    merchantId: subscription.merchantId,
    siteId: subscription.siteId,
    productSlug: subscription.productSlug,
    dataDbName: subscription.dataDbName,
  });

  return {
    siteId,
    productSlug: slug,
    merchantId: subscription.merchantId.toString(),
    subscriptionId: subscription._id.toString(),
    status: normalizedStatus,
    planCode: subscription.planCode ?? null,
    dataDbName,
  };
}
