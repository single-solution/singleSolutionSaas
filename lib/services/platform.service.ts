import {
  AuditLog,
  Merchant,
  MerchantMembership,
  Product,
  ProductAccessToken,
  ProductUsage,
  Site,
  Subscription,
  Types,
  User,
} from "@/lib/db";
import type {
  AuditLogSummary,
  InvitationInfo,
  MerchantMemberRole,
  MerchantSummary,
  PaginatedResponse,
  SiteSummary,
  UserSummary,
} from "@/lib/types";
import { randomBytes } from "node:crypto";

import { generateInviteToken, hashApiKey } from "@/lib/crypto";
import { loadEnvironment } from "@/lib/env";
import {
  enqueueInviteEmail,
  inviteEmailIdempotencyKey,
} from "@/lib/services/emailOutbox.service";
import { hashPassword, verifyPassword } from "@/lib/password";
import { slugify } from "@/lib/slugify";
import { getPagination } from "@/lib/utils";

export interface RequestActor {
  userId: string;
  isPlatformAdmin: boolean;
}

function toIso(value: Date): string {
  return value.toISOString();
}

function mapUser(user: {
  _id: { toString(): string };
  email: string;
  name: string;
  isPlatformAdmin: boolean;
}): UserSummary {
  return {
    id: user._id.toString(),
    email: user.email,
    name: user.name,
    isPlatformAdmin: user.isPlatformAdmin,
  };
}

function mapSite(site: {
  _id: { toString(): string };
  merchantId: { toString(): string };
  name: string;
  slug: string;
  primaryDomain?: string | null;
  domainVerifiedAt?: Date | null;
  createdAt: Date;
}): SiteSummary {
  const primaryDomain = site.primaryDomain ?? "";
  const domainVerifiedAt = site.domainVerifiedAt
    ? toIso(site.domainVerifiedAt)
    : null;
  return {
    id: site._id.toString(),
    merchantId: site.merchantId.toString(),
    name: site.name,
    slug: site.slug,
    primaryDomain,
    domainVerifiedAt,
    domainVerificationStatus:
      primaryDomain && domainVerifiedAt ? "verified" : "unverified",
    createdAt: toIso(site.createdAt),
  };
}

export async function bootstrapPlatformAdmin(
  email: string,
  password: string,
): Promise<void> {
  const existing = await User.countDocuments();
  if (existing > 0) {
    return;
  }

  const passwordHash = await hashPassword(password);
  await User.create({
    email: email.toLowerCase(),
    passwordHash,
    name: "Platform Admin",
    isPlatformAdmin: true,
    sessionVersion: 0,
  });
}

export async function invalidateUserSessions(userId: string): Promise<void> {
  await User.findByIdAndUpdate(userId, { $inc: { sessionVersion: 1 } });
}

export async function authenticateUser(
  email: string,
  password: string,
): Promise<UserSummary | null> {
  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) {
    return null;
  }
  if (user.status !== "active" || !user.passwordHash) {
    return null;
  }
  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    return null;
  }
  return mapUser(user);
}

export async function getUserById(userId: string): Promise<UserSummary | null> {
  const user = await User.findById(userId);
  return user ? mapUser(user) : null;
}

export async function invalidateAllUserSessions(userId: string): Promise<void> {
  await User.findByIdAndUpdate(userId, { $inc: { sessionVersion: 1 } });
}

export async function updateUserProfile(
  userId: string,
  input: { name: string; email?: string },
): Promise<UserSummary | null> {
  const user = await User.findById(userId);
  if (!user) {
    return null;
  }
  let identityChanged = false;
  if (input.email) {
    const email = input.email.toLowerCase();
    if (email !== user.email) {
      const taken = await User.findOne({
        email,
        _id: { $ne: user._id },
      }).lean();
      if (taken) {
        throw new Error("EMAIL_TAKEN");
      }
      user.email = email;
      identityChanged = true;
    }
  }
  if (user.name !== input.name) {
    user.name = input.name;
  }
  if (identityChanged) {
    user.sessionVersion += 1;
  }
  await user.save();
  return mapUser(user);
}

