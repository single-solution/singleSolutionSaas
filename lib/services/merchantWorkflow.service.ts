import {
  ExportOutbox,
  Merchant,
  MerchantMembership,
  Product,
  ProductAccessToken,
  Site,
  Subscription,
  Types,
  User,
} from "@/lib/db";
import { generateInviteToken, generateRecoveryToken, hashApiKey } from "@/lib/crypto";
import { domainMatchesAllowlist, normalizeHostname } from "@/lib/domains";
import { loadEnvironment } from "@/lib/env";
import {
  enqueueInviteEmail,
  inviteEmailIdempotencyKey,
  enqueueRecoveryEmail,
} from "@/lib/services/emailOutbox.service";
import {
  type RequestActor,
  writeAuditLog,
} from "@/lib/services/platform.service";
import { RETENTION_MS } from "@/lib/services/subscriptionLifecycle.service";
import { transitionSubscription } from "@/lib/services/subscriptionLifecycle.service";
import type {
  MerchantBillingSummary,
  MerchantMemberSummary,
  MerchantOffboardingSummary,
  MerchantSummary,
  PaginatedResponse,
  SiteDomainReadiness,
  SubscriptionHistoryEntry,
} from "@/lib/types";
import { hashPassword } from "@/lib/password";
import { safeFetch } from "@/lib/security/outboundUrl";
import { isProduction } from "@/lib/utils";
import { getPagination } from "@/lib/utils";

const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;
const RECOVERY_TTL_MS = 24 * 60 * 60_000;

function toIso(value: Date): string {
  return value.toISOString();
}

function buildRecoveryUrl(token: string): string | null {
  const { APP_URL } = loadEnvironment();
  if (!APP_URL) {
    return null;
  }
  return `${APP_URL.replace(/\/$/, "")}/recover-account?token=${encodeURIComponent(token)}`;
}

export async function verifySiteDomain(
  actor: RequestActor,
  siteId: string,
): Promise<
  | {
      verified: boolean;
      verifiedAt: string | null;
      message: string;
      site: SiteDomainReadiness;
    }
  | "NOT_FOUND"
  | "NO_DOMAIN"
> {
  const site = await Site.findById(siteId);
  if (!site) {
    return "NOT_FOUND";
  }
  const primaryDomain = site.primaryDomain?.trim() ?? "";
  if (!primaryDomain) {
    return "NO_DOMAIN";
  }

  let verified = false;
  let message = "Domain could not be verified.";
  const environment = loadEnvironment();
  try {
    const { response } = await safeFetch(`https://${primaryDomain}`, {
      method: "HEAD",
      isProduction: isProduction(environment),
      allowLocalhost: !isProduction(environment),
      timeoutMs: 8_000,
      maxResponseBytes: 4_096,
    });
    if (response.status >= 200 && response.status < 500) {
      verified = true;
      message = `Domain responded with HTTP ${response.status}.`;
    }
  } catch {
    try {
      const { response } = await safeFetch(`https://${primaryDomain}`, {
        method: "GET",
        isProduction: isProduction(environment),
        allowLocalhost: !isProduction(environment),
        timeoutMs: 8_000,
        maxResponseBytes: 4_096,
      });
      if (response.status >= 200 && response.status < 500) {
        verified = true;
        message = `Domain responded with HTTP ${response.status}.`;
      }
    } catch {
      message =
        "Could not reach the domain over HTTPS. Confirm DNS and TLS, then try again.";
    }
  }

  if (verified) {
    site.domainVerifiedAt = new Date();
    await site.save();
    await writeAuditLog({
      merchantId: site.merchantId.toString(),
      actorUserId: actor.userId,
      action: "site.domain_verified",
      resourceType: "site",
      resourceId: siteId,
      metadata: { primaryDomain },
    });
  }

  const readiness = (await getSiteDomainReadiness(siteId))!;
  return {
    verified,
    verifiedAt: site.domainVerifiedAt ? toIso(site.domainVerifiedAt) : null,
    message,
    site: readiness,
  };
}

