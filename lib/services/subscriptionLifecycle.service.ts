import {
  Product,
  ProductAccessToken,
  Subscription,
  Types,
  type SubscriptionDocument,
} from "@/lib/db";
import { writeAuditLog } from "@/lib/services/platform.service";
import { ensureSubscriptionDataDb } from "@/lib/services/tenantDb";

export const SUBSCRIPTION_STATUSES = ["active", "suspended", "archived"] as const;
export type SubscriptionDbStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const RETENTION_MS = 30 * 24 * 60 * 60_000;

const ALLOWED_TRANSITIONS: Record<SubscriptionDbStatus, SubscriptionDbStatus[]> = {
  active: ["suspended", "archived"],
  suspended: ["active", "archived"],
  archived: ["active"],
};

export class SubscriptionLifecycleError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "SubscriptionLifecycleError";
  }
}

export interface SubscriptionTransitionActor {
  userId: string | null;
  reason?: string;
}

function assertTransitionAllowed(from: SubscriptionDbStatus, to: SubscriptionDbStatus): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new SubscriptionLifecycleError(
      `Cannot move subscription from ${from} to ${to}.`,
      "INVALID_TRANSITION",
    );
  }
}

async function appendTransition(
  subscriptionId: Types.ObjectId | { toString(): string },
  input: {
    fromStatus: SubscriptionDbStatus | null;
    toStatus: SubscriptionDbStatus;
    actor: SubscriptionTransitionActor;
  },
): Promise<void> {
  const objectId =
    subscriptionId instanceof Types.ObjectId
      ? subscriptionId
      : new Types.ObjectId(subscriptionId.toString());
  await Subscription.updateOne(
    { _id: objectId },
    {
      $push: {
        lifecycleHistory: {
          fromStatus: input.fromStatus,
          toStatus: input.toStatus,
          actorUserId: input.actor.userId
            ? new Types.ObjectId(input.actor.userId)
            : null,
          reason: input.actor.reason?.trim() || "",
          at: new Date(),
        },
      },
    },
  );
}