export async function changeUserPassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<UserSummary | "INVALID"> {
  const user = await User.findById(userId);
  if (!user || !user.passwordHash) {
    return "INVALID";
  }
  const valid = await verifyPassword(currentPassword, user.passwordHash);
  if (!valid) {
    return "INVALID";
  }
  user.passwordHash = await hashPassword(newPassword);
  user.sessionVersion += 1;
  await user.save();
  return mapUser(user);
}

export async function getMembershipRole(
  merchantId: string,
  userId: string,
): Promise<MerchantMemberRole | null> {
  const membership = await MerchantMembership.findOne({
    merchantId: new Types.ObjectId(merchantId),
    userId: new Types.ObjectId(userId),
  }).lean();
  return membership?.role ?? null;
}

export async function listMerchantsForUser(
  userId: string,
): Promise<MerchantSummary[]> {
  const memberships = await MerchantMembership.find({
    userId: new Types.ObjectId(userId),
  })
    .sort({ createdAt: -1 })
    .lean();

  const merchantIds = memberships.map((membership) => membership.merchantId);
  const merchants = await Merchant.find({ _id: { $in: merchantIds } }).lean();
  const merchantById = new Map(
    merchants.map((merchant) => [merchant._id.toString(), merchant]),
  );

  return memberships
    .map((membership) => {
      const merchant = merchantById.get(membership.merchantId.toString());
      if (!merchant) {
        return null;
      }
      return {
        id: merchant._id.toString(),
        name: merchant.name,
        slug: merchant.slug,
        role: membership.role,
        createdAt: toIso(merchant.createdAt),
      };
    })
    .filter((merchant): merchant is MerchantSummary => merchant !== null);
}