export async function syncSiteTokenDomains(
  actor: RequestActor,
  siteId: string,
): Promise<{ updated: number } | "NOT_FOUND" | "NO_DOMAIN"> {
  const site = await Site.findById(siteId).lean();
  if (!site) {
    return "NOT_FOUND";
  }
  const primaryDomain = site.primaryDomain?.trim() ?? "";
  if (!primaryDomain) {
    return "NO_DOMAIN";
  }

  const result = await ProductAccessToken.updateMany(
    { siteId: site._id, revokedAt: null },
    { $set: { allowedDomains: [primaryDomain] } },
  );

  await writeAuditLog({
    merchantId: site.merchantId.toString(),
    actorUserId: actor.userId,
    action: "site.token_domains_synced",
    resourceType: "site",
    resourceId: siteId,
    metadata: { primaryDomain, updated: result.modifiedCount },
  });

  return { updated: result.modifiedCount };
}

export async function getSiteDomainReadiness(
  siteId: string,
): Promise<SiteDomainReadiness | null> {
  const site = await Site.findById(siteId).lean();
  if (!site) {
    return null;
  }
  const primaryDomain = site.primaryDomain ?? "";
  const tokens = await ProductAccessToken.find({
    siteId: site._id,
    revokedAt: null,
  })
    .select("productSlug allowedDomains")
    .lean();

  const mismatchedTokens = tokens
    .filter(
      (token) =>
        primaryDomain &&
        token.allowedDomains.length > 0 &&
        !token.allowedDomains.some((allowed) =>
          domainMatchesAllowlist(primaryDomain, [allowed]),
        ) &&
        !token.allowedDomains.includes(primaryDomain),
    )
    .map((token) => ({
      tokenId: token._id.toString(),
      productSlug: token.productSlug,
      allowedDomains: [...(token.allowedDomains ?? [])],
    }));

  return {
    siteId: site._id.toString(),
    primaryDomain,
    domainReady: Boolean(primaryDomain),
    tokenCount: tokens.length,
    mismatchedTokens,
    hasMismatch: mismatchedTokens.length > 0,
  };
}

export async function getMerchantBilling(
  merchantId: string,
): Promise<MerchantBillingSummary | null> {
  const merchant = await Merchant.findById(merchantId).lean();
  if (!merchant) {
    return null;
  }

  const sites = await Site.find({ merchantId: merchant._id })
    .select("_id name slug primaryDomain")
    .lean();
  const siteIds = sites.map((site) => site._id);
  const subscriptions = await Subscription.find({
    siteId: { $in: siteIds },
    status: "active",
    planCode: { $ne: null },
  })
    .select("siteId productSlug planCode")
    .lean();

  const products = await Product.find({
    slug: { $in: subscriptions.map((subscription) => subscription.productSlug) },
  })
    .select("slug name plans")
    .lean();
  const productBySlug = new Map(products.map((product) => [product.slug, product]));
  const siteById = new Map(sites.map((site) => [site._id.toString(), site]));

  const lineItems: MerchantBillingSummary["lineItems"] = [];
  const totalsByCurrency = new Map<string, number>();

  for (const subscription of subscriptions) {
    const product = productBySlug.get(subscription.productSlug);
    const site = siteById.get(subscription.siteId.toString());
    const plan = product?.plans.find(
      (candidate) => candidate.code === subscription.planCode,
    );
    if (!product || !site || !plan) {
      continue;
    }
    lineItems.push({
      siteId: site._id.toString(),
      siteName: site.name,
      productSlug: product.slug,
      productName: product.name,
      planCode: plan.code,
      planName: plan.name,
      amount: plan.priceMonthly,
      currency: plan.currency,
    });
    totalsByCurrency.set(
      plan.currency,
      (totalsByCurrency.get(plan.currency) ?? 0) + plan.priceMonthly,
    );
  }

  return {
    merchantId,
    totals: [...totalsByCurrency.entries()].map(([currency, amount]) => ({
      currency,
      amount,
    })),
    lineItems: lineItems.sort((left, right) =>
      left.siteName.localeCompare(right.siteName),
    ),
  };
}

export async function listMerchantMembers(
  merchantId: string,
): Promise<MerchantMemberSummary[]> {
  const memberships = await MerchantMembership.find({
    merchantId: new Types.ObjectId(merchantId),
  })
    .sort({ createdAt: 1 })
    .lean();
  const users = await User.find({
    _id: { $in: memberships.map((membership) => membership.userId) },
  })
    .select("_id email name status")
    .lean();
  const userById = new Map(users.map((user) => [user._id.toString(), user]));

  return memberships
    .map((membership) => {
      const user = userById.get(membership.userId.toString());
      if (!user) {
        return null;
      }
      return {
        userId: user._id.toString(),
        email: user.email,
        name: user.name,
        role: membership.role,
        status: user.status,
        invited: user.status === "invited",
      };
    })
    .filter((member): member is MerchantMemberSummary => member !== null);
}

