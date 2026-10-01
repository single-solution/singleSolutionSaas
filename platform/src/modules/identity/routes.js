/**
 * HTTP routes of the `identity` module — thin adapters: parse (core/inputs), authorise, call the service.
 *
 * - `/v1/auth/*` (public, rate-limited): signup, e-mail verification, login (+ MFA step), password reset, invites;
 *   staff login and the MFA routes a half-signed-in staff session may reach (`mfa: false`).
 * - `/v1/me/*` (staff or merchant session): profile, password, MFA, sessions, merchant switch.
 * - `/v1/merchants/:merchantId/*` (merchant session or staff): merchant, team, websites, keys.
 * - `/v1/admin/*` (staff): merchants, websites, staff users, partners, developers.
 * - `GET /v1/product/revocations?since=` (client assertion, F.9).
 *
 * Responses that carry secrets (website keys, MFA secrets and recovery codes, challenges) opt out of idempotent
 * replay (`idempotent: 'no-store'`): the idempotency store persists response bodies.
 * @module
 */
import { readCookie } from '../../infra/auth.js';
import { created, defineRoute, noContent, ok, paginate, problem } from '../../infra/http.js';
import { inputs } from './core/inputs.js';

/** @typedef {import('../../infra/http.js').RequestContext} RequestContext */
/** @typedef {import('../../infra/http.js').RouteDefinition} RouteDefinition */
/** @typedef {import('../../infra/rbac.js').Actor} Actor */
/** @typedef {import('../../infra/modules.js').ModuleContext} ModuleContext */
/** @typedef {import('./service.js').IdentityService} IdentityService */
/** @typedef {import('./core/inputs.js').FieldError} FieldError */

const AUTH_LIMIT = Object.freeze({ limit: 60, windowMs: 60_000 });

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
 * Merchant users may only address their own merchant (checked before any lookup, so ids of other merchants are
 * neither confirmed nor denied).
 * @param {RequestContext} c
 */
const ownMerchant = (c) => {
	const actor = actorOf(c);
	if (actor.type === 'merchant_user' && actor.merchantId !== c.params.merchantId)
		throw problem('forbidden', 'This merchant is not yours.');
	return /** @type {string} */ (c.params.merchantId);
};

/**
 * @param {ModuleContext} ctx
 * @param {IdentityService} service
 * @returns {RouteDefinition[]}
 */