export async function listAllMerchants(): Promise<MerchantSummary[]> {
  const merchants = await Merchant.find().sort({ createdAt: -1 }).lean();
  const merchantIds = merchants.map((merchant) => merchant._id);

  const ownerMemberships = await MerchantMembership.find({
    merchantId: { $in: merchantIds },
    role: "owner",
  }).lean();
  const ownerUsers = await User.find({
    _id: { $in: ownerMemberships.map((membership) => membership.userId) },
  })
    .select("_id status email")
    .lean();
  const ownerByUserId = new Map(
    ownerUsers.map((user) => [user._id.toString(), user]),
  );
  const ownerByMerchantId = new Map(
    ownerMemberships.map((membership) => [
      membership.merchantId.toString(),
      ownerByUserId.get(membership.userId.toString()),
    ]),
  );

  // Sites per merchant, plus a site -> merchant lookup for subscription rollups.
  const sites = await Site.find({ merchantId: { $in: merchantIds } })
    .select("_id merchantId")
    .lean();
  const merchantBySiteId = new Map(
    sites.map((site) => [site._id.toString(), site.merchantId.toString()]),
  );
  const siteCountByMerchant = new Map<string, number>();
  for (const site of sites) {
    const key = site.merchantId.toString();
    siteCountByMerchant.set(key, (siteCountByMerchant.get(key) ?? 0) + 1);
  }

  // Active priced subscriptions -> product/plan counts and monthly spend per merchant.
  const subscriptions = await Subscription.find({
    siteId: { $in: sites.map((site) => site._id) },
    status: "active",
    planCode: { $ne: null },
  })
    .select("siteId productSlug planCode")
    .lean();
  const products = await Product.find({
    slug: {
      $in: subscriptions.map((subscription) => subscription.productSlug),
    },
  })
    .select("slug plans")
    .lean();
  const planPriceBySlug = new Map(
    products.map((product) => [
      product.slug,
      new Map(
        product.plans.map((plan) => [
          plan.code,
          { price: plan.priceMonthly, currency: plan.currency },
        ]),
      ),
    ]),
  );

  const productCountByMerchant = new Map<string, number>();
  const spendByMerchant = new Map<string, number>();
  const currencyByMerchant = new Map<string, string>();
  for (const subscription of subscriptions) {
    const merchantId = merchantBySiteId.get(subscription.siteId.toString());
    if (!merchantId) {
      continue;
    }
    productCountByMerchant.set(
      merchantId,
      (productCountByMerchant.get(merchantId) ?? 0) + 1,
    );
    const plan = subscription.planCode
      ? planPriceBySlug
          .get(subscription.productSlug)
          ?.get(subscription.planCode)
      : undefined;
    if (plan) {
      spendByMerchant.set(
        merchantId,
        (spendByMerchant.get(merchantId) ?? 0) + plan.price,
      );
      if (!currencyByMerchant.has(merchantId)) {
        currencyByMerchant.set(merchantId, plan.currency);
      }
    }
  }

  return merchants.map((merchant) => {
    const key = merchant._id.toString();
    const owner = ownerByMerchantId.get(key);
    return {
      id: key,
      name: merchant.name,
      slug: merchant.slug,
      role: "owner",
      createdAt: toIso(merchant.createdAt),
      pendingInvite: owner?.status === "invited",
      ownerEmail: owner?.email,
      siteCount: siteCountByMerchant.get(key) ?? 0,
      productCount: productCountByMerchant.get(key) ?? 0,
      monthlySpend: spendByMerchant.get(key) ?? 0,
      currency: currencyByMerchant.get(key) ?? null,
    };
  });
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;
const INVITE_TTL_DAYS = 7;

function buildInviteUrl(token: string): string | null {
  const { APP_URL } = loadEnvironment();
  if (!APP_URL) {
    return null;
  }
  return `${APP_URL.replace(/\/$/, "")}/accept-invite?token=${encodeURIComponent(token)}`;
}

async function queueInviteEmail(input: {
  userId: string;
  tokenHash: string;
  ownerEmail: string;
  ownerName: string;
  merchantName: string;
  inviteUrl: string;
}): Promise<void> {
  await enqueueInviteEmail({
    idempotencyKey: inviteEmailIdempotencyKey(input.userId, input.tokenHash),
    to: input.ownerEmail,
    recipientName: input.ownerName,
    merchantName: input.merchantName,
    inviteUrl: input.inviteUrl,
    expiresInDays: INVITE_TTL_DAYS,
  });
}

interface InviteDeliveryResult {
  emailSent: boolean;
  emailQueued: boolean;
}

async function deliverInvite(input: {
  userId: string;
  tokenHash: string;
  token: string;
  ownerEmail: string;
  ownerName: string;
  merchantName: string;
}): Promise<InviteDeliveryResult> {
  const inviteUrl = buildInviteUrl(input.token);
  if (!inviteUrl) {
    return { emailSent: false, emailQueued: false };
  }
  await queueInviteEmail({
    userId: input.userId,
    tokenHash: input.tokenHash,
    ownerEmail: input.ownerEmail,
    ownerName: input.ownerName,
    merchantName: input.merchantName,
    inviteUrl,
  });
  return { emailSent: false, emailQueued: true };
}

async function generateUniqueMerchantSlug(name: string): Promise<string> {
  const base = slugify(name) || "merchant";
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate =
      attempt === 0 ? base : `${base}-${attempt + 1}`.slice(0, 80);
    const taken = await Merchant.exists({ slug: candidate });
    if (!taken) {
      return candidate;
    }
  }
  return `${base}-${randomBytes(4).toString("hex")}`.slice(0, 80);
}

async function generateUniqueSiteSlug(
  merchantId: Types.ObjectId,
  name: string,
): Promise<string> {
  const base = slugify(name) || "site";
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate =
      attempt === 0 ? base : `${base}-${attempt + 1}`.slice(0, 80);
    const taken = await Site.exists({ merchantId, slug: candidate });
    if (!taken) {
      return candidate;
    }
  }
  return `${base}-${randomBytes(4).toString("hex")}`.slice(0, 80);
}