export async function inviteMerchantMember(
  actor: RequestActor,
  merchantId: string,
  input: { email: string; name: string; role: "admin" | "member" },
): Promise<MerchantMemberSummary | "EMAIL_TAKEN" | "NOT_FOUND"> {
  const merchant = await Merchant.findById(merchantId).lean();
  if (!merchant) {
    return "NOT_FOUND";
  }

  const email = input.email.toLowerCase();
  let user = await User.findOne({ email });
  if (user && user.status === "active") {
    const existing = await MerchantMembership.findOne({
      merchantId: merchant._id,
      userId: user._id,
    }).lean();
    if (existing) {
      return "EMAIL_TAKEN";
    }
    await MerchantMembership.create({
      merchantId: merchant._id,
      userId: user._id,
      role: input.role,
    });
  } else if (user && user.status === "invited") {
    return "EMAIL_TAKEN";
  } else {
    const { token, tokenHash } = generateInviteToken();
    user = await User.create({
      email,
      name: input.name,
      isPlatformAdmin: false,
      sessionVersion: 0,
      status: "invited",
      inviteTokenHash: tokenHash,
      inviteTokenExpiresAt: new Date(Date.now() + INVITE_TTL_MS),
    });
    await MerchantMembership.create({
      merchantId: merchant._id,
      userId: user._id,
      role: input.role,
    });
    const inviteUrl = `${loadEnvironment().APP_URL?.replace(/\/$/, "") ?? ""}/accept-invite?token=${encodeURIComponent(token)}`;
    if (inviteUrl.startsWith("http")) {
      await enqueueInviteEmail({
        idempotencyKey: inviteEmailIdempotencyKey(user._id.toString(), tokenHash),
        to: email,
        recipientName: input.name,
        merchantName: merchant.name,
        inviteUrl,
        expiresInDays: 7,
      });
    }
  }

  await writeAuditLog({
    merchantId,
    actorUserId: actor.userId,
    action: "merchant.member_invited",
    resourceType: "merchant_membership",
    resourceId: user._id.toString(),
    metadata: { email, role: input.role },
  });

  return {
    userId: user._id.toString(),
    email: user.email,
    name: user.name,
    role: input.role,
    status: user.status,
    invited: user.status === "invited",
  };
}

export async function updateMerchantMemberRole(
  actor: RequestActor,
  merchantId: string,
  userId: string,
  role: "owner" | "admin" | "member",
): Promise<MerchantMemberSummary | "NOT_FOUND" | "OWNER_PROTECTED"> {
  const membership = await MerchantMembership.findOne({
    merchantId: new Types.ObjectId(merchantId),
    userId: new Types.ObjectId(userId),
  });
  if (!membership) {
    return "NOT_FOUND";
  }
  if (membership.role === "owner" && role !== "owner") {
    return "OWNER_PROTECTED";
  }
  membership.role = role;
  await membership.save();
  const user = await User.findById(userId).lean();
  if (!user) {
    return "NOT_FOUND";
  }

  await writeAuditLog({
    merchantId,
    actorUserId: actor.userId,
    action: "merchant.member_role_changed",
    resourceType: "merchant_membership",
    resourceId: userId,
    metadata: { role },
  });

  return {
    userId: user._id.toString(),
    email: user.email,
    name: user.name,
    role: membership.role,
    status: user.status,
    invited: user.status === "invited",
  };
}

export async function removeMerchantMember(
  actor: RequestActor,
  merchantId: string,
  userId: string,
): Promise<"OK" | "NOT_FOUND" | "OWNER_PROTECTED"> {
  const membership = await MerchantMembership.findOne({
    merchantId: new Types.ObjectId(merchantId),
    userId: new Types.ObjectId(userId),
  });
  if (!membership) {
    return "NOT_FOUND";
  }
  if (membership.role === "owner") {
    return "OWNER_PROTECTED";
  }
  await membership.deleteOne();
  await writeAuditLog({
    merchantId,
    actorUserId: actor.userId,
    action: "merchant.member_removed",
    resourceType: "merchant_membership",
    resourceId: userId,
  });
  return "OK";
}

