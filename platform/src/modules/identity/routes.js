/**
 * HTTP routes of the `identity` module — thin adapters: parse (core/inputs), authorise (PLAN 0.2 rights table, see
 * `infra/rbac.js`), call the service.
 *
 * - `/v1/auth/*` (public, rate-limited): the one sign-in page (+ two-step step), Create admin, Forgot password,
 *   setup links, reset links, e-mail confirmation; sign-out.
 * - `/v1/me/*` (admin or merchant session): the signed-in person, their details, e-mail, password and two-step.
 * - `/v1/merchants/:merchantId/*` (merchant session for its own records, or admin): websites, keys, issuers.
 * - `/v1/admin/*` (admin): merchants (create, search, edit, suspend, resume, setup links, two-step off, delete,
 *   bulk actions) and admins (invite, resend or copy, correct e-mail, change role, two-step off, remove).
 * - `GET /v1/product/revocations?since=` (client assertion, F.9).
 *
 * Responses that carry secrets (setup links, two-step secrets and recovery codes, website keys) opt out of
 * idempotent replay (`idempotent: 'no-store'`): the idempotency store persists response bodies.
 * @module
 */
import { readCookie } from '../../infra/auth.js';
import { created, defineRoute, noContent, ok, paginate, problem } from '../../infra/http.js';
import { PERMISSIONS as P } from '../../infra/rbac.js';
import { inputs } from './core/inputs.js';
import { presentMerchant } from './core/present.js';
import { parseIssuer } from './core/issuer.js';

/** @typedef {import('../../infra/http.js').RequestContext} RequestContext */
/** @typedef {import('../../infra/http.js').RouteDefinition} RouteDefinition */
/** @typedef {import('../../infra/rbac.js').Actor} Actor */
/** @typedef {import('../../infra/modules.js').ModuleContext} ModuleContext */
/** @typedef {import('./service.js').IdentityService} IdentityService */
/** @typedef {import('./core/inputs.js').FieldError} FieldError */

const AUTH_LIMIT = Object.freeze({ limit: 60, windowMs: 60_000 });
const STATUSES = Object.freeze(['active', 'suspended']);

/**
 * @template T
 * @param {{ ok: true, value: T } | { ok: false, errors: FieldError[] }} parsed
 * @returns {T}
 */
const valid = (parsed) => {
	if (!parsed.ok) throw problem('validation_failed', 'The request is invalid.', { errors: parsed.errors });
	return parsed.value;
};

/** @param {RequestContext} c */
const metaOf = (c) => ({ requestId: c.requestId, ip: c.ip, userAgent: c.headers.get('user-agent') });

/** @param {RequestContext} c */
const actorOf = (c) => /** @type {Actor} */ (c.actor);

/** @param {RequestContext} c */
const sessionOf = (c) => /** @type {import('../../infra/auth.js').Session} */ (c.session);

/**
 * Body without the `cookie` member, with the cookie set on the response.
 * @param {{ cookie?: string } & Record<string, unknown>} result
 * @param {{ status?: number }} [init]
 */
const withCookie = ({ cookie, ...body }, { status = 200 } = {}) => ok(body, { status, cookies: cookie ? [cookie] : [] });

/**
 * Merchants may only address their own records (checked before any lookup, so ids of other merchants are neither
 * confirmed nor denied).
 * @param {RequestContext} c
 */
const ownMerchant = (c) => {
	const actor = actorOf(c);
	if (actor.type === 'merchant' && actor.merchantId !== c.params.merchantId)
		throw problem('forbidden', 'This merchant is not yours.');
	return /** @type {string} */ (c.params.merchantId);
};

/**
 * @param {ModuleContext} ctx
 * @param {IdentityService} service
 * @returns {RouteDefinition[]}
 */