/**
 * Removes a stale, never-completed onboarding for this email so the admin can retry.
 * Only an `invited` user with no live merchant is recoverable; an active account or a
 * pending invite tied to a real merchant is a genuine conflict and left untouched.
 */
async function reclaimOrphanedOwner(email: string): Promise<"CONFLICT" | "OK"> {
  const existing = await User.findOne({ email });
  if (!existing) {
    return "OK";
  }
  if (existing.status !== "invited") {
    return "CONFLICT";
  }
  const memberships = await MerchantMembership.find({
    userId: existing._id,
  }).lean();
  for (const membership of memberships) {
    const merchant = await Merchant.findById(membership.merchantId).lean();
    if (merchant) {
      return "CONFLICT";
    }
  }
  await MerchantMembership.deleteMany({ userId: existing._id });
  await User.deleteOne({ _id: existing._id });
  return "OK";
}

export async function createMerchant(
  actor: RequestActor,
  input: { merchantName: string; ownerName: string; ownerEmail: string },
): Promise<{
  merchant: MerchantSummary;
  owner: UserSummary;
  inviteToken: string;
  emailSent: boolean;
  emailQueued: boolean;
}> {
  const email = input.ownerEmail.toLowerCase();
  if ((await reclaimOrphanedOwner(email)) === "CONFLICT") {
    throw new Error("EMAIL_TAKEN");
  }

  const merchantSlug = await generateUniqueMerchantSlug(input.merchantName);
  const { token, tokenHash } = generateInviteToken();

  const created: { userId?: Types.ObjectId; merchantId?: Types.ObjectId } = {};
  try {
    const user = await User.create({
      email,
      name: input.ownerName,
      isPlatformAdmin: false,
      sessionVersion: 0,
      status: "invited",
      inviteTokenHash: tokenHash,
      inviteTokenExpiresAt: new Date(Date.now() + INVITE_TTL_MS),
    });
    created.userId = user._id as unknown as Types.ObjectId;

    const merchant = await Merchant.create({
      name: input.merchantName,
      slug: merchantSlug,
    });
    created.merchantId = merchant._id as unknown as Types.ObjectId;

    await MerchantMembership.create({
      merchantId: merchant._id,
      userId: user._id,
      role: "owner",
    });
    await Site.create({
      merchantId: merchant._id,
      name: "Default site",
      slug: await generateUniqueSiteSlug(
        merchant._id as unknown as Types.ObjectId,
        "Default site",
      ),
      primaryDomain: "",
    });

    const inviteDelivery = await deliverInvite({
      userId: user._id.toString(),
      tokenHash,
      token,
      ownerEmail: email,
      ownerName: user.name,
      merchantName: merchant.name,
    });

    await writeAuditLog({
      merchantId: merchant._id.toString(),
      actorUserId: actor.userId,
      action: "merchant.invited",
      resourceType: "merchant",
      resourceId: merchant._id.toString(),
      metadata: {
        name: merchant.name,
        slug: merchant.slug,
        ownerEmail: email,
        emailSent: inviteDelivery.emailSent,
        emailQueued: inviteDelivery.emailQueued,
      },
    });

    return {
      merchant: {
        id: merchant._id.toString(),
        name: merchant.name,
        slug: merchant.slug,
        role: "owner",
        createdAt: toIso(merchant.createdAt),
        pendingInvite: true,
      },
      owner: mapUser(user),
      inviteToken: token,
      emailSent: inviteDelivery.emailSent,
      emailQueued: inviteDelivery.emailQueued,
    };
  } catch (error) {
    if (created.merchantId) {
      await Site.deleteMany({ merchantId: created.merchantId });
      await MerchantMembership.deleteMany({ merchantId: created.merchantId });
      await Merchant.deleteOne({ _id: created.merchantId });
    }
    if (created.userId) {
      await User.deleteOne({ _id: created.userId });
    }
    throw error;
  }
}