export async function sendOwnerRecovery(
  actor: RequestActor,
  merchantId: string,
): Promise<
  | { emailSent: boolean; emailQueued: boolean; ownerEmail: string }
  | "NOT_FOUND"
  | "NOT_ACTIVE"
> {
  const merchant = await Merchant.findById(merchantId).lean();
  if (!merchant) {
    return "NOT_FOUND";
  }
  const ownerMembership = await MerchantMembership.findOne({
    merchantId: merchant._id,
    role: "owner",
  }).lean();
  if (!ownerMembership) {
    return "NOT_FOUND";
  }
  const owner = await User.findById(ownerMembership.userId);
  if (!owner || owner.status !== "active") {
    return "NOT_ACTIVE";
  }

  const { token, tokenHash } = generateRecoveryToken();
  owner.recoveryTokenHash = tokenHash;
  owner.recoveryTokenExpiresAt = new Date(Date.now() + RECOVERY_TTL_MS);
  await owner.save();

  const recoveryUrl = buildRecoveryUrl(token);
  let emailQueued = false;
  if (recoveryUrl) {
    await enqueueRecoveryEmail({
      idempotencyKey: `recovery:${owner._id.toString()}:${tokenHash}`,
      to: owner.email,
      recipientName: owner.name,
      recoveryUrl,
      expiresInHours: 24,
    });
    emailQueued = true;
  }

  await writeAuditLog({
    merchantId,
    actorUserId: actor.userId,
    action: "merchant.owner_recovery_sent",
    resourceType: "user",
    resourceId: owner._id.toString(),
    metadata: { ownerEmail: owner.email, emailQueued },
  });

  return {
    emailSent: false,
    emailQueued,
    ownerEmail: owner.email,
  };
}

export async function getRecoveryInfo(
  token: string,
): Promise<{ email: string; name: string } | null> {
  const user = await User.findOne({
    recoveryTokenHash: hashApiKey(token),
    status: "active",
  }).lean();
  if (
    !user ||
    !user.recoveryTokenExpiresAt ||
    user.recoveryTokenExpiresAt.getTime() < Date.now()
  ) {
    return null;
  }
  return { email: user.email, name: user.name };
}

export async function acceptRecovery(
  token: string,
  password: string,
): Promise<MerchantSummary | null> {
  const user = await User.findOne({
    recoveryTokenHash: hashApiKey(token),
    status: "active",
  });
  if (
    !user ||
    !user.recoveryTokenExpiresAt ||
    user.recoveryTokenExpiresAt.getTime() < Date.now()
  ) {
    return null;
  }
  user.passwordHash = await hashPassword(password);
  user.recoveryTokenHash = null;
  user.recoveryTokenExpiresAt = null;
  user.sessionVersion += 1;
  await user.save();
  const membership = await MerchantMembership.findOne({ userId: user._id }).lean();
  const merchant = membership
    ? await Merchant.findById(membership.merchantId).lean()
    : null;
  if (!merchant || !membership) {
    return null;
  }
  return {
    id: merchant._id.toString(),
    name: merchant.name,
    slug: merchant.slug,
    role: membership.role,
    createdAt: toIso(merchant.createdAt),
  };
}

export async function listSubscriptionHistory(
  merchantId: string,
  page: number,
  pageSize: number,
): Promise<PaginatedResponse<SubscriptionHistoryEntry>> {
  const sites = await Site.find({ merchantId: new Types.ObjectId(merchantId) })
    .select("_id name")
    .lean();
  const siteIds = sites.map((site) => site._id);
  const siteById = new Map(sites.map((site) => [site._id.toString(), site.name]));
  const subscriptions = await Subscription.find({ siteId: { $in: siteIds } })
    .select("siteId productSlug lifecycleHistory")
    .lean();

  const products = await Product.find({
    slug: { $in: subscriptions.map((subscription) => subscription.productSlug) },
  })
    .select("slug name")
    .lean();
  const productBySlug = new Map(products.map((product) => [product.slug, product.name]));

  const entries: SubscriptionHistoryEntry[] = [];
  for (const subscription of subscriptions) {
    const siteName = siteById.get(subscription.siteId.toString()) ?? "Site";
    const productName =
      productBySlug.get(subscription.productSlug) ?? subscription.productSlug;
    for (const transition of subscription.lifecycleHistory ?? []) {
      entries.push({
        id: `${subscription._id.toString()}-${transition.at.toISOString()}`,
        siteId: subscription.siteId.toString(),
        siteName,
        productSlug: subscription.productSlug,
        productName,
        fromStatus: transition.fromStatus ?? null,
        toStatus: transition.toStatus,
        reason: transition.reason ?? "",
        actorUserId: transition.actorUserId?.toString() ?? null,
        at: toIso(transition.at),
      });
    }
  }

  entries.sort((left, right) => right.at.localeCompare(left.at));
  const { offset, limit, page: safePage, pageSize: safePageSize } = getPagination(
    page,
    pageSize,
  );
  return {
    items: entries.slice(offset, offset + limit),
    page: safePage,
    pageSize: safePageSize,
    total: entries.length,
  };
}