async function revokeActiveTokens(
  siteId: Types.ObjectId,
  productSlug: string,
): Promise<number> {
  const result = await ProductAccessToken.updateMany(
    { siteId, productSlug, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
  return result.modifiedCount;
}

export function isRetentionActive(deletionEligibleAt: Date | null | undefined): boolean {
  if (!deletionEligibleAt) {
    return true;
  }
  return deletionEligibleAt.getTime() > Date.now();
}

export function resolvePlanOnProduct(
  product: { plans: { code: string }[] },
  planCode: string | null | undefined,
): { code: string } | null {
  if (!planCode) {
    return null;
  }
  return product.plans.find((plan) => plan.code === planCode) ?? null;
}

export async function transitionSubscription(
  subscription: SubscriptionDocument,
  toStatus: SubscriptionDbStatus,
  actor: SubscriptionTransitionActor,
  options?: { planCode?: string | null },
): Promise<SubscriptionDocument> {
  const fromStatus = subscription.status as SubscriptionDbStatus;
  if (fromStatus === toStatus && options?.planCode === undefined) {
    return subscription;
  }
  assertTransitionAllowed(fromStatus, toStatus);

  const product = await Product.findOne({ slug: subscription.productSlug }).lean();
  if (!product) {
    throw new SubscriptionLifecycleError("Product not found.", "PRODUCT_NOT_FOUND");
  }

  const nextPlanCode =
    options?.planCode !== undefined ? options.planCode : subscription.planCode;

  if (toStatus === "active") {
    if (!nextPlanCode) {
      throw new SubscriptionLifecycleError(
        "Active subscriptions require a plan.",
        "PLAN_REQUIRED",
      );
    }
    if (!resolvePlanOnProduct(product, nextPlanCode)) {
      throw new SubscriptionLifecycleError(
        "Plan no longer exists on this product.",
        "PLAN_NOT_FOUND",
      );
    }
    if (product.status !== "active") {
      throw new SubscriptionLifecycleError(
        "Product is inactive.",
        "PRODUCT_INACTIVE",
      );
    }
  }

  if (toStatus === "suspended" && !nextPlanCode) {
    throw new SubscriptionLifecycleError(
      "Suspended subscriptions require a plan.",
      "PLAN_REQUIRED",
    );
  }

  if (fromStatus === "archived" && toStatus === "active") {
    if (!isRetentionActive(subscription.deletionEligibleAt)) {
      throw new SubscriptionLifecycleError(
        "Retention period has expired; restore is no longer available.",
        "RETENTION_EXPIRED",
      );
    }
  }

  const update: Record<string, unknown> = { status: toStatus };
  if (options?.planCode !== undefined) {
    update.planCode = options.planCode;
  }
  if (toStatus === "archived") {
    update.deletionEligibleAt = new Date(Date.now() + RETENTION_MS);
  }
  if (toStatus === "active") {
    update.deletionEligibleAt = null;
  }

  const updated = await Subscription.findOneAndUpdate(
    { _id: subscription._id },
    { $set: update },
    { new: true },
  );
  if (!updated) {
    throw new SubscriptionLifecycleError("Subscription not found.", "NOT_FOUND");
  }

  if (toStatus === "archived") {
    await revokeActiveTokens(subscription.siteId, subscription.productSlug);
  }

  await appendTransition(subscription._id, {
    fromStatus,
    toStatus,
    actor,
  });

  return updated;
}

export async function assignSubscriptionPlan(input: {
  siteId: string;
  merchantId: Types.ObjectId;
  productSlug: string;
  planCode: string;
  actor: SubscriptionTransitionActor;
}): Promise<SubscriptionDocument> {
  const product = await Product.findOne({
    slug: input.productSlug.toLowerCase(),
    status: "active",
  }).lean();
  if (!product) {
    throw new SubscriptionLifecycleError("Product not found.", "PRODUCT_NOT_FOUND");
  }
  if (!resolvePlanOnProduct(product, input.planCode)) {
    throw new SubscriptionLifecycleError("Unknown plan for this product.", "PLAN_NOT_FOUND");
  }

  let subscription = await Subscription.findOne({
    siteId: new Types.ObjectId(input.siteId),
    productSlug: product.slug,
  });

  if (!subscription) {
    subscription = await Subscription.create({
      merchantId: input.merchantId,
      siteId: new Types.ObjectId(input.siteId),
      productSlug: product.slug,
      planCode: input.planCode,
      status: "active",
    });
    await appendTransition(subscription._id, {
      fromStatus: null,
      toStatus: "active",
      actor: input.actor,
    });
    await ensureSubscriptionDataDb({
      _id: subscription._id,
      merchantId: subscription.merchantId,
      siteId: subscription.siteId,
      productSlug: subscription.productSlug,
      dataDbName: subscription.dataDbName,
    });
    return subscription;
  }

  const currentStatus = subscription.status as SubscriptionDbStatus;
  if (currentStatus === "archived") {
    const restored = await transitionSubscription(subscription, "active", input.actor, {
      planCode: input.planCode,
    });
    await writeAuditLog({
      merchantId: input.merchantId.toString(),
      actorUserId: input.actor.userId,
      action: "subscription.restored",
      resourceType: "subscription",
      resourceId: product.slug,
      metadata: { siteId: input.siteId, productSlug: product.slug, planCode: input.planCode },
    });
    return restored;
  }

  subscription.planCode = input.planCode;
  if (currentStatus !== "active") {
    return transitionSubscription(subscription, "active", input.actor, {
      planCode: input.planCode,
    });
  }
  await subscription.save();
  return subscription;
}

export async function unassignSubscription(
  subscription: SubscriptionDocument,
  actor: SubscriptionTransitionActor,
): Promise<SubscriptionDocument> {
  const revokedCount = await revokeActiveTokens(
    subscription.siteId,
    subscription.productSlug,
  );
  const archived = await transitionSubscription(subscription, "archived", {
    ...actor,
    reason: actor.reason ?? "Unassigned",
  });
  await writeAuditLog({
    merchantId: subscription.merchantId.toString(),
    actorUserId: actor.userId,
    action: "subscription.unassigned",
    resourceType: "subscription",
    resourceId: subscription.productSlug,
    metadata: {
      siteId: subscription.siteId.toString(),
      revokedTokens: revokedCount,
      deletionEligibleAt: archived.deletionEligibleAt?.toISOString() ?? null,
    },
  });
  return archived;
}

export async function restoreSubscription(
  subscription: SubscriptionDocument,
  actor: SubscriptionTransitionActor,
): Promise<SubscriptionDocument> {
  if ((subscription.status as SubscriptionDbStatus) !== "archived") {
    throw new SubscriptionLifecycleError(
      "Only archived subscriptions can be restored.",
      "NOT_ARCHIVED",
    );
  }
  if (!subscription.planCode) {
    throw new SubscriptionLifecycleError(
      "Archived subscription has no plan to restore.",
      "PLAN_REQUIRED",
    );
  }
  const restored = await transitionSubscription(subscription, "active", actor);
  await writeAuditLog({
    merchantId: subscription.merchantId.toString(),
    actorUserId: actor.userId,
    action: "subscription.restored",
    resourceType: "subscription",
    resourceId: subscription.productSlug,
    metadata: { siteId: subscription.siteId.toString() },
  });
  return restored;
}

export function normalizeLegacySubscriptionStatus(
  subscription: Pick<SubscriptionDocument, "status" | "planCode">,
): SubscriptionDbStatus {
  if (
    subscription.status === "active" &&
    (!subscription.planCode || subscription.planCode.trim() === "")
  ) {
    return "archived";
  }
  return subscription.status as SubscriptionDbStatus;
}