export async function resendMerchantInvitation(
  actor: RequestActor,
  merchantId: string,
): Promise<
  | { inviteToken: string; emailSent: boolean; emailQueued: boolean; ownerEmail: string }
  | "NOT_FOUND"
  | "ALREADY_ACTIVE"
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
  if (!owner) {
    return "NOT_FOUND";
  }
  if (owner.status !== "invited") {
    return "ALREADY_ACTIVE";
  }

  const { token, tokenHash } = generateInviteToken();
  owner.inviteTokenHash = tokenHash;
  owner.inviteTokenExpiresAt = new Date(Date.now() + INVITE_TTL_MS);
  await owner.save();

  const inviteDelivery = await deliverInvite({
    userId: owner._id.toString(),
    tokenHash,
    token,
    ownerEmail: owner.email,
    ownerName: owner.name,
    merchantName: merchant.name,
  });

  await writeAuditLog({
    merchantId: merchant._id.toString(),
    actorUserId: actor.userId,
    action: "merchant.invite_resent",
    resourceType: "merchant",
    resourceId: merchant._id.toString(),
    metadata: {
      ownerEmail: owner.email,
      emailSent: inviteDelivery.emailSent,
      emailQueued: inviteDelivery.emailQueued,
    },
  });

  return {
    inviteToken: token,
    emailSent: inviteDelivery.emailSent,
    emailQueued: inviteDelivery.emailQueued,
    ownerEmail: owner.email,
  };
}

export async function getInvitation(
  token: string,
): Promise<InvitationInfo | null> {
  const user = await User.findOne({
    inviteTokenHash: hashApiKey(token),
    status: "invited",
  }).lean();
  if (
    !user ||
    !user.inviteTokenExpiresAt ||
    user.inviteTokenExpiresAt.getTime() < Date.now()
  ) {
    return null;
  }
  const membership = await MerchantMembership.findOne({
    userId: user._id,
  }).lean();
  const merchant = membership
    ? await Merchant.findById(membership.merchantId).lean()
    : null;
  return {
    email: user.email,
    name: user.name,
    merchantName: merchant?.name ?? "",
  };
}

export async function acceptInvitation(
  token: string,
  password: string,
): Promise<UserSummary | null> {
  const user = await User.findOne({
    inviteTokenHash: hashApiKey(token),
    status: "invited",
  });
  if (
    !user ||
    !user.inviteTokenExpiresAt ||
    user.inviteTokenExpiresAt.getTime() < Date.now()
  ) {
    return null;
  }
  user.passwordHash = await hashPassword(password);
  user.status = "active";
  user.inviteTokenHash = null;
  user.inviteTokenExpiresAt = null;
  user.sessionVersion += 1;
  await user.save();
  return mapUser(user);
}

export async function getMerchantById(
  merchantId: string,
): Promise<MerchantSummary | null> {
  const merchant = await Merchant.findById(merchantId).lean();
  if (!merchant) {
    return null;
  }
  return {
    id: merchant._id.toString(),
    name: merchant.name,
    slug: merchant.slug,
    role: "member",
    createdAt: toIso(merchant.createdAt),
  };
}

export async function updateMerchant(
  actor: RequestActor,
  merchantId: string,
  input: { name?: string },
): Promise<MerchantSummary | null> {
  const merchant = await Merchant.findByIdAndUpdate(
    merchantId,
    { name: input.name },
    { new: true },
  ).lean();
  if (!merchant) {
    return null;
  }

  await writeAuditLog({
    merchantId,
    actorUserId: actor.userId,
    action: "merchant.updated",
    resourceType: "merchant",
    resourceId: merchantId,
    metadata: input,
  });

  return {
    id: merchant._id.toString(),
    name: merchant.name,
    slug: merchant.slug,
    role: "member",
    createdAt: toIso(merchant.createdAt),
  };
}