export const identityRoutes = (ctx, service) => {
	const { accounts, teams, websites, keys, admin } = service;

	/**
	 * @param {RequestContext} c
	 * @param {'staff' | 'merchant'} kind
	 */
	const tokenOf = (c, kind) => readCookie(c.headers.get('cookie'), ctx.cookies.name(kind)) ?? '';
	/** @param {RequestContext} c */
	const kindOf = (c) => /** @type {'staff' | 'merchant'} */ (c.authMode === 'staff' ? 'staff' : 'merchant');

	/**
	 * Load the website (tenant-scoped), then authorise against its live id (grants cover the test twin).
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
		// Merchant auth (public)
		{
			method: 'POST',
			path: '/v1/auth/merchant/signup',
			auth: 'public',
			idempotent: 'no-store',
			rateLimit: AUTH_LIMIT,
			handler: async (c) => ok(await accounts.signup(valid(inputs.signup(c.body))), { status: 202 }),
		},
		{
			method: 'POST',
			path: '/v1/auth/merchant/verify-email',
			auth: 'public',
			idempotent: 'no-store',
			rateLimit: AUTH_LIMIT,
			handler: async (c) =>
				withCookie(await accounts.verifyEmail(valid(inputs.tokenOnly(c.body)), metaOf(c)), { status: 201 }),
		},
		{
			method: 'POST',
			path: '/v1/auth/merchant/login',
			auth: 'public',
			idempotent: 'no-store',
			rateLimit: AUTH_LIMIT,
			handler: async (c) => withCookie(await accounts.merchantLogin(valid(inputs.login(c.body)), metaOf(c))),
		},
		{
			method: 'POST',
			path: '/v1/auth/merchant/login/mfa',
			auth: 'public',
			idempotent: 'no-store',
			rateLimit: AUTH_LIMIT,
			handler: async (c) => withCookie(await accounts.merchantLoginMfa(valid(inputs.mfaChallenge(c.body)), metaOf(c))),
		},
		{
			method: 'POST',
			path: '/v1/auth/merchant/logout',
			auth: 'merchant',
			idempotent: false,
			handler: async (c) => noContent({ cookies: [(await accounts.logout('merchant', tokenOf(c, 'merchant'))).cookie] }),
		},
		{
			method: 'POST',
			path: '/v1/auth/merchant/password-reset',
			auth: 'public',
			idempotent: 'no-store',
			rateLimit: AUTH_LIMIT,
			handler: async (c) =>
				ok(await accounts.requestPasswordReset('merchant', valid(inputs.emailOnly(c.body))), { status: 202 }),
		},
		{
			method: 'POST',
			path: '/v1/auth/merchant/password-reset/confirm',
			auth: 'public',
			idempotent: 'no-store',
			rateLimit: AUTH_LIMIT,
			handler: async (c) => {
				await accounts.confirmPasswordReset('merchant', valid(inputs.resetConfirm(c.body)), metaOf(c));
				return noContent();
			},
		},
		{
			method: 'POST',
			path: '/v1/auth/invites/accept',
			auth: 'public',
			idempotent: 'no-store',
			rateLimit: AUTH_LIMIT,
			handler: async (c) => withCookie(await accounts.acceptInvite(valid(inputs.inviteAccept(c.body)), metaOf(c))),
		},

		// ---------------------------------------------------------------------------------------------------------
		// Staff auth
		{
			method: 'POST',
			path: '/v1/auth/staff/login',
			auth: 'public',
			idempotent: 'no-store',
			rateLimit: AUTH_LIMIT,
			handler: async (c) => withCookie(await accounts.staffLogin(valid(inputs.staffLogin(c.body)), metaOf(c))),
		},
		{
			method: 'POST',
			path: '/v1/auth/staff/mfa/verify',
			auth: 'staff',
			mfa: false,
			idempotent: 'no-store',
			rateLimit: AUTH_LIMIT,
			handler: async (c) =>
				withCookie(
					await accounts.staffVerifyMfa(
						{ ...valid(inputs.mfaCode(c.body)), session: sessionOf(c), token: tokenOf(c, 'staff') },
						metaOf(c),
					),
				),
		},
		{
			method: 'POST',
			path: '/v1/auth/staff/mfa/enrol',
			auth: 'staff',
			mfa: false,
			idempotent: 'no-store',
			handler: async (c) => ok(await accounts.mfaEnrol('staff', sessionOf(c).subject)),
		},
		{
			method: 'POST',
			path: '/v1/auth/staff/mfa/confirm',
			auth: 'staff',
			mfa: false,
			idempotent: 'no-store',
			rateLimit: AUTH_LIMIT,
			handler: async (c) =>
				withCookie(
					await accounts.mfaConfirm(
						'staff',
						{ ...valid(inputs.mfaConfirm(c.body)), id: sessionOf(c).subject, token: tokenOf(c, 'staff') },
						metaOf(c),
					),
				),
		},
		{
			method: 'POST',
			path: '/v1/auth/staff/logout',
			auth: 'staff',
			mfa: false,
			idempotent: false,
			handler: async (c) => noContent({ cookies: [(await accounts.logout('staff', tokenOf(c, 'staff'))).cookie] }),
		},
		{
			method: 'POST',
			path: '/v1/auth/staff/password-reset',
			auth: 'public',
			idempotent: 'no-store',
			rateLimit: AUTH_LIMIT,
			handler: async (c) => ok(await accounts.requestPasswordReset('staff', valid(inputs.emailOnly(c.body))), { status: 202 }),
		},
		{
			method: 'POST',
			path: '/v1/auth/staff/password-reset/confirm',
			auth: 'public',
			idempotent: 'no-store',
			rateLimit: AUTH_LIMIT,
			handler: async (c) => {
				await accounts.confirmPasswordReset('staff', valid(inputs.resetConfirm(c.body)), metaOf(c));
				return noContent();
			},
		},

		// ---------------------------------------------------------------------------------------------------------
		// Me
		{
			method: 'GET',
			path: '/v1/me',
			auth: ['staff', 'merchant'],
			handler: async (c) => ok(await accounts.me(sessionOf(c))),
		},
		{
			method: 'POST',
			path: '/v1/me/password',
			auth: ['staff', 'merchant'],
			idempotent: 'no-store',
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
			path: '/v1/me/merchant',
			auth: 'merchant',
			idempotent: 'no-store',
			handler: async (c) =>
				withCookie(
					await accounts.switchMerchant({
						...valid(inputs.switchMerchant(c.body)),
						session: sessionOf(c),
						token: tokenOf(c, 'merchant'),
					}),
				),
		},
		{
			method: 'POST',
			path: '/v1/me/mfa/enrol',
			auth: 'merchant',
			idempotent: 'no-store',
			handler: async (c) => ok(await accounts.mfaEnrol('merchant', sessionOf(c).subject)),
		},
		{
			method: 'POST',
			path: '/v1/me/mfa/confirm',
			auth: 'merchant',
			idempotent: 'no-store',
			handler: async (c) =>
				withCookie(
					await accounts.mfaConfirm(
						'merchant',
						{ ...valid(inputs.mfaConfirm(c.body)), id: sessionOf(c).subject, token: tokenOf(c, 'merchant') },
						metaOf(c),
					),
				),
		},
		{
			method: 'POST',
			path: '/v1/me/mfa/disable',
			auth: 'merchant',
			idempotent: 'no-store',
			handler: async (c) =>
				ok(await accounts.mfaDisable({ ...valid(inputs.mfaDisable(c.body)), id: sessionOf(c).subject }, metaOf(c))),
		},
		{
			method: 'POST',
			path: '/v1/me/mfa/recovery-codes',
			auth: ['staff', 'merchant'],
			idempotent: 'no-store',
			handler: async (c) =>
				ok(
					await accounts.regenerateRecoveryCodes(
						kindOf(c),
						{ ...valid(inputs.mfaCode(c.body)), id: sessionOf(c).subject },
						metaOf(c),
					),
				),
		},
		{
			method: 'GET',
			path: '/v1/me/sessions',
			auth: ['staff', 'merchant'],
			handler: async (c) => ok({ items: await accounts.listSessions(sessionOf(c)) }),
		},
		{
			method: 'DELETE',
			path: '/v1/me/sessions/:sessionId',
			auth: ['staff', 'merchant'],
			handler: async (c) => {
				await accounts.revokeSession(sessionOf(c), /** @type {string} */ (c.params.sessionId));
				return noContent();
			},
		},

		// ---------------------------------------------------------------------------------------------------------
		// Merchant console
		{
			method: 'GET',
			path: '/v1/merchants/:merchantId',
			auth: ['merchant', 'staff'],
			permission: 'merchant.read',
			handler: async (c) => ok(await teams.getMerchant(ownMerchant(c))),
		},
		{
			method: 'PATCH',
			path: '/v1/merchants/:merchantId',
			auth: ['merchant', 'staff'],
			permission: 'merchant.settings.write',
			handler: async (c) =>
				ok(
					await teams.renameMerchant({
						merchantId: ownMerchant(c),
						...valid(inputs.merchantUpdate(c.body)),
						actor: actorOf(c),
						meta: metaOf(c),
					}),
				),
		},
		{
			method: 'GET',
			path: '/v1/merchants/:merchantId/team',
			auth: ['merchant', 'staff'],
			permission: 'merchant.team.read',
			handler: async (c) => ok(await teams.listTeam(ownMerchant(c))),
		},
		{
			method: 'POST',
			path: '/v1/merchants/:merchantId/team/invites',
			auth: ['merchant', 'staff'],
			permission: 'merchant.team.manage',
			handler: async (c) =>
				created(
					await teams.invite({
						merchantId: ownMerchant(c),
						...valid(inputs.invite(c.body)),
						actor: actorOf(c),
						meta: metaOf(c),
					}),
				),
		},
		{
			method: 'DELETE',
			path: '/v1/merchants/:merchantId/team/invites/:inviteId',
			auth: ['merchant', 'staff'],
			permission: 'merchant.team.manage',
			handler: async (c) => {
				await teams.revokeInvite({
					merchantId: ownMerchant(c),
					inviteId: /** @type {string} */ (c.params.inviteId),
					actor: actorOf(c),
					meta: metaOf(c),
				});
				return noContent();
			},
		},
		{
			method: 'PATCH',
			path: '/v1/merchants/:merchantId/team/members/:userId',
			auth: ['merchant', 'staff'],
			permission: 'merchant.team.manage',
			handler: async (c) =>
				ok(
					await teams.updateMember({
						merchantId: ownMerchant(c),
						userId: /** @type {string} */ (c.params.userId),
						...valid(inputs.memberUpdate(c.body)),
						actor: actorOf(c),
						meta: metaOf(c),
					}),
				),
		},
		{
			method: 'DELETE',
			path: '/v1/merchants/:merchantId/team/members/:userId',
			auth: ['merchant', 'staff'],
			permission: 'merchant.team.manage',
			handler: async (c) => {
				await teams.removeMember({
					merchantId: ownMerchant(c),
					userId: /** @type {string} */ (c.params.userId),
					actor: actorOf(c),
					meta: metaOf(c),
				});
				return noContent();
			},
		},
		{
			method: 'POST',
			path: '/v1/merchants/:merchantId/owner/transfer',
			auth: ['merchant', 'staff'],
			permission: 'merchant.owner.transfer',
			idempotent: 'no-store',
			handler: async (c) =>
				ok(
					await teams.transferOwnership({
						merchantId: ownMerchant(c),
						...valid(inputs.ownerTransfer(c.body)),
						actor: actorOf(c),
						meta: metaOf(c),
					}),
				),
		},
		{
			method: 'GET',
			path: '/v1/merchants/:merchantId/websites',
			auth: ['merchant', 'staff'],
			handler: async (c) => {
				const merchantId = ownMerchant(c);
				const visible = ctx.rbac.websitesVisible(actorOf(c), 'websites.read');
				if (visible !== 'all' && visible.length === 0) throw problem('forbidden', 'Missing permission websites.read.');
				const all = await websites.listWebsites(merchantId);
				const items =
					visible === 'all' ? all : all.filter((w) => visible.includes(w.env === 'live' ? w.websiteId : String(w.twinId)));
				return ok({ items });
			},
		},
		{
			method: 'POST',
			path: '/v1/merchants/:merchantId/websites',
			auth: ['merchant', 'staff'],
			permission: 'websites.create',
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
			auth: ['merchant', 'staff'],
			handler: async (c) => {
				const { website } = await authorizedWebsite(c, 'websites.read');
				return ok(await websites.getWebsite(String(website._id), String(website.merchantId)));
			},
		},
		{
			method: 'DELETE',
			path: '/v1/merchants/:merchantId/websites/:websiteId',
			auth: ['merchant', 'staff'],
			handler: async (c) => {
				const { merchantId, website } = await authorizedWebsite(c, 'websites.delete');
				return ok(
					await websites.deleteWebsite({ merchantId, websiteId: String(website._id), actor: actorOf(c), meta: metaOf(c) }),
				);
			},
		},
		{
			method: 'GET',
			path: '/v1/merchants/:merchantId/websites/:websiteId/keys',
			auth: ['merchant', 'staff'],
			handler: async (c) => {
				const { merchantId, website } = await authorizedWebsite(c, 'keys.read');
				return ok({ items: await keys.listKeys({ merchantId, websiteId: String(website._id) }) });
			},
		},
		{
			method: 'POST',
			path: '/v1/merchants/:merchantId/websites/:websiteId/keys',
			auth: ['merchant', 'staff'],
			idempotent: 'no-store',
			handler: async (c) => {
				const body = valid(inputs.keyIssue(c.body));
				const { merchantId, website } = await authorizedWebsite(c, 'keys.manage');
				return created(
					await keys.issueKey({
						merchantId,
						websiteId: String(website._id),
						kind: body.kind,
						scopes: body.scopes,
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
			auth: ['merchant', 'staff'],
			idempotent: 'no-store',
			handler: async (c) => {
				const body = valid(inputs.keyRotate(c.body));
				const { merchantId, website } = await authorizedWebsite(c, 'keys.manage');
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
			auth: ['merchant', 'staff'],
			handler: async (c) => {
				const body = valid(inputs.keyRevoke(c.body));
				const { merchantId, website } = await authorizedWebsite(c, 'keys.manage');
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
		// Admin (staff)
		{
			method: 'GET',
			path: '/v1/admin/merchants',
			auth: 'staff',
			permission: 'platform.merchants.read',
			handler: async (c) => {
				const page = paginate({ cursor: c.query.cursor, limit: c.query.limit, url: c.request.url });
				const status = c.query.status === 'active' || c.query.status === 'suspended' ? c.query.status : undefined;
				const rows = await admin.listMerchants({
					after: typeof page.after === 'string' ? page.after : null,
					limit: page.fetchLimit,
					...(status ? { status } : {}),
				});
				return page.respond(rows, (m) => String(m._id), admin.presentMerchant);
			},
		},
		{
			method: 'GET',
			path: '/v1/admin/merchants/:merchantId',
			auth: 'staff',
			permission: 'platform.merchants.read',
			handler: async (c) => {
				const merchantId = /** @type {string} */ (c.params.merchantId);
				return ok({ ...(await teams.getMerchant(merchantId)), websites: await websites.listWebsites(merchantId) });
			},
		},
		{
			method: 'POST',
			path: '/v1/admin/merchants/:merchantId/suspend',
			auth: 'staff',
			permission: 'platform.merchants.write',
			handler: async (c) =>
				ok(
					await admin.suspendMerchant({
						merchantId: /** @type {string} */ (c.params.merchantId),
						...valid(inputs.reason(c.body)),
						actor: actorOf(c),
						meta: metaOf(c),
					}),
				),
		},
		{
			method: 'POST',
			path: '/v1/admin/merchants/:merchantId/resume',
			auth: 'staff',
			permission: 'platform.merchants.write',
			handler: async (c) =>
				ok(
					await admin.resumeMerchant({
						merchantId: /** @type {string} */ (c.params.merchantId),
						...valid(inputs.reason(c.body)),
						actor: actorOf(c),
						meta: metaOf(c),
					}),
				),
		},
		{
			method: 'GET',
			path: '/v1/admin/websites',
			auth: 'staff',
			permission: 'platform.merchants.read',
			handler: async (c) => {
				const env = c.query.env === 'test' ? 'test' : 'live';
				const website = await websites.websiteByDomain(String(c.query.domain ?? ''), { env });
				return ok({ items: website ? [website] : [] });
			},
		},
		{
			method: 'POST',
			path: '/v1/admin/websites/:websiteId/transfer',
			auth: 'staff',
			permission: 'platform.merchants.write',
			handler: async (c) =>
				ok(
					await websites.transferWebsite({
						websiteId: /** @type {string} */ (c.params.websiteId),
						...valid(inputs.websiteTransfer(c.body)),
						actor: actorOf(c),
						meta: metaOf(c),
					}),
				),
		},
		{
			method: 'GET',
			path: '/v1/admin/staff',
			auth: 'staff',
			permission: 'platform.staff.manage',
			handler: async () => ok({ items: await admin.listStaff() }),
		},
		{
			method: 'POST',
			path: '/v1/admin/staff',
			auth: 'staff',
			permission: 'platform.staff.manage',
			handler: async (c) =>
				created(await admin.createStaff({ ...valid(inputs.staffCreate(c.body)), actor: actorOf(c), meta: metaOf(c) })),
		},
		{
			method: 'PATCH',
			path: '/v1/admin/staff/:staffId',
			auth: 'staff',
			permission: 'platform.staff.manage',
			handler: async (c) =>
				ok(
					await admin.updateStaff({
						staffId: /** @type {string} */ (c.params.staffId),
						...valid(inputs.staffUpdate(c.body)),
						actor: actorOf(c),
						meta: metaOf(c),
					}),
				),
		},
		{
			method: 'POST',
			path: '/v1/admin/staff/:staffId/mfa/reset',
			auth: 'staff',
			permission: 'platform.staff.manage',
			handler: async (c) => {
				await admin.resetStaffMfa({
					staffId: /** @type {string} */ (c.params.staffId),
					...valid(inputs.reason(c.body)),
					actor: actorOf(c),
					meta: metaOf(c),
				});
				return noContent();
			},
		},
		{
			method: 'GET',
			path: '/v1/admin/partners',
			auth: 'staff',
			permission: 'platform.merchants.read',
			handler: async () => ok({ items: await admin.partners.list() }),
		},
		{
			method: 'POST',
			path: '/v1/admin/partners',
			auth: 'staff',
			permission: 'platform.merchants.write',
			handler: async (c) =>
				created(await admin.partners.create({ ...valid(inputs.party(c.body)), actor: actorOf(c), meta: metaOf(c) })),
		},
		{
			method: 'POST',
			path: '/v1/admin/partners/:partnerId/grants',
			auth: 'staff',
			permission: 'platform.merchants.write',
			handler: async (c) => {
				const { merchantId, roles = ['admin'] } = valid(inputs.partnerGrant(c.body));
				await teams.loadMerchant(merchantId);
				return ok(
					await admin.partners.grant({
						id: /** @type {string} */ (c.params.partnerId),
						grant: { merchantId, roles },
						match: { merchantId },
						actor: actorOf(c),
						meta: metaOf(c),
					}),
				);
			},
		},
		{
			method: 'DELETE',
			path: '/v1/admin/partners/:partnerId/grants/:merchantId',
			auth: 'staff',
			permission: 'platform.merchants.write',
			handler: async (c) => {
				await admin.partners.ungrant({
					id: /** @type {string} */ (c.params.partnerId),
					match: { merchantId: /** @type {string} */ (c.params.merchantId) },
					actor: actorOf(c),
					meta: metaOf(c),
				});
				return noContent();
			},
		},
		{
			method: 'GET',
			path: '/v1/admin/developers',
			auth: 'staff',
			permission: 'platform.apps.read',
			handler: async () => ok({ items: await admin.developers.list() }),
		},
		{
			method: 'POST',
			path: '/v1/admin/developers',
			auth: 'staff',
			permission: 'platform.apps.manage',
			handler: async (c) =>
				created(await admin.developers.create({ ...valid(inputs.party(c.body)), actor: actorOf(c), meta: metaOf(c) })),
		},
		{
			method: 'POST',
			path: '/v1/admin/developers/:developerId/grants',
			auth: 'staff',
			permission: 'platform.apps.manage',
			handler: async (c) => {
				const { appId } = valid(inputs.developerGrant(c.body));
				return ok(
					await admin.developers.grant({
						id: /** @type {string} */ (c.params.developerId),
						grant: { appId },
						match: { appId },
						actor: actorOf(c),
						meta: metaOf(c),
					}),
				);
			},
		},
		{
			method: 'DELETE',
			path: '/v1/admin/developers/:developerId/grants/:appId',
			auth: 'staff',
			permission: 'platform.apps.manage',
			handler: async (c) => {
				await admin.developers.ungrant({
					id: /** @type {string} */ (c.params.developerId),
					match: { appId: /** @type {string} */ (c.params.appId) },
					actor: actorOf(c),
					meta: metaOf(c),
				});
				return noContent();
			},
		},

		// ---------------------------------------------------------------------------------------------------------
		// Product API (F.9)
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
