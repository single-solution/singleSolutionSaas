import {
  Product,
  ProductAccessToken,
  Subscription,
} from "@/lib/db";
import {
  isRetentionActive,
  normalizeLegacySubscriptionStatus,
  resolvePlanOnProduct,
  RETENTION_MS,
  transitionSubscription,
  type SubscriptionDbStatus,
  type SubscriptionTransitionActor,
} from "@/lib/services/subscriptionLifecycle.service";

export interface ReconciliationIssue {
  subscriptionId: string;
  siteId: string;
  productSlug: string;
  issue: string;
  currentStatus: string;
  planCode: string | null;
  proposedStatus?: SubscriptionDbStatus;
  proposedPlanCode?: string | null;
}

export interface ReconciliationReport {
  dryRun: boolean;
  scanned: number;
  issues: ReconciliationIssue[];
  fixed: number;
}

const SYSTEM_ACTOR: SubscriptionTransitionActor = {
  userId: null,
  reason: "subscription reconciliation",
};

export async function reconcileSubscriptions(options?: {
  dryRun?: boolean;
}): Promise<ReconciliationReport> {
  const dryRun = options?.dryRun !== false;
  const subscriptions = await Subscription.find().lean();
  const products = await Product.find().lean();
  const productBySlug = new Map(products.map((product) => [product.slug, product]));

  const issues: ReconciliationIssue[] = [];
  let fixed = 0;

  for (const subscription of subscriptions) {
    const subscriptionId = subscription._id.toString();
    const siteId = subscription.siteId.toString();
    const productSlug = subscription.productSlug;
    const product = productBySlug.get(productSlug);
    const normalizedStatus = normalizeLegacySubscriptionStatus(subscription);

    if (normalizedStatus !== subscription.status) {
      issues.push({
        subscriptionId,
        siteId,
        productSlug,
        issue: "active_without_plan",
        currentStatus: subscription.status,
        planCode: subscription.planCode ?? null,
        proposedStatus: "archived",
      });
      if (!dryRun) {
        const document = await Subscription.findById(subscription._id);
        if (document) {
          await transitionSubscription(document, "archived", SYSTEM_ACTOR);
          fixed += 1;
        }
      }
      continue;
    }

    if (
      (subscription.status === "active" || subscription.status === "suspended") &&
      subscription.planCode &&
      product &&
      !resolvePlanOnProduct(product, subscription.planCode)
    ) {
      issues.push({
        subscriptionId,
        siteId,
        productSlug,
        issue: "orphan_plan_code",
        currentStatus: subscription.status,
        planCode: subscription.planCode,
        proposedStatus: "archived",
      });
      if (!dryRun) {
        const document = await Subscription.findById(subscription._id);
        if (document) {
          await transitionSubscription(document, "archived", SYSTEM_ACTOR);
          fixed += 1;
        }
      }
      continue;
    }

    if (
      subscription.status === "archived" &&
      subscription.deletionEligibleAt &&
      !isRetentionActive(subscription.deletionEligibleAt)
    ) {
      issues.push({
        subscriptionId,
        siteId,
        productSlug,
        issue: "retention_expired",
        currentStatus: subscription.status,
        planCode: subscription.planCode ?? null,
      });
      continue;
    }

    if (subscription.status === "archived") {
      const activeTokens = await ProductAccessToken.countDocuments({
        siteId: subscription.siteId,
        productSlug,
        revokedAt: null,
      });
      if (activeTokens > 0) {
        issues.push({
          subscriptionId,
          siteId,
          productSlug,
          issue: "archived_with_active_tokens",
          currentStatus: subscription.status,
          planCode: subscription.planCode ?? null,
        });
        if (!dryRun) {
          await ProductAccessToken.updateMany(
            {
              siteId: subscription.siteId,
              productSlug,
              revokedAt: null,
            },
            { $set: { revokedAt: new Date() } },
          );
          fixed += 1;
        }
      }
    }

    if (
      subscription.status === "archived" &&
      !subscription.deletionEligibleAt &&
      subscription.planCode
    ) {
      issues.push({
        subscriptionId,
        siteId,
        productSlug,
        issue: "missing_retention_timestamp",
        currentStatus: subscription.status,
        planCode: subscription.planCode,
      });
      if (!dryRun) {
        await Subscription.updateOne(
          { _id: subscription._id },
          { $set: { deletionEligibleAt: new Date(Date.now() + RETENTION_MS) } },
        );
        fixed += 1;
      }
    }
  }

  return {
    dryRun,
    scanned: subscriptions.length,
    issues,
    fixed,
  };
}

export async function countAssignedSubscriptionsForProduct(
  productSlug: string,
  planCodes?: string[],
): Promise<number> {
  const filter: Record<string, unknown> = {
    productSlug: productSlug.toLowerCase(),
    status: { $in: ["active", "suspended"] },
    planCode: { $ne: null },
  };
  if (planCodes && planCodes.length > 0) {
    filter.planCode = { $in: planCodes };
  }
  return Subscription.countDocuments(filter);
}

export async function findRemovedPlanConflicts(
  productSlug: string,
  nextPlanCodes: string[],
): Promise<{ planCode: string; count: number }[]> {
  const product = await Product.findOne({ slug: productSlug.toLowerCase() }).lean();
  if (!product) {
    return [];
  }
  const removedCodes = product.plans
    .map((plan) => plan.code)
    .filter((code) => !nextPlanCodes.includes(code));
  if (removedCodes.length === 0) {
    return [];
  }
  const conflicts: { planCode: string; count: number }[] = [];
  for (const planCode of removedCodes) {
    const count = await Subscription.countDocuments({
      productSlug: product.slug,
      planCode,
      status: { $in: ["active", "suspended"] },
    });
    if (count > 0) {
      conflicts.push({ planCode, count });
    }
  }
  return conflicts;
}