/** Lists one merchant's sites with batched product, token, spend, and activity summaries. */
export async function listSites(merchantId: string): Promise<SiteSummary[]> {
  return listSiteSummaries({ merchantId: new Types.ObjectId(merchantId) });
}

/** Lists every site for platform-wide administration. */
export async function listAllSites(): Promise<SiteSummary[]> {
  return listSiteSummaries({});
}

export async function createSite(
  actor: RequestActor,
  merchantId: string,
  input: { name: string; primaryDomain?: string },
): Promise<SiteSummary> {
  const merchantObjectId = new Types.ObjectId(merchantId);
  const site = await Site.create({
    merchantId: merchantObjectId,
    name: input.name,
    slug: await generateUniqueSiteSlug(merchantObjectId, input.name),
    primaryDomain: normalizeDomain(input.primaryDomain ?? ""),
  });

  await writeAuditLog({
    merchantId,
    actorUserId: actor.userId,
    action: "site.created",
    resourceType: "site",
    resourceId: site._id.toString(),
    metadata: {
      name: site.name,
      slug: site.slug,
      primaryDomain: site.primaryDomain,
    },
  });

  return mapSite(site);
}

export async function getSiteById(siteId: string): Promise<SiteSummary | null> {
  const site = await Site.findById(siteId).lean();
  return site ? mapSite(site) : null;
}

export async function updateSite(
  actor: RequestActor,
  siteId: string,
  input: { name?: string; primaryDomain?: string },
): Promise<SiteSummary | null> {
  const update: Record<string, unknown> = {};
  if (input.name !== undefined) {
    update.name = input.name;
  }
  if (input.primaryDomain !== undefined) {
    const nextDomain = normalizeDomain(input.primaryDomain);
    const current = await Site.findById(siteId).select("primaryDomain").lean();
    update.primaryDomain = nextDomain;
    if (current && normalizeDomain(current.primaryDomain ?? "") !== nextDomain) {
      update.domainVerifiedAt = null;
    }
  }
  const site = await Site.findByIdAndUpdate(siteId, update, {
    new: true,
  }).lean();
  if (!site) {
    return null;
  }

  await writeAuditLog({
    merchantId: site.merchantId.toString(),
    actorUserId: actor.userId,
    action: "site.updated",
    resourceType: "site",
    resourceId: site._id.toString(),
    metadata: input,
  });

  return mapSite(site);
}

export async function listAuditLogs(
  merchantId: string,
  page: number,
  pageSize: number,
): Promise<PaginatedResponse<AuditLogSummary>> {
  const {
    offset,
    limit,
    page: safePage,
    pageSize: safePageSize,
  } = getPagination(page, pageSize);
  const filter = { merchantId: new Types.ObjectId(merchantId) };

  const [rows, total] = await Promise.all([
    AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(limit)
      .lean(),
    AuditLog.countDocuments(filter),
  ]);

  return {
    items: rows.map((row) => ({
      id: row._id.toString(),
      merchantId: row.merchantId?.toString() ?? null,
      actorUserId: row.actorUserId?.toString() ?? null,
      action: row.action,
      resourceType: row.resourceType,
      resourceId: row.resourceId ?? null,
      metadata: (row.metadata as Record<string, unknown> | undefined) ?? null,
      createdAt: toIso(row.createdAt),
    })),
    page: safePage,
    pageSize: safePageSize,
    total,
  };
}

export async function writeAuditLog(input: {
  merchantId: string | null;
  actorUserId: string | null;
  action: string;
  resourceType: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  actorRole?: string | null;
  actorIp?: string | null;
}): Promise<void> {
  const { writeAuditLogSafe } = await import("@/lib/audit/writeAuditLog");
  await writeAuditLogSafe(input);
}