export async function getMerchantOffboarding(
  merchantId: string,
): Promise<MerchantOffboardingSummary | null> {
  const merchant = await Merchant.findById(merchantId).lean();
  if (!merchant) {
    return null;
  }

  const sites = await Site.find({ merchantId: merchant._id }).select("_id").lean();
  const siteIds = sites.map((site) => site._id);
  const [activeSubscriptions, activeTokens, exportJob] = await Promise.all([
    Subscription.countDocuments({
      siteId: { $in: siteIds },
      status: { $in: ["active", "suspended"] },
      planCode: { $ne: null },
    }),
    ProductAccessToken.countDocuments({
      siteId: { $in: siteIds },
      revokedAt: null,
    }),
    ExportOutbox.findOne({ merchantId: merchant._id })
      .sort({ createdAt: -1 })
      .lean(),
  ]);

  const deletionEligibleAt = merchant.deletionEligibleAt;
  const canDelete = Boolean(
    merchant.lifecycleStatus === "offboarding" &&
      deletionEligibleAt &&
      deletionEligibleAt.getTime() <= Date.now(),
  );
  const canRestore = Boolean(
    merchant.lifecycleStatus === "offboarding" &&
      deletionEligibleAt &&
      deletionEligibleAt.getTime() > Date.now(),
  );

  return {
    merchantId,
    lifecycleStatus: merchant.lifecycleStatus,
    offboardingStartedAt: merchant.offboardingStartedAt
      ? toIso(merchant.offboardingStartedAt)
      : null,
    deletionEligibleAt: deletionEligibleAt ? toIso(deletionEligibleAt) : null,
    exportRequestedAt: merchant.exportRequestedAt
      ? toIso(merchant.exportRequestedAt)
      : null,
    exportStatus: exportJob?.status ?? null,
    activeSubscriptions,
    activeTokens,
    canRestore,
    canDelete,
    retentionDays: 30,
  };
}

