import {
  clearSessionCookie,
  getRequestAuth,
  requireMerchantRole,
  setSessionCookie,
  type RequestAuth,
} from "@/lib/api/auth";
import {
  assertMutationHeaders,
  isValidInternalAuthorization,
} from "@/lib/api/guards";
import { checkRateLimit, getClientIp } from "@/lib/api/rateLimit";
import {
  attachActorContext,
} from "@/lib/api/cronHandler";
import {
  jsonCreated,
  jsonError,
  jsonForbidden,
  jsonOk,
  jsonServiceUnavailable,
  jsonTooManyRequests,
  jsonUnauthorized,
  parseJsonBody,
} from "@/lib/api/responses";
import { ensurePlatformReady } from "@/lib/db/ready";
import { getPlatformHealthReport } from "@/lib/services/health.service";
import { logger } from "@/lib/logging/logger";
import {
  resolveRequestId,
  runWithRequestContext,
} from "@/lib/logging/requestContext";
import {
  acceptInvitationBodySchema,
  changePasswordBodySchema,
  createMerchantBodySchema,
  createProductBodySchema,
  createProductTokenBodySchema,
  createSiteBodySchema,
  exchangeSsoBodySchema,
  idParamSchema,
  loadEnvironment,
  loginBodySchema,
  logoutSessionBodySchema,
  merchantIdParamSchema,
  paginationQuerySchema,
  productSlugParamSchema,
  recordProductUsageBodySchema,
  runProductTestBodySchema,
  siteIdParamSchema,
  updateMerchantBodySchema,
  updateProductBodySchema,
  updateProductConfigBodySchema,
  updateProductDefaultsBodySchema,
  updateProfileBodySchema,
  updateSiteBodySchema,
  updateSubscriptionBodySchema,
  verifyPlatformSessionBodySchema,
  verifyProductTokenBodySchema,
  rotateProductTokenBodySchema,
  inviteMerchantMemberBodySchema,
  updateMerchantMemberBodySchema,
} from "@/lib/env";
import {
  acceptInvitation,
  authenticateUser,
  changeUserPassword,
  createMerchant,
  createSite,
  getInvitation,
  getMerchantById,
  getSiteById,
  listAllMerchants,
  listAllSites,
  listAuditLogs,
  listMerchantsForUser,
  listSites,
  resendMerchantInvitation,
  updateMerchant,
  updateSite,
  updateUserProfile,
  invalidateAllUserSessions,
} from "@/lib/services/platform.service";
import type { MerchantMemberRole, SiteSummary } from "@/lib/types";
import {
  createProductToken,
  getProduct,
  getProductUsage,
  getSiteProductConversation,
  listProducts,
  listProductSubscribers,
  listProductTokens,
  listSiteProductConversations,
  testProductConnection,
  listSiteProducts,
  recordProductUsage,
  buildProductPreview,
  registerProduct,
  replyToSiteProductConversation,
  revokeProductToken,
  rotateProductToken,
  runSiteProductTest,
  setSiteProductPlan,
  updateProduct,
  verifyProductToken,
  ProductCatalogConflictError,
  ProductBaseUrlError,
} from "@/lib/services/product.service";
import { SubscriptionLifecycleError } from "@/lib/services/subscriptionLifecycle.service";
import { reconcileSubscriptions } from "@/lib/services/subscriptionReconciliation.service";
import { resolveTenantBinding, TenantBindingError } from "@/lib/services/tenantBinding.service";
import {
  getProductConfig,
  getProductDefaults,
  ProductConfigError,
  publishProductConfig,
  publishProductDefaults,
  resolveDraftConfigForPreview,
  saveProductConfigDraft,
  saveProductDefaultsDraft,
  verifyPreviewToken,
} from "@/lib/services/productConfig.service";
import { ProductBridgeError } from "@/lib/services/productBridge";
import {
  DashboardSsoError,
  exchangeDashboardSsoCode,
  listProductSitesForSwitcher,
  mintDashboardSession,
  verifyPlatformAdminSession,
} from "@/lib/services/dashboardSso.service";
import {
  getMerchantBilling,
  getMerchantDetailForAdmin,
  getMerchantOffboarding,
  getSiteDomainReadiness,
  inviteMerchantMember,
  listMerchantMembers,
  listSubscriptionHistory,
  removeMerchantMember,
  requestMerchantExport,
  restoreMerchant,
  scheduleMerchantDeletion,
  sendOwnerRecovery,
  startMerchantOffboarding,
  syncSiteTokenDomains,
  updateMerchantMemberRole,
  verifySiteDomain,
} from "@/lib/services/merchantWorkflow.service";

const MUTATION_METHODS = new Set(["POST", "PATCH", "DELETE"]);

function applyBrowserMutationGuards(
  request: Request,
  path: string,
): Response | null {
  if (!MUTATION_METHODS.has(request.method)) {
    return null;
  }
  if (path.startsWith("internal/")) {
    return null;
  }
  return assertMutationHeaders(request);
}

async function applyAuthenticatedRateLimit(
  request: Request,
  actorUserId?: string,
): Promise<Response | null> {
  const ip = getClientIp(request);
  const key = actorUserId ? `api:user:${actorUserId}` : `api:ip:${ip}`;
  const result = await checkRateLimit(key, 300, 60_000);
  if (result.unavailable) {
    return jsonServiceUnavailable();
  }
  if (!result.allowed) {
    return jsonTooManyRequests(result.retryAfterSeconds ?? 60);
  }
  return null;
}

async function enforceSensitiveRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<Response | null> {
  const result = await checkRateLimit(key, limit, windowMs);
  if (result.unavailable) {
    return jsonServiceUnavailable();
  }
  if (!result.allowed) {
    return jsonTooManyRequests(result.retryAfterSeconds ?? 60);
  }
  return null;
}

async function requireAuthenticated(request: Request) {
  const auth = await getRequestAuth();
  if (!auth) {
    return jsonUnauthorized();
  }
  attachActorContext({
    userId: auth.actor.userId,
    isPlatformAdmin: auth.actor.isPlatformAdmin,
    merchantRole: auth.merchantRole,
    clientIp: getClientIp(request),
  });
  const rateLimit = await applyAuthenticatedRateLimit(request, auth.actor.userId);
  if (rateLimit) {
    return rateLimit;
  }
  return auth;
}

/** Resolves a site and checks the caller has one of the roles on its merchant. */
async function resolveSite(
  auth: RequestAuth,
  siteId: string,
  roles: MerchantMemberRole[],
): Promise<{ site: SiteSummary } | Response> {
  const site = await getSiteById(siteId);
  if (!site) {
    return jsonError("Not found", 404);
  }
  const roleCheck = await requireMerchantRole(auth, site.merchantId, roles);
  if (roleCheck instanceof Response) {
    return roleCheck;
  }
  return { site };
}

export async function handleApiRequest(
  request: Request,
  pathSegments: string[],
): Promise<Response> {
  const requestId = resolveRequestId(request.headers.get("x-request-id"));
  return runWithRequestContext(
    {
      requestId,
      method: request.method,
      path: pathSegments.join("/"),
      clientIp: getClientIp(request),
    },
    async () => handleApiRequestInner(request, pathSegments, requestId),
  );
}