async function listSiteSummaries(filter: {
  merchantId?: Types.ObjectId;
}): Promise<SiteSummary[]> {
  const sites = await Site.find(filter).sort({ createdAt: -1 }).lean();
  if (sites.length === 0) {
    return [];
  }

  const siteIds = sites.map((site) => site._id);
  const merchantIds = [
    ...new Set(sites.map((site) => site.merchantId.toString())),
  ].map((merchantId) => new Types.ObjectId(merchantId));
  const [merchants, subscriptions, tokens, usage] = await Promise.all([
    Merchant.find({ _id: { $in: merchantIds } })
      .select("_id name")
      .lean(),
    Subscription.find({ siteId: { $in: siteIds }, planCode: { $ne: null } })
      .select("siteId productSlug planCode status")
      .lean(),
    ProductAccessToken.find({ siteId: { $in: siteIds }, revokedAt: null })
      .select("siteId")
      .lean(),
    ProductUsage.find({ siteId: { $in: siteIds } })
      .select("siteId lastEventAt")
      .sort({ lastEventAt: -1 })
      .lean(),
  ]);

  const products = await Product.find({
    slug: {
      $in: subscriptions.map((subscription) => subscription.productSlug),
    },
  })
    .select("slug plans")
    .lean();
  const merchantNameById = new Map(
    merchants.map((merchant) => [merchant._id.toString(), merchant.name]),
  );
  const pricesByProduct = new Map(
    products.map((product) => [
      product.slug,
      new Map(
        product.plans.map((plan) => [
          plan.code,
          { price: plan.priceMonthly, currency: plan.currency },
        ]),
      ),
    ]),
  );
  const rollupBySiteId = new Map<
    string,
    {
      activeProducts: number;
      suspendedProducts: number;
      activeTokens: number;
      monthlySpend: number;
      currency: string | null;
      lastActivityAt: Date | null;
    }
  >();

  for (const site of sites) {
    rollupBySiteId.set(site._id.toString(), {
      activeProducts: 0,
      suspendedProducts: 0,
      activeTokens: 0,
      monthlySpend: 0,
      currency: null,
      lastActivityAt: null,
    });
  }
  for (const subscription of subscriptions) {
    const rollup = rollupBySiteId.get(subscription.siteId.toString());
    if (!rollup) {
      continue;
    }
    if (subscription.status === "active" && subscription.planCode) {
      rollup.activeProducts += 1;
      const plan = subscription.planCode
        ? pricesByProduct
            .get(subscription.productSlug)
            ?.get(subscription.planCode)
        : undefined;
      if (plan) {
        rollup.monthlySpend += plan.price;
        rollup.currency ??= plan.currency;
      }
    } else if (subscription.status === "suspended") {
      rollup.suspendedProducts += 1;
    }
  }
  for (const token of tokens) {
    const rollup = rollupBySiteId.get(token.siteId.toString());
    if (rollup) {
      rollup.activeTokens += 1;
    }
  }
  for (const usageEntry of usage) {
    const rollup = rollupBySiteId.get(usageEntry.siteId.toString());
    if (rollup && usageEntry.lastEventAt && !rollup.lastActivityAt) {
      rollup.lastActivityAt = usageEntry.lastEventAt;
    }
  }

  return sites.map((site) => {
    const summary = mapSite(site);
    const rollup = rollupBySiteId.get(site._id.toString());
    return {
      ...summary,
      merchantName: merchantNameById.get(site.merchantId.toString()),
      activeProducts: rollup?.activeProducts ?? 0,
      suspendedProducts: rollup?.suspendedProducts ?? 0,
      activeTokens: rollup?.activeTokens ?? 0,
      monthlySpend: rollup?.monthlySpend ?? 0,
      currency: rollup?.currency ?? null,
      lastActivityAt: rollup?.lastActivityAt
        ? toIso(rollup.lastActivityAt)
        : null,
    };
  });
}

function normalizeDomain(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  try {
    return new URL(
      normalized.includes("://") ? normalized : `https://${normalized}`,
    ).hostname;
  } catch {
    return normalized.replace(/^https?:\/\//, "").split("/")[0];
  }
}