export async function startMerchantOffboarding(
  actor: RequestActor,
  merchantId: string,
): Promise<MerchantOffboardingSummary | "NOT_FOUND" | "ALREADY_OFFBOARDING"> {
  const merchant = await Merchant.findById(merchantId);
  if (!merchant) {
    return "NOT_FOUND";
  }
  if (merchant.lifecycleStatus !== "active") {
    return "ALREADY_OFFBOARDING";
  }

  const sites = await Site.find({ merchantId: merchant._id }).select("_id").lean();
  const siteIds = sites.map((site) => site._id);
  const subscriptions = await Subscription.find({
    siteId: { $in: siteIds },
    status: "active",
    planCode: { $ne: null },
  });

  for (const subscription of subscriptions) {
    await transitionSubscription(subscription, "suspended", {
      userId: actor.userId,
      reason: "Merchant offboarding staged",
    });
  }

  await ProductAccessToken.updateMany(
    { siteId: { $in: siteIds }, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );

  merchant.lifecycleStatus = "offboarding";
  merchant.offboardingStartedAt = new Date();
  merchant.deletionEligibleAt = new Date(Date.now() + RETENTION_MS);
  await merchant.save();

  await writeAuditLog({
    merchantId,
    actorUserId: actor.userId,
    action: "merchant.offboarding_started",
    resourceType: "merchant",
    resourceId: merchantId,
    metadata: {
      suspendedSubscriptions: subscriptions.length,
      deletionEligibleAt: merchant.deletionEligibleAt.toISOString(),
    },
  });

  return (await getMerchantOffboarding(merchantId))!;
}

export async function requestMerchantExport(
  actor: RequestActor,
  merchantId: string,
): Promise<MerchantOffboardingSummary | "NOT_FOUND"> {
  const merchant = await Merchant.findById(merchantId);
  if (!merchant) {
    return "NOT_FOUND";
  }

  const idempotencyKey = `export:${merchantId}:${Date.now()}`;
  await ExportOutbox.updateOne(
    { idempotencyKey },
    {
      $setOnInsert: {
        idempotencyKey,
        merchantId: merchant._id,
        requestedByUserId: new Types.ObjectId(actor.userId),
        status: "pending",
        attempts: 0,
        nextAttemptAt: new Date(),
        leasedUntil: null,
        leasedBy: null,
        lastError: null,
        completedAt: null,
      },
    },
    { upsert: true },
  );

  merchant.exportRequestedAt = new Date();
  await merchant.save();

  await writeAuditLog({
    merchantId,
    actorUserId: actor.userId,
    action: "merchant.export_requested",
    resourceType: "merchant",
    resourceId: merchantId,
  });

  return (await getMerchantOffboarding(merchantId))!;
}

export async function restoreMerchant(
  actor: RequestActor,
  merchantId: string,
): Promise<MerchantOffboardingSummary | "NOT_FOUND" | "NOT_ELIGIBLE"> {
  const merchant = await Merchant.findById(merchantId);
  if (!merchant) {
    return "NOT_FOUND";
  }
  if (
    merchant.lifecycleStatus !== "offboarding" ||
    !merchant.deletionEligibleAt ||
    merchant.deletionEligibleAt.getTime() <= Date.now()
  ) {
    return "NOT_ELIGIBLE";
  }

  merchant.lifecycleStatus = "active";
  merchant.offboardingStartedAt = null;
  merchant.deletionEligibleAt = null;
  merchant.exportRequestedAt = null;
  await merchant.save();

  await writeAuditLog({
    merchantId,
    actorUserId: actor.userId,
    action: "merchant.offboarding_restored",
    resourceType: "merchant",
    resourceId: merchantId,
  });

  return (await getMerchantOffboarding(merchantId))!;
}

export async function scheduleMerchantDeletion(
  actor: RequestActor,
  merchantId: string,
): Promise<MerchantOffboardingSummary | "NOT_FOUND" | "NOT_ELIGIBLE"> {
  const merchant = await Merchant.findById(merchantId);
  if (!merchant) {
    return "NOT_FOUND";
  }
  if (
    merchant.lifecycleStatus !== "offboarding" ||
    !merchant.deletionEligibleAt ||
    merchant.deletionEligibleAt.getTime() > Date.now()
  ) {
    return "NOT_ELIGIBLE";
  }

  merchant.lifecycleStatus = "deletion_scheduled";
  await merchant.save();

  await writeAuditLog({
    merchantId,
    actorUserId: actor.userId,
    action: "merchant.deletion_scheduled",
    resourceType: "merchant",
    resourceId: merchantId,
    metadata: {
      note: "Queued for cron processor; no direct database drop.",
    },
  });

  return (await getMerchantOffboarding(merchantId))!;
}

export async function getMerchantDetailForAdmin(
  merchantId: string,
): Promise<
  | (MerchantSummary & {
      pendingInvite: boolean;
      ownerEmail?: string;
    })
  | null
> {
  const merchant = await Merchant.findById(merchantId).lean();
  if (!merchant) {
    return null;
  }
  const ownerMembership = await MerchantMembership.findOne({
    merchantId: merchant._id,
    role: "owner",
  }).lean();
  const owner = ownerMembership
    ? await User.findById(ownerMembership.userId).select("email status").lean()
    : null;
  const billing = await getMerchantBilling(merchantId);

  return {
    id: merchant._id.toString(),
    name: merchant.name,
    slug: merchant.slug,
    role: "owner",
    createdAt: toIso(merchant.createdAt),
    pendingInvite: owner?.status === "invited",
    ownerEmail: owner?.email,
    monthlySpend: billing?.totals.reduce((sum, total) => sum + total.amount, 0) ?? 0,
    currency: billing?.totals[0]?.currency ?? null,
  };
}

export function normalizeDomain(value: string): string {
  return normalizeHostname(value);
}