export const identityRoutes = (ctx, service) => {
	const { accounts, admins, merchants, websites, keys, issuers, issuerRequests } = service;

	/**
	 * @param {RequestContext} c
	 * @param {'admin' | 'merchant'} kind
	 */
	const tokenOf = (c, kind) => readCookie(c.headers.get('cookie'), ctx.cookies.name(kind)) ?? '';
	/** @param {RequestContext} c */
	const kindOf = (c) => /** @type {'admin' | 'merchant'} */ (c.authMode === 'admin' ? 'admin' : 'merchant');

	/**
	 * Load the website (tenant-scoped), then authorise against it.
	 * @param {RequestContext} c
	 * @param {string} permission
	 */
	const authorizedWebsite = async (c, permission) => {
		const merchantId = ownMerchant(c);
		const website = await websites.loadWebsite(/** @type {string} */ (c.params.websiteId), merchantId);
		c.authorize(permission, { merchantId, websiteId: websites.liveIdOf(website) });
		return { merchantId, website };
	};

	/** @type {RouteDefinition[]} */
	const routes = [
		// ---------------------------------------------------------------------------------------------------------
		// Sign-in (public)
		{
			method: 'POST',
			path: '/v1/auth/sign-in',
			auth: 'public',
			idempotent: 'no-store',
			rateLimit: AUTH_LIMIT,
			handler: async (c) => withCookie(await accounts.signIn(valid(inputs.signIn(c.body)), metaOf(c))),
		},
		{
			method: 'POST',
			path: '/v1/auth/sign-in/two-step',
			auth: 'public',
			idempotent: 'no-store',
			rateLimit: AUTH_LIMIT,
			handler: async (c) => withCookie(await accounts.signInTwoStep(valid(inputs.twoStepSignIn(c.body)), metaOf(c))),
		},
		{
			method: 'GET',
			path: '/v1/auth/first-admin',
			auth: 'public',
			rateLimit: AUTH_LIMIT,
			handler: async () => ok({ available: await accounts.firstAdminAvailable() }),
		},
		{
			method: 'POST',
			path: '/v1/auth/first-admin',
			auth: 'public',
			idempotent: 'no-store',
			rateLimit: AUTH_LIMIT,
			handler: async (c) =>
				withCookie(await accounts.createFirstAdmin(valid(inputs.firstAdmin(c.body)), metaOf(c)), { status: 201 }),
		},
		{
			method: 'POST',
			path: '/v1/auth/forgot-password',
			auth: 'public',
			idempotent: 'no-store',
			rateLimit: AUTH_LIMIT,
			handler: async (c) => ok(await accounts.forgotPassword(valid(inputs.emailOnly(c.body))), { status: 202 }),
		},
		{
			method: 'POST',
			path: '/v1/auth/reset-password',
			auth: 'public',
			idempotent: 'no-store',
			rateLimit: AUTH_LIMIT,
			handler: async (c) => {
				await accounts.resetPassword(valid(inputs.resetConfirm(c.body)), metaOf(c));
				return noContent();
			},
		},
		{
			method: 'POST',
			path: '/v1/auth/set-password/check',
			auth: 'public',
			idempotent: 'no-store',
			rateLimit: AUTH_LIMIT,
			handler: async (c) => ok(await accounts.checkSetupLink(valid(inputs.tokenOnly(c.body)))),
		},
		{
			method: 'POST',
			path: '/v1/auth/set-password',
			auth: 'public',
			idempotent: 'no-store',
			rateLimit: AUTH_LIMIT,
			handler: async (c) => withCookie(await accounts.setPassword(valid(inputs.setupConfirm(c.body)), metaOf(c))),
		},
		{
			method: 'POST',
			path: '/v1/auth/confirm-email',
			auth: 'public',
			idempotent: 'no-store',
			rateLimit: AUTH_LIMIT,
			handler: async (c) => ok(await accounts.confirmEmail(valid(inputs.tokenOnly(c.body)), metaOf(c))),
		},
		{
			method: 'POST',
			path: '/v1/auth/sign-out',
			auth: ['admin', 'merchant'],
			mfa: false,
			handler: async (c) => {
				const kind = kindOf(c);
				return noContent({ cookies: [(await accounts.signOut(kind, tokenOf(c, kind))).cookie] });
			},
		},

		// ---------------------------------------------------------------------------------------------------------
		// The signed-in person
		{
			method: 'GET',
			path: '/v1/me',
			auth: ['admin', 'merchant'],
			mfa: false,
			handler: async (c) => ok(await accounts.me(sessionOf(c), actorOf(c))),
		},
		{
			method: 'PATCH',
			path: '/v1/me',
			auth: ['admin', 'merchant'],
			handler: async (c) => {
				const id = sessionOf(c).subject;
				if (kindOf(c) === 'admin')
					return ok(await accounts.updateAdminProfile({ ...valid(inputs.adminProfile(c.body)), id }, metaOf(c)));
				return ok(
					await merchants.update({
						merchantId: id,
						...valid(inputs.merchantProfile(c.body)),
						actor: actorOf(c),
						meta: metaOf(c),
					}),
				);
			},
		},
		{
			method: 'POST',
			path: '/v1/me/email',
			auth: ['admin', 'merchant'],
			idempotent: 'no-store',
			rateLimit: AUTH_LIMIT,
			handler: async (c) =>
				ok(
					await accounts.requestEmailChange(
						kindOf(c),
						{ ...valid(inputs.emailChange(c.body)), id: sessionOf(c).subject },
						metaOf(c),
					),
					{ status: 202 },
				),
		},
		{
			method: 'POST',
			path: '/v1/me/password',
			auth: ['admin', 'merchant'],
			idempotent: 'no-store',
			rateLimit: AUTH_LIMIT,
			handler: async (c) => {
				const kind = kindOf(c);
				await accounts.changePassword(
					kind,
					{ ...valid(inputs.passwordChange(c.body)), id: sessionOf(c).subject, token: tokenOf(c, kind) },
					metaOf(c),
				);
				return noContent();
			},
		},
		{
			method: 'POST',
			path: '/v1/me/two-step/start',
			auth: ['admin', 'merchant'],
			mfa: false,
			idempotent: 'no-store',
			handler: async (c) => ok(await accounts.twoStepStart(kindOf(c), sessionOf(c).subject)),
		},
		{
			method: 'POST',
			path: '/v1/me/two-step/confirm',
			auth: ['admin', 'merchant'],
			mfa: false,
			idempotent: 'no-store',
			rateLimit: AUTH_LIMIT,
			handler: async (c) =>
				ok(
					await accounts.twoStepConfirm(
						kindOf(c),
						{ ...valid(inputs.twoStepConfirm(c.body)), id: sessionOf(c).subject },
						metaOf(c),
					),
				),
		},
		{
			method: 'POST',
			path: '/v1/me/two-step/off',
			auth: ['admin', 'merchant'],
			idempotent: 'no-store',
			rateLimit: AUTH_LIMIT,
			handler: async (c) =>
				ok(
					await accounts.twoStepOff(
						kindOf(c),
						{ ...valid(inputs.twoStepWithPassword(c.body)), id: sessionOf(c).subject },
						metaOf(c),
					),
				),
		},
		{
			method: 'POST',
			path: '/v1/me/two-step/recovery-codes',
			auth: ['admin', 'merchant'],
			idempotent: 'no-store',
			rateLimit: AUTH_LIMIT,
			handler: async (c) =>
				ok(
					await accounts.newRecoveryCodes(
						kindOf(c),
						{ ...valid(inputs.twoStepWithPassword(c.body)), id: sessionOf(c).subject },
						metaOf(c),
					),
				),
		},

		// ---------------------------------------------------------------------------------------------------------
		// A merchant's records (the merchant itself, or admins)
		{
			method: 'GET',
			path: '/v1/merchants/:merchantId',
			auth: ['merchant', 'admin'],
			permission: P.merchantsRead,
			handler: async (c) => {
				const merchantId = ownMerchant(c);
				if (actorOf(c).type === 'admin') return ok(await merchants.get(merchantId));
				return ok(presentMerchant(await merchants.load(merchantId), { forAdmin: false }));
			},
		},
		{
			method: 'GET',
			path: '/v1/merchants/:merchantId/websites',
			auth: ['merchant', 'admin'],
			permission: P.websitesRead,
			handler: async (c) => ok({ items: await websites.listWebsites(ownMerchant(c)) }),
		},
		{
			method: 'POST',
			path: '/v1/merchants/:merchantId/websites',
			auth: ['admin', 'merchant'],
			permission: P.websitesWrite,
			idempotent: true,
			handler: async (c) =>
				created(
					await websites.createWebsite({
						merchantId: ownMerchant(c),
						...valid(inputs.website(c.body)),
						actor: actorOf(c),
						meta: metaOf(c),
					}),
				),
		},
		{
			method: 'GET',
			path: '/v1/merchants/:merchantId/websites/:websiteId',
			auth: ['merchant', 'admin'],
			handler: async (c) => {
				const { website } = await authorizedWebsite(c, P.websitesRead);
				return ok(await websites.getWebsite(String(website._id), String(website.merchantId)));
			},
		},
		{
			// website settings (F.16) until the switch (PLAN 0.12 step 5)
			method: 'PATCH',
			path: '/v1/merchants/:merchantId/websites/:websiteId',
			auth: ['merchant', 'admin'],
			handler: async (c) => {
				const { merchantId, website } = await authorizedWebsite(c, P.settingsWrite);
				const settings = valid(inputs.websiteSettings(c.body));
				return ok(
					await websites.updateSettings({
						merchantId,
						websiteId: String(website._id),
						settings,
						actor: actorOf(c),
						meta: metaOf(c),
					}),
				);
			},
		},
		{
			method: 'DELETE',
			path: '/v1/merchants/:merchantId/websites/:websiteId',
			auth: ['admin', 'merchant'],
			handler: async (c) => {
				const { merchantId, website } = await authorizedWebsite(c, P.websitesWrite);
				return ok(
					await websites.removeWebsite({
						merchantId,
						websiteId: String(website._id),
						...valid(inputs.websiteRemove(c.body)),
						actor: actorOf(c),
						meta: metaOf(c),
					}),
				);
			},
		},
		{
			method: 'GET',
			path: '/v1/merchants/:merchantId/websites/:websiteId/keys',
			auth: ['merchant', 'admin'],
			handler: async (c) => {
				const { merchantId, website } = await authorizedWebsite(c, P.tokensManage);
				return ok({ items: await keys.listKeys({ merchantId, websiteId: String(website._id) }) });
			},
		},
		{
			// the scope vocabulary keys are checked against (F.16): platform scopes + per listed service product
			method: 'GET',
			path: '/v1/merchants/:merchantId/websites/:websiteId/keys/scopes',
			auth: ['merchant', 'admin'],
			handler: async (c) => {
				await authorizedWebsite(c, P.tokensManage);
				return ok({ defaults: ['elements.read', 'events.write'], items: await keys.scopeCatalogue() });
			},
		},
		{
			method: 'POST',
			path: '/v1/merchants/:merchantId/websites/:websiteId/keys',
			auth: ['merchant', 'admin'],
			idempotent: 'no-store',
			handler: async (c) => {
				const body = valid(inputs.keyIssue(c.body));
				const { merchantId, website } = await authorizedWebsite(c, P.tokensManage);
				return created(
					await keys.issueKey({
						merchantId,
						websiteId: String(website._id),
						kind: body.kind,
						scopes: body.scopes ?? [],
						...(body.expiresAt === undefined ? {} : { expiresAt: body.expiresAt }),
						...(body.allowSubdomains === undefined ? {} : { allowSubdomains: body.allowSubdomains }),
						actor: actorOf(c),
						meta: metaOf(c),
					}),
				);
			},
		},
		{
			method: 'POST',
			path: '/v1/merchants/:merchantId/websites/:websiteId/keys/:keyId/rotate',
			auth: ['merchant', 'admin'],
			idempotent: 'no-store',
			handler: async (c) => {
				const body = valid(inputs.keyRotate(c.body));
				const { merchantId, website } = await authorizedWebsite(c, P.tokensManage);
				return created(
					await keys.rotateKey({
						merchantId,
						websiteId: String(website._id),
						keyId: /** @type {string} */ (c.params.keyId),
						...(body.graceSeconds === undefined ? {} : { graceSeconds: body.graceSeconds }),
						actor: actorOf(c),
						meta: metaOf(c),
					}),
				);
			},
		},
		{
			method: 'POST',
			path: '/v1/merchants/:merchantId/websites/:websiteId/keys/:keyId/revoke',
			auth: ['merchant', 'admin'],
			handler: async (c) => {
				const body = valid(inputs.keyRevoke(c.body));
				const { merchantId, website } = await authorizedWebsite(c, P.tokensManage);
				return ok(
					await keys.revokeKey({
						merchantId,
						websiteId: String(website._id),
						keyId: /** @type {string} */ (c.params.keyId),
						...(body.reason === undefined ? {} : { reason: body.reason }),
						actor: actorOf(c),
						meta: metaOf(c),
					}),
				);
			},
		},

		// ---------------------------------------------------------------------------------------------------------
		// Bring-your-own customer identity (one issuer per website) until the switch (PLAN 0.12 step 5)
		{
			method: 'GET',
			path: '/v1/merchants/:merchantId/websites/:websiteId/identity',
			auth: ['merchant', 'admin'],
			handler: async (c) => {
				const { merchantId, website } = await authorizedWebsite(c, P.settingsRead);
				const websiteId = String(website._id);
				return ok({
					issuer: await issuers.getIssuer({ merchantId, websiteId }),
					request: await issuerRequests.pending({ merchantId, websiteId }),
				});
			},
		},
		.../** @type {const} */ (['approve', 'reject']).map((decision) => ({
			method: /** @type {const} */ ('POST'),
			path: `/v1/merchants/:merchantId/websites/:websiteId/identity/request/${decision}`,
			auth: /** @type {import('../../infra/http.js').AuthMode[]} */ (['merchant', 'admin']),
			idempotent: /** @type {const} */ ('optional'),
			/** @param {RequestContext} c */
			handler: async (c) => {
				const body = valid(inputs.keyRevoke(c.body));
				const { merchantId, website } = await authorizedWebsite(c, P.settingsWrite);
				return ok(
					await issuerRequests.decide({
						merchantId,
						websiteId: String(website._id),
						decision,
						reason: body.reason ?? null,
						actor: actorOf(c),
						meta: metaOf(c),
					}),
				);
			},
		})),
		{
			// console notifications: pending product requests across the merchant's websites (F.16)
			method: 'GET',
			path: '/v1/merchants/:merchantId/notifications',
			auth: ['merchant', 'admin'],
			permission: P.settingsRead,
			handler: async (c) => {
				const merchantId = ownMerchant(c);
				const all = await issuerRequests.pendingForMerchant({ merchantId });
				const live = new Map((await websites.listWebsites(merchantId)).map((w) => [w.websiteId, w]));
				const items = all
					.filter((r) => live.has(r.websiteId))
					.map((r) => ({
						kind: 'identity_issuer_request',
						websiteId: r.websiteId,
						domain: live.get(r.websiteId)?.domain ?? null,
						request: r,
					}));
				return ok({ items });
			},
		},
		{
			method: 'PUT',
			path: '/v1/merchants/:merchantId/websites/:websiteId/identity',
			auth: ['merchant', 'admin'],
			handler: async (c) => {
				const { merchantId, website } = await authorizedWebsite(c, P.settingsWrite);
				const input = valid(parseIssuer(c.body));
				return ok({
					issuer: await issuers.setIssuer({
						merchantId,
						websiteId: String(website._id),
						input,
						actor: actorOf(c),
						meta: metaOf(c),
					}),
				});
			},
		},
		{
			method: 'DELETE',
			path: '/v1/merchants/:merchantId/websites/:websiteId/identity',
			auth: ['merchant', 'admin'],
			handler: async (c) => {
				const { merchantId, website } = await authorizedWebsite(c, P.settingsWrite);
				return ok(
					await issuers.removeIssuer({ merchantId, websiteId: String(website._id), actor: actorOf(c), meta: metaOf(c) }),
				);
			},
		},
		{
			method: 'POST',
			path: '/v1/merchants/:merchantId/websites/:websiteId/identity/refresh',
			auth: ['merchant', 'admin'],
			idempotent: 'optional',
			rateLimit: { limit: 10, windowMs: 60_000 },
			handler: async (c) => {
				const { merchantId, website } = await authorizedWebsite(c, P.settingsWrite);
				return ok({
					issuer: await issuers.refreshKeys({
						merchantId,
						websiteId: String(website._id),
						actor: actorOf(c),
						meta: metaOf(c),
					}),
				});
			},
		},

		// ---------------------------------------------------------------------------------------------------------
		// Admin: merchants
		{
			method: 'GET',
			path: '/v1/admin/merchants',
			auth: 'admin',
			permission: P.merchantsRead,
			handler: async (c) => {
				const status = c.query.status;
				if (status !== undefined && !STATUSES.includes(status))
					return problem('validation_failed', 'status must be active or suspended.');
				const q = c.query.q;
				if (q !== undefined && q.length > 120) return problem('validation_failed', 'q is at most 120 characters.');
				const page = paginate({ cursor: c.query.cursor, limit: c.query.limit, url: c.request.url }, { defaultLimit: 50 });
				const after = typeof page.after === 'string' ? page.after : null;
				const items = await merchants.list({
					after,
					limit: page.fetchLimit,
					...(status ? { status } : {}),
					...(q ? { q } : {}),
				});
				return page.respond(items, (m) => m.merchantId);
			},
		},
		{
			method: 'POST',
			path: '/v1/admin/merchants',
			auth: 'admin',
			permission: P.merchantsWrite,
			idempotent: 'no-store',
			handler: async (c) =>
				created(await merchants.create({ ...valid(inputs.merchantCreate(c.body)), actor: actorOf(c), meta: metaOf(c) })),
		},
		{
			method: 'POST',
			path: '/v1/admin/merchants/bulk',
			auth: 'admin',
			permission: P.merchantsSuspend,
			idempotent: 'optional',
			handler: async (c) => {
				const body = valid(inputs.bulk(c.body));
				if (body.action === 'resend_setup_link') c.authorize(P.merchantsSetupLink, {});
				return ok(await merchants.bulk({ ...body, actor: actorOf(c), meta: metaOf(c) }));
			},
		},
		{
			method: 'GET',
			path: '/v1/admin/merchants/:merchantId',
			auth: 'admin',
			permission: P.merchantsRead,
			handler: async (c) => ok(await merchants.get(/** @type {string} */ (c.params.merchantId))),
		},
		{
			method: 'PATCH',
			path: '/v1/admin/merchants/:merchantId',
			auth: 'admin',
			permission: P.merchantsWrite,
			handler: async (c) =>
				ok(
					await merchants.update({
						merchantId: /** @type {string} */ (c.params.merchantId),
						...valid(inputs.merchantUpdate(c.body)),
						actor: actorOf(c),
						meta: metaOf(c),
					}),
				),
		},
		{
			method: 'DELETE',
			path: '/v1/admin/merchants/:merchantId',
			auth: 'admin',
			permission: P.merchantsDelete,
			handler: async (c) => {
				await merchants.remove({
					merchantId: /** @type {string} */ (c.params.merchantId),
					...valid(inputs.merchantDelete(c.body)),
					actor: actorOf(c),
					meta: metaOf(c),
				});
				return noContent();
			},
		},
		.../** @type {const} */ (['suspend', 'resume']).map((action) => ({
			method: /** @type {const} */ ('POST'),
			path: `/v1/admin/merchants/:merchantId/${action}`,
			auth: /** @type {const} */ ('admin'),
			permission: P.merchantsSuspend,
			idempotent: /** @type {const} */ ('optional'),
			/** @param {RequestContext} c */
			handler: async (c) => {
				const merchantId = /** @type {string} */ (c.params.merchantId);
				if (action === 'suspend')
					return ok(
						await merchants.suspend({ merchantId, ...valid(inputs.reason(c.body)), actor: actorOf(c), meta: metaOf(c) }),
					);
				return ok(await merchants.resume({ merchantId, actor: actorOf(c), meta: metaOf(c) }));
			},
		})),
		{
			method: 'POST',
			path: '/v1/admin/merchants/:merchantId/setup-link',
			auth: 'admin',
			permission: P.merchantsSetupLink,
			idempotent: 'no-store',
			handler: async (c) =>
				ok(
					await merchants.setupLink({
						merchantId: /** @type {string} */ (c.params.merchantId),
						...valid(inputs.linkAction(c.body)),
						actor: actorOf(c),
						meta: metaOf(c),
					}),
				),
		},
		{
			method: 'POST',
			path: '/v1/admin/merchants/:merchantId/two-step/off',
			auth: 'admin',
			permission: P.twoStepTurnOff,
			idempotent: 'optional',
			handler: async (c) =>
				ok(
					await accounts.turnOffTwoStepFor('merchant', {
						id: /** @type {string} */ (c.params.merchantId),
						actor: actorOf(c),
						meta: metaOf(c),
					}),
				),
		},

		// ---------------------------------------------------------------------------------------------------------
		// Admin: admins (Owner only)
		{
			method: 'GET',
			path: '/v1/admin/admins',
			auth: 'admin',
			permission: P.adminsManage,
			handler: async () => ok({ items: await admins.list() }),
		},
		{
			method: 'POST',
			path: '/v1/admin/admins',
			auth: 'admin',
			permission: P.adminsManage,
			idempotent: 'no-store',
			handler: async (c) =>
				created(await admins.invite({ ...valid(inputs.adminInvite(c.body)), actor: actorOf(c), meta: metaOf(c) })),
		},
		{
			method: 'PATCH',
			path: '/v1/admin/admins/:adminId',
			auth: 'admin',
			permission: P.adminsManage,
			handler: async (c) =>
				ok(
					await admins.update({
						adminId: /** @type {string} */ (c.params.adminId),
						...valid(inputs.adminUpdate(c.body)),
						actor: actorOf(c),
						meta: metaOf(c),
					}),
				),
		},
		{
			method: 'POST',
			path: '/v1/admin/admins/:adminId/invite',
			auth: 'admin',
			permission: P.adminsManage,
			idempotent: 'no-store',
			handler: async (c) =>
				ok(
					await admins.resendInvite({
						adminId: /** @type {string} */ (c.params.adminId),
						...valid(inputs.linkAction(c.body)),
						actor: actorOf(c),
						meta: metaOf(c),
					}),
				),
		},
		{
			method: 'POST',
			path: '/v1/admin/admins/:adminId/two-step/off',
			auth: 'admin',
			permission: P.twoStepTurnOff,
			idempotent: 'optional',
			handler: async (c) =>
				ok(
					await accounts.turnOffTwoStepFor('admin', {
						id: /** @type {string} */ (c.params.adminId),
						actor: actorOf(c),
						meta: metaOf(c),
					}),
				),
		},
		{
			method: 'DELETE',
			path: '/v1/admin/admins/:adminId',
			auth: 'admin',
			permission: P.adminsManage,
			handler: async (c) => {
				await admins.remove({ adminId: /** @type {string} */ (c.params.adminId), actor: actorOf(c), meta: metaOf(c) });
				return noContent();
			},
		},

		// ---------------------------------------------------------------------------------------------------------
		// Product API (F.9, F.16)
		{
			// a product asks to become the website's identity issuer: stored pending until the merchant approves
			method: 'PUT',
			path: '/v1/product/websites/:websiteId/identity',
			auth: 'product',
			rateLimit: { limit: 30, windowMs: 60 * 60_000 },
			handler: async (c) => {
				const input = valid(parseIssuer(c.body));
				const result = await issuerRequests.request({
					appId: /** @type {{ appId: string }} */ (c.app).appId,
					websiteId: /** @type {string} */ (c.params.websiteId),
					input,
					meta: metaOf(c),
				});
				return ok(result, { status: result.status === 'pending' ? 202 : 200 });
			},
		},
		{
			method: 'GET',
			path: '/v1/product/revocations',
			auth: 'product',
			rateLimit: { limit: 120, windowMs: 60_000 },
			handler: async (c) => ok(await keys.revocationsSince(c.query.since)),
		},
	];
	return routes.map((route) => defineRoute(route));
};