async function handleApiRequestInner(
  request: Request,
  pathSegments: string[],
  requestId: string,
): Promise<Response> {
  try {
    await ensurePlatformReady();
  } catch (error) {
    logger.error("Platform readiness failed", {
      error: error instanceof Error ? error.message : "unknown",
    });
    return jsonServiceUnavailable(undefined, { requestId });
  }

  const method = request.method;
  const path = pathSegments.join("/");
  const url = new URL(request.url);

  const mutationGuard = applyBrowserMutationGuards(request, path);
  if (mutationGuard) {
    return mutationGuard;
  }

  if (method === "GET" && path === "health") {
    const report = await getPlatformHealthReport();
    const status = report.status === "healthy" ? 200 : 503;
    return jsonOk(report, status, {
      cache: "public",
      varyCookie: false,
      requestId,
    });
  }

  if (method === "POST" && path === "auth/sessions") {
    const ip = getClientIp(request);
    const ipLimitResponse = await enforceSensitiveRateLimit(`login:ip:${ip}`, 10, 15 * 60_000);
    if (ipLimitResponse) {
      return ipLimitResponse;
    }

    const body = await parseJsonBody<unknown>(request);
    if (body instanceof Response) {
      return body;
    }
    const parsed = loginBodySchema.safeParse(body);
    if (!parsed.success) {
      return jsonUnauthorized();
    }

    const emailLimitResponse = await enforceSensitiveRateLimit(
      `login:email:${parsed.data.email.toLowerCase()}`,
      10,
      15 * 60_000,
    );
    if (emailLimitResponse) {
      return emailLimitResponse;
    }

    const user = await authenticateUser(
      parsed.data.email,
      parsed.data.password,
    );
    if (!user) {
      return jsonUnauthorized();
    }
    await setSessionCookie(user);
    return jsonOk({ user });
  }

  if (
    method === "GET" &&
    pathSegments[0] === "auth" &&
    pathSegments[1] === "invitations" &&
    pathSegments.length === 3
  ) {
    const ip = getClientIp(request);
    const limitResponse = await enforceSensitiveRateLimit(`invite-lookup:ip:${ip}`, 30, 15 * 60_000);
    if (limitResponse) {
      return limitResponse;
    }
    const invitation = await getInvitation(pathSegments[2]);
    if (!invitation) {
      return jsonError("This invitation is invalid or has expired.", 404);
    }
    return jsonOk({ invitation });
  }

  if (method === "POST" && path === "auth/invitations/acceptance") {
    const ip = getClientIp(request);
    const limitResponse = await enforceSensitiveRateLimit(`invite-accept:ip:${ip}`, 10, 15 * 60_000);
    if (limitResponse) {
      return limitResponse;
    }
    const body = await parseJsonBody<unknown>(request);
    if (body instanceof Response) {
      return body;
    }
    const parsed = acceptInvitationBodySchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Invalid body", 400);
    }
    const user = await acceptInvitation(
      parsed.data.token,
      parsed.data.password,
    );
    if (!user) {
      return jsonError("This invitation is invalid or has expired.", 400);
    }
    await setSessionCookie(user);
    return jsonOk({ user });
  }

  if (method === "DELETE" && path === "auth/sessions") {
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }
    const body = await parseJsonBody<unknown>(request);
    let scope: "current" | "all" = "current";
    if (!(body instanceof Response)) {
      const parsed = logoutSessionBodySchema.safeParse(body ?? {});
      if (parsed.success) {
        scope = parsed.data.scope;
      }
    }
    if (scope === "all") {
      await invalidateAllUserSessions(auth.actor.userId);
    }
    await clearSessionCookie();
    return jsonOk({ success: true, scope });
  }

  if (method === "GET" && path === "auth/me") {
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }
    return jsonOk({ user: auth.user });
  }

  if (method === "PATCH" && path === "auth/me") {
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }
    const body = await parseJsonBody<unknown>(request);
    if (body instanceof Response) {
      return body;
    }
    const parsed = updateProfileBodySchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Invalid body", 400);
    }
    if (parsed.data.email && !auth.actor.isPlatformAdmin) {
      return jsonForbidden("Only administrators can change their email.");
    }
    try {
      const previousEmail = auth.user.email;
      const user = await updateUserProfile(auth.actor.userId, parsed.data);
      if (!user) {
        return jsonError("Could not update profile", 500);
      }
      if (parsed.data.email && parsed.data.email.toLowerCase() !== previousEmail.toLowerCase()) {
        await clearSessionCookie();
        return jsonOk({
          user,
          sessionInvalidated: true,
          message: "Email updated. Sign in again on all devices.",
        });
      }
      return jsonOk({ user });
    } catch (error) {
      if (error instanceof Error && error.message === "EMAIL_TAKEN") {
        return jsonError("A user with this email already exists.", 409);
      }
      return jsonError("Could not update profile", 500);
    }
  }

  if (method === "POST" && path === "auth/password") {
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }
    const limitResponse = await enforceSensitiveRateLimit(
      `password-change:${auth.actor.userId}`,
      5,
      15 * 60_000,
    );
    if (limitResponse) {
      return limitResponse;
    }
    const body = await parseJsonBody<unknown>(request);
    if (body instanceof Response) {
      return body;
    }
    const parsed = changePasswordBodySchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Invalid body", 400);
    }
    const result = await changeUserPassword(
      auth.actor.userId,
      parsed.data.currentPassword,
      parsed.data.newPassword,
    );
    if (result === "INVALID") {
      return jsonError("Current password is incorrect.", 400);
    }
    await setSessionCookie(result);
    return jsonOk({ user: result });
  }

  if (method === "GET" && path === "products") {
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }
    const items = (await listProducts()).filter(
      (product) => product.status === "active",
    );
    return jsonOk({ items });
  }

  if (path === "admin/products" && (method === "GET" || method === "POST")) {
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }
    if (!auth.actor.isPlatformAdmin) {
      return jsonForbidden();
    }

    if (method === "GET") {
      const items = await listProducts();
      return jsonOk({ items });
    }

    const body = await parseJsonBody<unknown>(request);
    if (body instanceof Response) {
      return body;
    }
    const parsed = createProductBodySchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Invalid body", 400);
    }
    try {
      const product = await registerProduct(auth.actor, parsed.data);
      return jsonCreated({ product });
    } catch (error) {
      if (error instanceof ProductBaseUrlError) {
        return jsonError(error.message, 400);
      }
      return jsonError("Product slug already exists", 409);
    }
  }

  const adminProductMatch = path.match(/^admin\/products\/([^/]+)$/);
  if (adminProductMatch && (method === "GET" || method === "PATCH")) {
    const params = productSlugParamSchema.safeParse({
      productSlug: adminProductMatch[1],
    });
    if (!params.success) {
      return jsonError("Invalid product slug", 400);
    }
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }
    if (!auth.actor.isPlatformAdmin) {
      return jsonForbidden();
    }

    if (method === "GET") {
      const product = await getProduct(params.data.productSlug);
      if (!product) {
        return jsonError("Not found", 404);
      }
      return jsonOk({ product });
    }

    const body = await parseJsonBody<unknown>(request);
    if (body instanceof Response) {
      return body;
    }
    const parsed = updateProductBodySchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Invalid body", 400);
    }
    try {
      const product = await updateProduct(
        auth.actor,
        params.data.productSlug,
        parsed.data,
      );
      if (!product) {
        return jsonError("Not found", 404);
      }
      return jsonOk({ product });
    } catch (error) {
      if (error instanceof ProductCatalogConflictError) {
        return jsonError(error.message, 409);
      }
      if (error instanceof ProductBaseUrlError) {
        return jsonError(error.message, 400);
      }
      return jsonError("Unable to update product", 400);
    }
  }

  const adminProductSubscribersMatch = path.match(
    /^admin\/products\/([^/]+)\/subscribers$/,
  );
  if (adminProductSubscribersMatch && method === "GET") {
    const params = productSlugParamSchema.safeParse({
      productSlug: adminProductSubscribersMatch[1],
    });
    if (!params.success) {
      return jsonError("Invalid product slug", 400);
    }
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }
    if (!auth.actor.isPlatformAdmin) {
      return jsonForbidden();
    }
    const items = await listProductSubscribers(params.data.productSlug);
    if (items === null) {
      return jsonError("Not found", 404);
    }
    return jsonOk({ items });
  }

  const adminProductConnectionMatch = path.match(
    /^admin\/products\/([^/]+)\/connection-test$/,
  );
  if (adminProductConnectionMatch && method === "POST") {
    const params = productSlugParamSchema.safeParse({
      productSlug: adminProductConnectionMatch[1],
    });
    if (!params.success) {
      return jsonError("Invalid product slug", 400);
    }
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }
    if (!auth.actor.isPlatformAdmin) {
      return jsonForbidden();
    }
    const status = await testProductConnection(
      auth.actor,
      params.data.productSlug,
    );
    if (status === null) {
      return jsonError("Not found", 404);
    }
    return jsonOk({ status });
  }

  const adminProductConfigMatch = path.match(
    /^admin\/products\/([^/]+)\/config$/,
  );
  if (adminProductConfigMatch && (method === "GET" || method === "PATCH")) {
    const params = productSlugParamSchema.safeParse({
      productSlug: adminProductConfigMatch[1],
    });
    if (!params.success) {
      return jsonError("Invalid product slug", 400);
    }
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }
    if (!auth.actor.isPlatformAdmin) {
      return jsonForbidden();
    }

    if (method === "GET") {
      try {
        const config = await getProductDefaults(params.data.productSlug);
        return jsonOk({ config });
      } catch (error) {
        if (error instanceof ProductConfigError) {
          return jsonError(error.message, error.status, { cache: "no-store" }, error.code);
        }
        return jsonError("Could not load defaults", 500);
      }
    }

    const body = await parseJsonBody<unknown>(request);
    if (body instanceof Response) {
      return body;
    }
    const parsed = updateProductDefaultsBodySchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Invalid body", 400);
    }
    try {
      const config = await saveProductDefaultsDraft(
        auth.actor,
        params.data.productSlug,
        parsed.data,
      );
      return jsonOk({ config });
    } catch (error) {
      if (error instanceof ProductConfigError) {
        return jsonError(error.message, error.status, { cache: "no-store" }, error.code);
      }
      return jsonError("Could not save defaults", 500);
    }
  }

  const adminDashboardSessionMatch = path.match(
    /^admin\/products\/([^/]+)\/dashboard-session$/,
  );
  if (adminDashboardSessionMatch && method === "POST") {
    const params = productSlugParamSchema.safeParse({
      productSlug: adminDashboardSessionMatch[1],
    });
    if (!params.success) {
      return jsonError("Invalid product slug", 400);
    }
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }
    if (!auth.actor.isPlatformAdmin) {
      return jsonForbidden();
    }
    const body = await parseJsonBody<{ siteId?: unknown }>(request);
    if (body instanceof Response) {
      return body;
    }
    const siteId =
      typeof body.siteId === "string" && body.siteId.length > 0
        ? body.siteId
        : undefined;
    try {
      const session = await mintDashboardSession(
        auth.actor,
        params.data.productSlug,
        siteId,
      );
      return jsonOk(session);
    } catch (error) {
      if (error instanceof DashboardSsoError) {
        return jsonError(error.message, error.status);
      }
      return jsonError("Could not open dashboard", 500);
    }
  }

  const adminProductConfigPublishMatch = path.match(
    /^admin\/products\/([^/]+)\/config\/publish$/,
  );
  if (adminProductConfigPublishMatch && method === "POST") {
    const params = productSlugParamSchema.safeParse({
      productSlug: adminProductConfigPublishMatch[1],
    });
    if (!params.success) {
      return jsonError("Invalid product slug", 400);
    }
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }
    if (!auth.actor.isPlatformAdmin) {
      return jsonForbidden();
    }
    try {
      const config = await publishProductDefaults(
        auth.actor,
        params.data.productSlug,
      );
      return jsonOk({ config });
    } catch (error) {
      if (error instanceof ProductConfigError) {
        return jsonError(error.message, error.status, { cache: "no-store" }, error.code);
      }
      return jsonError("Could not publish defaults", 500);
    }
  }

  if (path === "admin/merchants" && (method === "GET" || method === "POST")) {
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }
    if (!auth.actor.isPlatformAdmin) {
      return jsonForbidden();
    }

    if (method === "GET") {
      const items = await listAllMerchants();
      return jsonOk({ items });
    }

    const body = await parseJsonBody<unknown>(request);
    if (body instanceof Response) {
      return body;
    }
    const parsed = createMerchantBodySchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Invalid body", 400);
    }
    try {
      const result = await createMerchant(auth.actor, parsed.data);
      return jsonCreated(result);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "";
      if (reason === "EMAIL_TAKEN") {
        return jsonError("A user with this email already exists", 409);
      }
      return jsonError("Could not create merchant", 500);
    }
  }

  if (path === "admin/sites" && method === "GET") {
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }
    if (!auth.actor.isPlatformAdmin) {
      return jsonForbidden();
    }
    const items = await listAllSites();
    return jsonOk({ items });
  }

  const resendInviteMatch = path.match(
    /^admin\/merchants\/([^/]+)\/invitation$/,
  );
  if (resendInviteMatch && method === "POST") {
    const params = merchantIdParamSchema.safeParse({
      merchantId: resendInviteMatch[1],
    });
    if (!params.success) {
      return jsonError("Invalid merchant id", 400);
    }
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }
    if (!auth.actor.isPlatformAdmin) {
      return jsonForbidden();
    }
    const result = await resendMerchantInvitation(
      auth.actor,
      params.data.merchantId,
    );
    if (result === "NOT_FOUND") {
      return jsonError("Not found", 404);
    }
    if (result === "ALREADY_ACTIVE") {
      return jsonError(
        "This merchant has already accepted their invitation",
        409,
      );
    }
    return jsonOk(result);
  }

  if (method === "GET" && path === "merchants") {
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }
    const items = await listMerchantsForUser(auth.actor.userId);
    return jsonOk({ items });
  }

  const merchantMatch = path.match(/^merchants\/([^/]+)$/);
  if (merchantMatch) {
    const params = merchantIdParamSchema.safeParse({
      merchantId: merchantMatch[1],
    });
    if (!params.success) {
      return jsonError("Invalid merchant id", 400);
    }
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }

    if (method === "GET") {
      const roleCheck = await requireMerchantRole(
        auth,
        params.data.merchantId,
        ["owner", "admin", "member"],
      );
      if (roleCheck instanceof Response) {
        return roleCheck;
      }
      const merchant = auth.actor.isPlatformAdmin
        ? await getMerchantDetailForAdmin(params.data.merchantId)
        : await getMerchantById(params.data.merchantId);
      if (!merchant) {
        return jsonError("Not found", 404);
      }
      return jsonOk({
        merchant: {
          ...merchant,
          role: roleCheck.merchantRole ?? merchant.role,
        },
      });
    }

    if (method === "PATCH") {
      if (!auth.actor.isPlatformAdmin) {
        return jsonForbidden();
      }
      const body = await parseJsonBody<unknown>(request);
      if (body instanceof Response) {
        return body;
      }
      const parsed = updateMerchantBodySchema.safeParse(body);
      if (!parsed.success) {
        return jsonError(
          parsed.error.issues[0]?.message ?? "Invalid body",
          400,
        );
      }
      const merchant = await updateMerchant(
        auth.actor,
        params.data.merchantId,
        parsed.data,
      );
      if (!merchant) {
        return jsonError("Not found", 404);
      }
      return jsonOk({ merchant });
    }
  }

  const merchantSitesMatch = path.match(/^merchants\/([^/]+)\/sites$/);
  if (merchantSitesMatch) {
    const params = merchantIdParamSchema.safeParse({
      merchantId: merchantSitesMatch[1],
    });
    if (!params.success) {
      return jsonError("Invalid merchant id", 400);
    }
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }

    if (method === "GET") {
      const roleCheck = await requireMerchantRole(
        auth,
        params.data.merchantId,
        ["owner", "admin", "member"],
      );
      if (roleCheck instanceof Response) {
        return roleCheck;
      }
      const items = await listSites(params.data.merchantId);
      return jsonOk({ items });
    }

    if (method === "POST") {
      // Site creation is platform-admin only: admins provision a merchant's sites.
      if (!auth.actor.isPlatformAdmin) {
        return jsonForbidden();
      }
      const body = await parseJsonBody<unknown>(request);
      if (body instanceof Response) {
        return body;
      }
      const parsed = createSiteBodySchema.safeParse(body);
      if (!parsed.success) {
        return jsonError(
          parsed.error.issues[0]?.message ?? "Invalid body",
          400,
        );
      }
      const site = await createSite(
        auth.actor,
        params.data.merchantId,
        parsed.data,
      );
      return jsonCreated({ site });
    }
  }

  const merchantAuditMatch = path.match(/^merchants\/([^/]+)\/audit-logs$/);
  if (merchantAuditMatch && method === "GET") {
    const params = merchantIdParamSchema.safeParse({
      merchantId: merchantAuditMatch[1],
    });
    if (!params.success) {
      return jsonError("Invalid merchant id", 400);
    }
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }
    const roleCheck = await requireMerchantRole(auth, params.data.merchantId, [
      "owner",
      "admin",
    ]);
    if (roleCheck instanceof Response) {
      return roleCheck;
    }
    const query = paginationQuerySchema.safeParse({
      page: url.searchParams.get("page") ?? undefined,
      pageSize: url.searchParams.get("pageSize") ?? undefined,
    });
    if (!query.success) {
      return jsonError("Invalid pagination", 400);
    }
    const result = await listAuditLogs(
      params.data.merchantId,
      query.data.page,
      query.data.pageSize,
    );
    return jsonOk(result);
  }

  const merchantBillingMatch = path.match(/^merchants\/([^/]+)\/billing$/);
  if (merchantBillingMatch && method === "GET") {
    const params = merchantIdParamSchema.safeParse({
      merchantId: merchantBillingMatch[1],
    });
    if (!params.success) {
      return jsonError("Invalid merchant id", 400);
    }
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }
    if (!auth.actor.isPlatformAdmin) {
      return jsonForbidden();
    }
    const billing = await getMerchantBilling(params.data.merchantId);
    if (!billing) {
      return jsonError("Not found", 404);
    }
    return jsonOk({ billing });
  }

  const merchantMembersMatch = path.match(/^merchants\/([^/]+)\/members$/);
  if (merchantMembersMatch && (method === "GET" || method === "POST")) {
    const params = merchantIdParamSchema.safeParse({
      merchantId: merchantMembersMatch[1],
    });
    if (!params.success) {
      return jsonError("Invalid merchant id", 400);
    }
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }
    if (!auth.actor.isPlatformAdmin) {
      return jsonForbidden();
    }
    if (method === "GET") {
      const items = await listMerchantMembers(params.data.merchantId);
      return jsonOk({ items });
    }
    const body = await parseJsonBody<unknown>(request);
    if (body instanceof Response) {
      return body;
    }
    const parsed = inviteMerchantMemberBodySchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Invalid body", 400);
    }
    const member = await inviteMerchantMember(
      auth.actor,
      params.data.merchantId,
      parsed.data,
    );
    if (member === "NOT_FOUND") {
      return jsonError("Not found", 404);
    }
    if (member === "EMAIL_TAKEN") {
      return jsonError("This email is already on the team", 409);
    }
    return jsonCreated({ member });
  }

  const merchantMemberMatch = path.match(
    /^merchants\/([^/]+)\/members\/([^/]+)$/,
  );
  if (merchantMemberMatch && (method === "PATCH" || method === "DELETE")) {
    const params = merchantIdParamSchema.safeParse({
      merchantId: merchantMemberMatch[1],
    });
    const userParams = idParamSchema.safeParse({ id: merchantMemberMatch[2] });
    if (!params.success || !userParams.success) {
      return jsonError("Invalid id", 400);
    }
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }
    if (!auth.actor.isPlatformAdmin) {
      return jsonForbidden();
    }
    if (method === "DELETE") {
      const result = await removeMerchantMember(
        auth.actor,
        params.data.merchantId,
        userParams.data.id,
      );
      if (result === "NOT_FOUND") {
        return jsonError("Not found", 404);
      }
      if (result === "OWNER_PROTECTED") {
        return jsonError("The owner cannot be removed", 409);
      }
      return jsonOk({ success: true });
    }
    const body = await parseJsonBody<unknown>(request);
    if (body instanceof Response) {
      return body;
    }
    const parsed = updateMerchantMemberBodySchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Invalid body", 400);
    }
    const member = await updateMerchantMemberRole(
      auth.actor,
      params.data.merchantId,
      userParams.data.id,
      parsed.data.role,
    );
    if (member === "NOT_FOUND") {
      return jsonError("Not found", 404);
    }
    if (member === "OWNER_PROTECTED") {
      return jsonError("The owner role cannot be changed here", 409);
    }
    return jsonOk({ member });
  }

  const ownerRecoveryMatch = path.match(
    /^merchants\/([^/]+)\/owner-recoveries$/,
  );
  if (ownerRecoveryMatch && method === "POST") {
    const params = merchantIdParamSchema.safeParse({
      merchantId: ownerRecoveryMatch[1],
    });
    if (!params.success) {
      return jsonError("Invalid merchant id", 400);
    }
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }
    if (!auth.actor.isPlatformAdmin) {
      return jsonForbidden();
    }
    const result = await sendOwnerRecovery(auth.actor, params.data.merchantId);
    if (result === "NOT_FOUND") {
      return jsonError("Not found", 404);
    }
    if (result === "NOT_ACTIVE") {
      return jsonError("Owner has not accepted their invitation yet", 409);
    }
    return jsonOk(result);
  }

  const subscriptionHistoryMatch = path.match(
    /^merchants\/([^/]+)\/subscription-histories$/,
  );
  if (subscriptionHistoryMatch && method === "GET") {
    const params = merchantIdParamSchema.safeParse({
      merchantId: subscriptionHistoryMatch[1],
    });
    if (!params.success) {
      return jsonError("Invalid merchant id", 400);
    }
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }
    if (!auth.actor.isPlatformAdmin) {
      return jsonForbidden();
    }
    const query = paginationQuerySchema.safeParse({
      page: url.searchParams.get("page") ?? undefined,
      pageSize: url.searchParams.get("pageSize") ?? undefined,
    });
    if (!query.success) {
      return jsonError("Invalid pagination", 400);
    }
    const result = await listSubscriptionHistory(
      params.data.merchantId,
      query.data.page,
      query.data.pageSize,
    );
    return jsonOk(result);
  }

  const merchantOffboardingMatch = path.match(/^merchants\/([^/]+)\/offboarding$/);
  if (merchantOffboardingMatch && (method === "GET" || method === "POST")) {
    const params = merchantIdParamSchema.safeParse({
      merchantId: merchantOffboardingMatch[1],
    });
    if (!params.success) {
      return jsonError("Invalid merchant id", 400);
    }
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }
    if (!auth.actor.isPlatformAdmin) {
      return jsonForbidden();
    }
    if (method === "GET") {
      const summary = await getMerchantOffboarding(params.data.merchantId);
      if (!summary) {
        return jsonError("Not found", 404);
      }
      return jsonOk({ offboarding: summary });
    }
    const summary = await startMerchantOffboarding(
      auth.actor,
      params.data.merchantId,
    );
    if (summary === "NOT_FOUND") {
      return jsonError("Not found", 404);
    }
    if (summary === "ALREADY_OFFBOARDING") {
      return jsonError("Merchant is already offboarding", 409);
    }
    return jsonOk({ offboarding: summary });
  }

  const offboardingRestoreMatch = path.match(
    /^merchants\/([^/]+)\/offboarding\/restorations$/,
  );
  if (offboardingRestoreMatch && method === "POST") {
    const params = merchantIdParamSchema.safeParse({
      merchantId: offboardingRestoreMatch[1],
    });
    if (!params.success) {
      return jsonError("Invalid merchant id", 400);
    }
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }
    if (!auth.actor.isPlatformAdmin) {
      return jsonForbidden();
    }
    const summary = await restoreMerchant(auth.actor, params.data.merchantId);
    if (summary === "NOT_FOUND") {
      return jsonError("Not found", 404);
    }
    if (summary === "NOT_ELIGIBLE") {
      return jsonError("Restore window has expired", 409);
    }
    return jsonOk({ offboarding: summary });
  }

  const offboardingExportMatch = path.match(
    /^merchants\/([^/]+)\/offboarding\/exports$/,
  );
  if (offboardingExportMatch && method === "POST") {
    const params = merchantIdParamSchema.safeParse({
      merchantId: offboardingExportMatch[1],
    });
    if (!params.success) {
      return jsonError("Invalid merchant id", 400);
    }
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }
    if (!auth.actor.isPlatformAdmin) {
      return jsonForbidden();
    }
    const summary = await requestMerchantExport(
      auth.actor,
      params.data.merchantId,
    );
    if (summary === "NOT_FOUND") {
      return jsonError("Not found", 404);
    }
    return jsonOk({ offboarding: summary });
  }

  const offboardingDeletionMatch = path.match(
    /^merchants\/([^/]+)\/offboarding\/deletions$/,
  );
  if (offboardingDeletionMatch && method === "POST") {
    const params = merchantIdParamSchema.safeParse({
      merchantId: offboardingDeletionMatch[1],
    });
    if (!params.success) {
      return jsonError("Invalid merchant id", 400);
    }
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }
    if (!auth.actor.isPlatformAdmin) {
      return jsonForbidden();
    }
    const summary = await scheduleMerchantDeletion(
      auth.actor,
      params.data.merchantId,
    );
    if (summary === "NOT_FOUND") {
      return jsonError("Not found", 404);
    }
    if (summary === "NOT_ELIGIBLE") {
      return jsonError("Deletion is not eligible yet", 409);
    }
    return jsonOk({ offboarding: summary });
  }

  const siteMatch = path.match(/^sites\/([^/]+)$/);
  if (siteMatch) {
    const params = siteIdParamSchema.safeParse({ siteId: siteMatch[1] });
    if (!params.success) {
      return jsonError("Invalid site id", 400);
    }
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }

    if (method === "GET") {
      const resolved = await resolveSite(auth, params.data.siteId, [
        "owner",
        "admin",
        "member",
      ]);
      if (resolved instanceof Response) {
        return resolved;
      }
      return jsonOk({ site: resolved.site });
    }

    if (method === "PATCH") {
      if (!auth.actor.isPlatformAdmin) {
        return jsonForbidden();
      }
      const resolved = await resolveSite(auth, params.data.siteId, [
        "owner",
        "admin",
        "member",
      ]);
      if (resolved instanceof Response) {
        return resolved;
      }
      const body = await parseJsonBody<unknown>(request);
      if (body instanceof Response) {
        return body;
      }
      const parsed = updateSiteBodySchema.safeParse(body);
      if (!parsed.success) {
        return jsonError(
          parsed.error.issues[0]?.message ?? "Invalid body",
          400,
        );
      }
      const updated = await updateSite(
        auth.actor,
        params.data.siteId,
        parsed.data,
      );
      if (!updated) {
        return jsonError("Not found", 404);
      }
      return jsonOk({ site: updated });
    }
  }

  const siteDomainReadinessMatch = path.match(
    /^sites\/([^/]+)\/domain-readiness$/,
  );
  if (siteDomainReadinessMatch && method === "GET") {
    const params = siteIdParamSchema.safeParse({
      siteId: siteDomainReadinessMatch[1],
    });
    if (!params.success) {
      return jsonError("Invalid site id", 400);
    }
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }
    const resolved = await resolveSite(auth, params.data.siteId, [
      "owner",
      "admin",
      "member",
    ]);
    if (resolved instanceof Response) {
      return resolved;
    }
    const readiness = await getSiteDomainReadiness(params.data.siteId);
    if (!readiness) {
      return jsonError("Not found", 404);
    }
    return jsonOk({ readiness });
  }

  const siteDomainVerificationMatch = path.match(
    /^sites\/([^/]+)\/domain-verifications$/,
  );
  if (siteDomainVerificationMatch && method === "POST") {
    const params = siteIdParamSchema.safeParse({
      siteId: siteDomainVerificationMatch[1],
    });
    if (!params.success) {
      return jsonError("Invalid site id", 400);
    }
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }
    if (!auth.actor.isPlatformAdmin) {
      return jsonForbidden();
    }
    const resolved = await resolveSite(auth, params.data.siteId, [
      "owner",
      "admin",
      "member",
    ]);
    if (resolved instanceof Response) {
      return resolved;
    }
    const result = await verifySiteDomain(auth.actor, params.data.siteId);
    if (result === "NOT_FOUND") {
      return jsonError("Not found", 404);
    }
    if (result === "NO_DOMAIN") {
      return jsonError("Configure a primary domain first", 409);
    }
    return jsonOk(result);
  }

  const siteTokenDomainSyncMatch = path.match(
    /^sites\/([^/]+)\/token-domain-syncs$/,
  );
  if (siteTokenDomainSyncMatch && method === "POST") {
    const params = siteIdParamSchema.safeParse({
      siteId: siteTokenDomainSyncMatch[1],
    });
    if (!params.success) {
      return jsonError("Invalid site id", 400);
    }
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }
    if (!auth.actor.isPlatformAdmin) {
      return jsonForbidden();
    }
    const resolved = await resolveSite(auth, params.data.siteId, [
      "owner",
      "admin",
      "member",
    ]);
    if (resolved instanceof Response) {
      return resolved;
    }
    const result = await syncSiteTokenDomains(auth.actor, params.data.siteId);
    if (result === "NOT_FOUND") {
      return jsonError("Not found", 404);
    }
    if (result === "NO_DOMAIN") {
      return jsonError("Configure a primary domain first", 409);
    }
    return jsonOk(result);
  }

  const siteProductsMatch = path.match(/^sites\/([^/]+)\/products$/);
  if (siteProductsMatch && method === "GET") {
    const params = siteIdParamSchema.safeParse({
      siteId: siteProductsMatch[1],
    });
    if (!params.success) {
      return jsonError("Invalid site id", 400);
    }
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }
    const resolved = await resolveSite(auth, params.data.siteId, [
      "owner",
      "admin",
      "member",
    ]);
    if (resolved instanceof Response) {
      return resolved;
    }
    const items = await listSiteProducts(params.data.siteId);
    return jsonOk({ items });
  }

  const productTokenMatch = path.match(
    /^sites\/([^/]+)\/products\/([^/]+)\/tokens$/,
  );
  if (productTokenMatch && (method === "GET" || method === "POST")) {
    const params = siteIdParamSchema.safeParse({
      siteId: productTokenMatch[1],
    });
    const slugParams = productSlugParamSchema.safeParse({
      productSlug: productTokenMatch[2],
    });
    if (!params.success || !slugParams.success) {
      return jsonError("Invalid id", 400);
    }
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }
    const resolved = await resolveSite(auth, params.data.siteId, [
      "owner",
      "admin",
      "member",
    ]);
    if (resolved instanceof Response) {
      return resolved;
    }

    if (method === "GET") {
      const items = await listProductTokens(
        params.data.siteId,
        slugParams.data.productSlug,
      );
      return jsonOk({ items });
    }
    if (!auth.actor.isPlatformAdmin) {
      return jsonForbidden();
    }

    const body = await parseJsonBody<unknown>(request);
    if (body instanceof Response) {
      return body;
    }
    const parsed = createProductTokenBodySchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Invalid body", 400);
    }
    try {
      const token = await createProductToken(
        auth.actor,
        params.data.siteId,
        slugParams.data.productSlug,
        parsed.data.name,
        parsed.data.allowedDomains,
        parsed.data.expiresInDays,
      );
      return jsonCreated({ token });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "";
      if (reason === "PRODUCT_NOT_GRANTED") {
        return jsonError("Assign a plan before issuing tokens", 409);
      }
      return jsonError("Not found", 404);
    }
  }

  const revokeProductTokenMatch = path.match(
    /^sites\/([^/]+)\/products\/([^/]+)\/tokens\/([^/]+)$/,
  );
  if (revokeProductTokenMatch && method === "DELETE") {
    const params = siteIdParamSchema.safeParse({
      siteId: revokeProductTokenMatch[1],
    });
    const slugParams = productSlugParamSchema.safeParse({
      productSlug: revokeProductTokenMatch[2],
    });
    const tokenParams = idParamSchema.safeParse({
      id: revokeProductTokenMatch[3],
    });
    if (!params.success || !slugParams.success || !tokenParams.success) {
      return jsonError("Invalid id", 400);
    }
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }
    if (!auth.actor.isPlatformAdmin) {
      return jsonForbidden();
    }
    const resolved = await resolveSite(auth, params.data.siteId, [
      "owner",
      "admin",
      "member",
    ]);
    if (resolved instanceof Response) {
      return resolved;
    }
    const revoked = await revokeProductToken(
      auth.actor,
      params.data.siteId,
      slugParams.data.productSlug,
      tokenParams.data.id,
    );
    if (!revoked) {
      return jsonError("Not found", 404);
    }
    return jsonOk({ success: true });
  }

  const rotateTokenMatch = path.match(
    /^sites\/([^/]+)\/products\/([^/]+)\/tokens\/([^/]+)\/rotations$/,
  );
  if (rotateTokenMatch && method === "POST") {
    const params = siteIdParamSchema.safeParse({
      siteId: rotateTokenMatch[1],
    });
    const slugParams = productSlugParamSchema.safeParse({
      productSlug: rotateTokenMatch[2],
    });
    const tokenParams = idParamSchema.safeParse({ id: rotateTokenMatch[3] });
    if (!params.success || !slugParams.success || !tokenParams.success) {
      return jsonError("Invalid id", 400);
    }
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }
    if (!auth.actor.isPlatformAdmin) {
      return jsonForbidden();
    }
    const resolved = await resolveSite(auth, params.data.siteId, [
      "owner",
      "admin",
      "member",
    ]);
    if (resolved instanceof Response) {
      return resolved;
    }
    const body = await parseJsonBody<unknown>(request);
    if (body instanceof Response) {
      return body;
    }
    const parsed = rotateProductTokenBodySchema.safeParse(body ?? {});
    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Invalid body", 400);
    }
    const rotation = await rotateProductToken(
      auth.actor,
      params.data.siteId,
      slugParams.data.productSlug,
      tokenParams.data.id,
      parsed.data,
    );
    if (!rotation) {
      return jsonError("Not found", 404);
    }
    return jsonCreated({ rotation });
  }

  const productUsageMatch = path.match(
    /^sites\/([^/]+)\/products\/([^/]+)\/usage$/,
  );
  if (productUsageMatch && method === "GET") {
    const params = siteIdParamSchema.safeParse({
      siteId: productUsageMatch[1],
    });
    const slugParams = productSlugParamSchema.safeParse({
      productSlug: productUsageMatch[2],
    });
    if (!params.success || !slugParams.success) {
      return jsonError("Invalid id", 400);
    }
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }
    const resolved = await resolveSite(auth, params.data.siteId, [
      "owner",
      "admin",
      "member",
    ]);
    if (resolved instanceof Response) {
      return resolved;
    }
    const usage = await getProductUsage(
      params.data.siteId,
      slugParams.data.productSlug,
    );
    if (!usage) {
      return jsonError("Not found", 404);
    }
    return jsonOk({ usage });
  }

  const productConfigMatch = path.match(
    /^sites\/([^/]+)\/products\/([^/]+)\/config$/,
  );
  if (productConfigMatch && (method === "GET" || method === "PATCH")) {
    const params = siteIdParamSchema.safeParse({
      siteId: productConfigMatch[1],
    });
    const slugParams = productSlugParamSchema.safeParse({
      productSlug: productConfigMatch[2],
    });
    if (!params.success || !slugParams.success) {
      return jsonError("Invalid id", 400);
    }
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }
    const resolved = await resolveSite(auth, params.data.siteId, [
      "owner",
      "admin",
      "member",
    ]);
    if (resolved instanceof Response) {
      return resolved;
    }

    if (method === "GET") {
      try {
        const config = await getProductConfig(
          params.data.siteId,
          slugParams.data.productSlug,
        );
        return jsonOk({ config });
      } catch (error) {
        if (error instanceof ProductConfigError) {
          return jsonError(error.message, error.status, { cache: "no-store" }, error.code);
        }
        return jsonError("Could not load configuration", 500);
      }
    }
    if (!auth.actor.isPlatformAdmin) {
      return jsonForbidden();
    }

    const body = await parseJsonBody<unknown>(request);
    if (body instanceof Response) {
      return body;
    }
    const parsed = updateProductConfigBodySchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Invalid body", 400);
    }
    try {
      const config = await saveProductConfigDraft(
        auth.actor,
        params.data.siteId,
        slugParams.data.productSlug,
        parsed.data,
      );
      return jsonOk({ config });
    } catch (error) {
      if (error instanceof ProductConfigError) {
        return jsonError(error.message, error.status, { cache: "no-store" }, error.code);
      }
      return jsonError("Could not save configuration", 500);
    }
  }

  const publishConfigMatch = path.match(
    /^sites\/([^/]+)\/products\/([^/]+)\/config\/publish$/,
  );
  if (publishConfigMatch && method === "POST") {
    const params = siteIdParamSchema.safeParse({
      siteId: publishConfigMatch[1],
    });
    const slugParams = productSlugParamSchema.safeParse({
      productSlug: publishConfigMatch[2],
    });
    if (!params.success || !slugParams.success) {
      return jsonError("Invalid id", 400);
    }
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }
    if (!auth.actor.isPlatformAdmin) {
      return jsonForbidden();
    }
    const resolved = await resolveSite(auth, params.data.siteId, [
      "owner",
      "admin",
      "member",
    ]);
    if (resolved instanceof Response) {
      return resolved;
    }
    try {
      const config = await publishProductConfig(
        auth.actor,
        params.data.siteId,
        slugParams.data.productSlug,
      );
      return jsonOk({ config });
    } catch (error) {
      if (error instanceof ProductConfigError) {
        return jsonError(error.message, error.status, { cache: "no-store" }, error.code);
      }
      return jsonError("Could not publish configuration", 500);
    }
  }

  const previewMatch = path.match(
    /^sites\/([^/]+)\/products\/([^/]+)\/preview$/,
  );
  if (previewMatch && method === "POST") {
    const params = siteIdParamSchema.safeParse({ siteId: previewMatch[1] });
    const slugParams = productSlugParamSchema.safeParse({
      productSlug: previewMatch[2],
    });
    if (!params.success || !slugParams.success) {
      return jsonError("Invalid id", 400);
    }
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }
    if (!auth.actor.isPlatformAdmin) {
      return jsonForbidden();
    }
    const resolved = await resolveSite(auth, params.data.siteId, [
      "owner",
      "admin",
      "member",
    ]);
    if (resolved instanceof Response) {
      return resolved;
    }
    try {
      const { embedUrl, expiresInSeconds } = await buildProductPreview(
        params.data.siteId,
        slugParams.data.productSlug,
      );
      return jsonOk({ embedUrl, expiresInSeconds });
    } catch (error) {
      if (error instanceof ProductBridgeError) {
        return jsonError(error.message, error.status);
      }
      return jsonError("Could not build preview", 502);
    }
  }

  const testMatch = path.match(/^sites\/([^/]+)\/products\/([^/]+)\/test$/);
  if (testMatch && method === "POST") {
    const params = siteIdParamSchema.safeParse({ siteId: testMatch[1] });
    const slugParams = productSlugParamSchema.safeParse({
      productSlug: testMatch[2],
    });
    if (!params.success || !slugParams.success) {
      return jsonError("Invalid id", 400);
    }
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }
    if (!auth.actor.isPlatformAdmin) {
      return jsonForbidden();
    }
    const resolved = await resolveSite(auth, params.data.siteId, [
      "owner",
      "admin",
      "member",
    ]);
    if (resolved instanceof Response) {
      return resolved;
    }
    const body = await parseJsonBody<unknown>(request);
    if (body instanceof Response) {
      return body;
    }
    const parsed = runProductTestBodySchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Invalid body", 400);
    }
    try {
      const result = await runSiteProductTest(
        params.data.siteId,
        slugParams.data.productSlug,
        parsed.data.action,
        parsed.data.input,
      );
      return jsonOk({ result });
    } catch (error) {
      if (error instanceof ProductConfigError) {
        return jsonError(error.message, error.status, { cache: "no-store" }, error.code);
      }
      if (error instanceof ProductBridgeError) {
        return jsonError(error.message, error.status);
      }
      return jsonError("Could not run test", 502);
    }
  }

  const conversationReplyMatch = path.match(
    /^sites\/([^/]+)\/products\/([^/]+)\/conversations\/([^/]+)\/messages$/,
  );
  if (conversationReplyMatch && method === "POST") {
    const params = siteIdParamSchema.safeParse({
      siteId: conversationReplyMatch[1],
    });
    const slugParams = productSlugParamSchema.safeParse({
      productSlug: conversationReplyMatch[2],
    });
    if (!params.success || !slugParams.success) {
      return jsonError("Invalid id", 400);
    }
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }
    const resolved = await resolveSite(auth, params.data.siteId, [
      "owner",
      "admin",
    ]);
    if (resolved instanceof Response) {
      return resolved;
    }
    const body = await parseJsonBody<{ body?: unknown }>(request);
    if (body instanceof Response) {
      return body;
    }
    const message = typeof body.body === "string" ? body.body.trim() : "";
    if (!message) {
      return jsonError("Message cannot be empty", 400);
    }
    try {
      const conversation = await replyToSiteProductConversation(
        params.data.siteId,
        slugParams.data.productSlug,
        conversationReplyMatch[3],
        message,
        auth.user.name,
      );
      return jsonOk({ conversation });
    } catch (error) {
      if (error instanceof ProductBridgeError) {
        return jsonError(error.message, error.status);
      }
      return jsonError("Could not send reply", 502);
    }
  }

  const conversationDetailMatch = path.match(
    /^sites\/([^/]+)\/products\/([^/]+)\/conversations\/([^/]+)$/,
  );
  if (conversationDetailMatch && method === "GET") {
    const params = siteIdParamSchema.safeParse({
      siteId: conversationDetailMatch[1],
    });
    const slugParams = productSlugParamSchema.safeParse({
      productSlug: conversationDetailMatch[2],
    });
    if (!params.success || !slugParams.success) {
      return jsonError("Invalid id", 400);
    }
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }
    const resolved = await resolveSite(auth, params.data.siteId, [
      "owner",
      "admin",
      "member",
    ]);
    if (resolved instanceof Response) {
      return resolved;
    }
    try {
      const conversation = await getSiteProductConversation(
        params.data.siteId,
        slugParams.data.productSlug,
        conversationDetailMatch[3],
      );
      return jsonOk({ conversation });
    } catch (error) {
      if (error instanceof ProductBridgeError) {
        return jsonError(error.message, error.status);
      }
      return jsonError("Could not load conversation", 502);
    }
  }

  const conversationsMatch = path.match(
    /^sites\/([^/]+)\/products\/([^/]+)\/conversations$/,
  );
  if (conversationsMatch && method === "GET") {
    const params = siteIdParamSchema.safeParse({
      siteId: conversationsMatch[1],
    });
    const slugParams = productSlugParamSchema.safeParse({
      productSlug: conversationsMatch[2],
    });
    if (!params.success || !slugParams.success) {
      return jsonError("Invalid id", 400);
    }
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }
    const resolved = await resolveSite(auth, params.data.siteId, [
      "owner",
      "admin",
      "member",
    ]);
    if (resolved instanceof Response) {
      return resolved;
    }
    const pagination = paginationQuerySchema.safeParse({
      page: url.searchParams.get("page") ?? undefined,
      pageSize: url.searchParams.get("pageSize") ?? undefined,
    });
    if (!pagination.success) {
      return jsonError("Invalid pagination", 400);
    }
    const status = url.searchParams.get("status") ?? undefined;
    try {
      const result = await listSiteProductConversations(
        params.data.siteId,
        slugParams.data.productSlug,
        {
          status,
          page: pagination.data.page,
          pageSize: pagination.data.pageSize,
        },
      );
      return jsonOk(result);
    } catch (error) {
      if (error instanceof ProductBridgeError) {
        return jsonError(error.message, error.status);
      }
      return jsonError("Could not load conversations", 502);
    }
  }

  const subscriptionMatch = path.match(/^sites\/([^/]+)\/products\/([^/]+)$/);
  if (subscriptionMatch && method === "PATCH") {
    const params = siteIdParamSchema.safeParse({
      siteId: subscriptionMatch[1],
    });
    const slugParams = productSlugParamSchema.safeParse({
      productSlug: subscriptionMatch[2],
    });
    if (!params.success || !slugParams.success) {
      return jsonError("Invalid id", 400);
    }
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }
    if (!auth.actor.isPlatformAdmin) {
      return jsonForbidden();
    }
    const resolved = await resolveSite(auth, params.data.siteId, [
      "owner",
      "admin",
      "member",
    ]);
    if (resolved instanceof Response) {
      return resolved;
    }
    const body = await parseJsonBody<unknown>(request);
    if (body instanceof Response) {
      return body;
    }
    const parsed = updateSubscriptionBodySchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Invalid body", 400);
    }
    try {
      const product = await setSiteProductPlan(
        auth.actor,
        params.data.siteId,
        slugParams.data.productSlug,
        parsed.data,
      );
      if (!product) {
        return jsonError("Unknown product", 404);
      }
      return jsonOk({ product });
    } catch (error) {
      if (error instanceof SubscriptionLifecycleError) {
        if (error.code === "PLAN_NOT_FOUND") {
          return jsonError("Unknown plan for this product", 400);
        }
        if (error.code === "RETENTION_EXPIRED") {
          return jsonError(error.message, 409);
        }
        if (error.code === "DOMAIN_REQUIRED") {
          return jsonError(error.message, 409, undefined, "DOMAIN_REQUIRED");
        }
        return jsonError(error.message, 400);
      }
      return jsonError("Unable to update product", 400);
    }
  }

  if (method === "POST" && path === "admin/subscriptions/reconciliations") {
    const auth = await requireAuthenticated(request);
    if (auth instanceof Response) {
      return auth;
    }
    if (!auth.actor.isPlatformAdmin) {
      return jsonForbidden();
    }
    const dryRun = new URL(request.url).searchParams.get("dryRun") !== "false";
    const report = await reconcileSubscriptions({ dryRun });
    return jsonOk({ report });
  }

  if (method === "GET" && path === "internal/tenant-bindings") {
    const environment = loadEnvironment();
    const ip = getClientIp(request);
    const ipLimitResponse = await enforceSensitiveRateLimit(
      `internal:tenant-bindings:ip:${ip}`,
      120,
      60_000,
    );
    if (ipLimitResponse) {
      return ipLimitResponse;
    }
    const authorization = request.headers.get("authorization");
    if (
      !isValidInternalAuthorization(authorization, environment.INTERNAL_API_SECRET)
    ) {
      return jsonUnauthorized();
    }
    const requestUrl = new URL(request.url);
    const siteId = requestUrl.searchParams.get("siteId")?.trim() ?? "";
    const productSlug = requestUrl.searchParams.get("productSlug")?.trim() ?? "";
    const bridgeAccess = requestUrl.searchParams.get("bridge") === "true";
    if (!siteId || !productSlug) {
      return jsonError("siteId and productSlug are required", 400);
    }
    try {
      const binding = await resolveTenantBinding(siteId, productSlug, {
        requireBridgeAccess: bridgeAccess,
      });
      return jsonOk({ binding });
    } catch (error) {
      if (error instanceof TenantBindingError) {
        return jsonError(error.message, error.status);
      }
      return jsonError("Could not resolve tenant binding", 500);
    }
  }

  if (method === "POST" && path === "internal/product-tokens/verifications") {
    const environment = loadEnvironment();
    const ip = getClientIp(request);
    const ipLimitResponse = await enforceSensitiveRateLimit(
      `internal:product-verify:ip:${ip}`,
      120,
      60_000,
    );
    if (ipLimitResponse) {
      return ipLimitResponse;
    }
    const authorization = request.headers.get("authorization");
    if (
      !isValidInternalAuthorization(
        authorization,
        environment.INTERNAL_API_SECRET,
      )
    ) {
      return jsonUnauthorized();
    }
    const body = await parseJsonBody<unknown>(request);
    if (body instanceof Response) {
      return body;
    }
    const parsed = verifyProductTokenBodySchema.safeParse(body);
    if (!parsed.success) {
      return jsonError("Invalid body", 400);
    }
    try {
      const verified = await verifyProductToken(parsed.data.token);
      if (!verified) {
        return jsonUnauthorized();
      }
      return jsonOk({ entitlement: verified });
    } catch (error) {
      if (error instanceof ProductConfigError) {
        return jsonError(error.message, error.status, { cache: "no-store" }, error.code);
      }
      return jsonError("Could not verify product token", 500);
    }
  }

  if (method === "POST" && path === "internal/product-config") {
    const environment = loadEnvironment();
    const ip = getClientIp(request);
    const ipLimitResponse = await enforceSensitiveRateLimit(
      `internal:product-config:ip:${ip}`,
      120,
      60_000,
    );
    if (ipLimitResponse) {
      return ipLimitResponse;
    }
    const authorization = request.headers.get("authorization");
    if (
      !isValidInternalAuthorization(
        authorization,
        environment.INTERNAL_API_SECRET,
      )
    ) {
      return jsonUnauthorized();
    }
    const body = await parseJsonBody<{ previewToken?: unknown }>(request);
    if (body instanceof Response) {
      return body;
    }
    const previewToken =
      typeof body.previewToken === "string" ? body.previewToken : "";
    const claims = await verifyPreviewToken(previewToken);
    if (!claims) {
      return jsonUnauthorized();
    }
    try {
      const config = await resolveDraftConfigForPreview(
        claims.siteId,
        claims.productSlug,
      );
      return jsonOk({
        siteId: claims.siteId,
        productSlug: claims.productSlug,
        config,
      });
    } catch (error) {
      if (error instanceof ProductConfigError) {
        return jsonError(error.message, error.status, { cache: "no-store" }, error.code);
      }
      return jsonError("Could not load draft configuration", 500);
    }
  }

  if (method === "GET" && path === "internal/product-sites") {
    const environment = loadEnvironment();
    const ip = getClientIp(request);
    const ipLimitResponse = await enforceSensitiveRateLimit(
      `internal:product-sites:ip:${ip}`,
      120,
      60_000,
    );
    if (ipLimitResponse) {
      return ipLimitResponse;
    }
    const authorization = request.headers.get("authorization");
    if (
      !isValidInternalAuthorization(
        authorization,
        environment.INTERNAL_API_SECRET,
      )
    ) {
      return jsonUnauthorized();
    }
    const slug = new URL(request.url).searchParams.get("slug");
    if (!slug) {
      return jsonError("slug required", 400);
    }
    const sites = await listProductSitesForSwitcher(slug);
    return jsonOk({ sites });
  }

  if (method === "POST" && path === "internal/product-usage") {
    const environment = loadEnvironment();
    const ip = getClientIp(request);
    const ipLimitResponse = await enforceSensitiveRateLimit(
      `internal:product-usage:ip:${ip}`,
      600,
      60_000,
    );
    if (ipLimitResponse) {
      return ipLimitResponse;
    }
    const authorization = request.headers.get("authorization");
    if (
      !isValidInternalAuthorization(
        authorization,
        environment.INTERNAL_API_SECRET,
      )
    ) {
      return jsonUnauthorized();
    }
    const body = await parseJsonBody<unknown>(request);
    if (body instanceof Response) {
      return body;
    }
    const parsed = recordProductUsageBodySchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Invalid body", 400);
    }
    const recorded = await recordProductUsage(parsed.data);
    if (!recorded) {
      return jsonError("Unknown token or product", 404);
    }
    if (recorded.denied) {
      return jsonError("Quota exceeded for this metric", 429);
    }
    return jsonOk({ usage: recorded });
  }

  if (method === "POST" && path === "internal/sso/exchanges") {
    const environment = loadEnvironment();
    const ip = getClientIp(request);
    const ipLimitResponse = await enforceSensitiveRateLimit(
      `internal:sso-exchange:ip:${ip}`,
      60,
      60_000,
    );
    if (ipLimitResponse) {
      return ipLimitResponse;
    }
    const authorization = request.headers.get("authorization");
    if (!isValidInternalAuthorization(authorization, environment.INTERNAL_API_SECRET)) {
      return jsonUnauthorized();
    }
    const body = await parseJsonBody<unknown>(request);
    if (body instanceof Response) {
      return body;
    }
    const parsed = exchangeSsoBodySchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Invalid body", 400);
    }
    const claims = await exchangeDashboardSsoCode(parsed.data.code, parsed.data.productSlug);
    if (!claims) {
      return jsonError("SSO code is invalid or expired.", 401);
    }
    return jsonOk({ claims });
  }

  if (method === "POST" && path === "internal/platform-sessions/verifications") {
    const environment = loadEnvironment();
    const ip = getClientIp(request);
    const ipLimitResponse = await enforceSensitiveRateLimit(
      `internal:platform-session:ip:${ip}`,
      120,
      60_000,
    );
    if (ipLimitResponse) {
      return ipLimitResponse;
    }
    const authorization = request.headers.get("authorization");
    if (!isValidInternalAuthorization(authorization, environment.INTERNAL_API_SECRET)) {
      return jsonUnauthorized();
    }
    const body = await parseJsonBody<unknown>(request);
    if (body instanceof Response) {
      return body;
    }
    const parsed = verifyPlatformSessionBodySchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Invalid body", 400);
    }
    const valid = await verifyPlatformAdminSession(
      parsed.data.userId,
      parsed.data.sessionVersion,
    );
    return jsonOk({ valid });
  }

  return jsonError("Not found", 404);
}
