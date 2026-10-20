/**
 * Accounts' routes (the kit adds its own: connect, notices, tickets, data rights, permissions, widget config, `/sso`
 * and the dashboard API). Every browser-token, server-token and ticket route belongs to one feature, or (the routes of
 * a signed-in user) to any sign-in method; `openapi.json` is generated from these definitions (`ss app assets`), so
 * `method`, `path`, `auth`, `feature` and `permission` stay literals. Public entry `./routes` of this package:
 * `product.handler(createRoutes(product))`.
 * @module
 */
import { checkStaff, defineRoute, problem } from '@ss/app-kit';
import { createAccount } from './account.js';
import { renderDocs } from './docs.js';
import { createFlows } from './flows.js';
import { createManage } from './manage.js';
import { createService } from './service.js';
import { WIDGET_SCRIPT } from './widget-script.js';

/** @typedef {import('../adapters/product.js').Product} Product */

/** Rate limits of sign-in routes (code constants protecting our hosting). */
const VISITOR_LIMITS = [
	{ limit: 300, windowSeconds: 60, per: /** @type {const} */ ('website') },
	{ limit: 20, windowSeconds: 60, per: /** @type {const} */ ('visitor') },
];
/** Routes that send a message or check a secret: stricter per visitor. */
const SENSITIVE_LIMITS = [
	{ limit: 120, windowSeconds: 60, per: /** @type {const} */ ('website') },
	{ limit: 6, windowSeconds: 60, per: /** @type {const} */ ('visitor') },
];
const PUBLIC_LIMITS = [{ limit: 60, windowSeconds: 60, per: /** @type {const} */ ('visitor') }];

/**
 * @param {Product} product
 */
export const createRoutes = (product) => {
	const service = createService(product);
	const flows = createFlows(product, service);
	const account = createAccount(product, service, flows);
	const manage = createManage(product, service, flows);

	/**
	 * The user lookups the other products make through the Portal's link to Accounts (staff alerts and Chat's picker ask who has
	 * a permission, Ecommerce asks whether an email address or phone number is a member and reads one user): a call with the
	 * server token alone may ask for a narrow answer only: a permission, an exact phone or email address, a search of at
	 * least 6 characters with at most 10 results, or one user by id. It gets the small view of at most 10 users and no cursor
	 * (SR-4-2). Listing or browsing users, and the whole view of a user (notes, tags, lock times), is the signed-in staff
	 * member's (`users.read`).
	 * @param {(ctx: any) => unknown} staffHandler @param {(ctx: any) => unknown} narrowHandler
	 * @param {boolean} [byId] every call may be narrow (one user by id)
	 */
	const narrowOrStaff =
		(staffHandler, narrowHandler, byId = false) =>
		async (/** @type {any} */ ctx) => {
			const refused = await checkStaff(ctx, { productId: 'accounts', permission: 'users.read' });
			if (!refused) return staffHandler(ctx);
			const { permission, phone, email, q, limit } = ctx.query;
			const narrow =
				byId ||
				Boolean(permission || phone || email) ||
				(typeof q === 'string' && q.length >= 6 && Number(limit ?? Infinity) <= 10);
			if (!narrow) throw refused;
			return narrowHandler(ctx);
		};

	/** The website's public keys for verifying sign-ins (no token: the merchant's server and products fetch them). @param {any} ctx */
	const keys = async (ctx) => {
		const websiteId = String(ctx.params.websiteId);
		const serving = /^web_[0-9a-z]{10,64}$/.test(websiteId) ? await product.serving(websiteId, { after: ctx.after }) : null;
		if (!serving?.ok) return problem('not_found', 'No such website.');
		/** @type {import('@ss/app-kit').WebsiteData} */
		let data;
		try {
			data = await product.data.forWebsite(websiteId, { merchantId: serving.status.merchantId });
		} catch {
			return problem('database_not_connected', 'Connect the merchant database in the product dashboard first.');
		}
		const base = product.address() ?? new URL(ctx.request.url).origin;
		const s = await service.siteOf({
			websiteId,
			merchantId: serving.status.merchantId,
			domain: serving.status.domain,
			base,
			data,
		});
		const { publicJwk } = await service.signingKey(s);
		return new Response(JSON.stringify({ issuer: base, keys: [publicJwk] }), {
			headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' },
		});
	};

	return [
		// the widgets' script: public and the same for every website (no token, no Origin needed)
		defineRoute({
			method: 'GET',
			path: '/widget.js',
			auth: 'none',
			handler: () =>
				new Response(WIDGET_SCRIPT, {
					headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=300' },
				}),
		}),
		// public keys of a website's sign-ins (offline verification)
		defineRoute({ method: 'GET', path: '/v1/websites/:websiteId/keys', auth: 'none', rateLimit: PUBLIC_LIMITS, handler: keys }),

		// --------------------------------------------------------------------------------------- email + password
		defineRoute({
			method: 'POST',
			path: '/v1/sign-up/password',
			auth: 'browser',
			feature: 'email_password',
			rateLimit: SENSITIVE_LIMITS,
			handler: flows.passwordSignUp,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/sign-in/password',
			auth: 'browser',
			feature: 'email_password',
			rateLimit: VISITOR_LIMITS,
			handler: flows.passwordSignIn,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/password/forgot',
			auth: 'browser',
			feature: 'email_password',
			rateLimit: SENSITIVE_LIMITS,
			handler: flows.forgotPassword,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/password/reset',
			auth: 'browser',
			feature: 'email_password',
			rateLimit: SENSITIVE_LIMITS,
			handler: flows.resetPassword,
		}),

		// ---------------------------------------------------------------------------- phone + password (A2)
		defineRoute({
			method: 'POST',
			path: '/v1/sign-up/phone-password',
			auth: 'browser',
			feature: 'phone_password',
			rateLimit: SENSITIVE_LIMITS,
			handler: flows.phonePasswordSignUp,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/sign-in/phone-password',
			auth: 'browser',
			feature: 'phone_password',
			rateLimit: VISITOR_LIMITS,
			handler: flows.phonePasswordSignIn,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/password/phone/forgot',
			auth: 'browser',
			feature: 'phone_password',
			rateLimit: SENSITIVE_LIMITS,
			handler: flows.phoneForgot,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/password/phone/reset',
			auth: 'browser',
			feature: 'phone_password',
			rateLimit: SENSITIVE_LIMITS,
			handler: flows.phoneReset,
		}),

		// ------------------------------------------------------------------- setup links and role requests (A3, A5)
		defineRoute({
			method: 'POST',
			path: '/v1/setup-links/accept',
			auth: 'browser',
			feature: ['staff_links', 'role_requests'],
			rateLimit: SENSITIVE_LIMITS,
			handler: flows.acceptSetup,
		}),
		// what a setup page shows before the password (the code in the body: it stays out of addresses and logs)
		defineRoute({
			method: 'POST',
			path: '/v1/setup-links/lookup',
			auth: 'browser',
			feature: ['staff_links', 'role_requests'],
			rateLimit: SENSITIVE_LIMITS,
			handler: flows.lookupSetup,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/role-requests',
			auth: 'browser',
			feature: 'role_requests',
			rateLimit: SENSITIVE_LIMITS,
			handler: manage.requestRole,
		}),

		// ------------------------------------------------------------------------------------------- phone code
		defineRoute({
			method: 'POST',
			path: '/v1/sign-in/phone/code',
			auth: 'browser',
			feature: ['phone_code', 'phone_password'],
			rateLimit: SENSITIVE_LIMITS,
			handler: flows.phoneCodeRequest,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/sign-in/phone',
			auth: 'browser',
			feature: 'phone_code',
			rateLimit: VISITOR_LIMITS,
			handler: flows.phoneCodeSignIn,
		}),

		// --------------------------------------------------------------------------- email code and magic link
		defineRoute({
			method: 'POST',
			path: '/v1/sign-in/email/code',
			auth: 'browser',
			feature: 'email_code',
			rateLimit: SENSITIVE_LIMITS,
			handler: flows.emailCodeRequest,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/sign-in/email',
			auth: 'browser',
			feature: 'email_code',
			rateLimit: VISITOR_LIMITS,
			handler: flows.emailCodeSignIn,
		}),

		// --------------------------------------------------------------------------------------- social sign-in
		defineRoute({
			method: 'POST',
			path: '/v1/sign-in/google/start',
			auth: 'browser',
			feature: 'google',
			rateLimit: VISITOR_LIMITS,
			handler: flows.socialStart('google'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/sign-in/apple/start',
			auth: 'browser',
			feature: 'apple',
			rateLimit: VISITOR_LIMITS,
			handler: flows.socialStart('apple'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/sign-in/facebook/start',
			auth: 'browser',
			feature: 'facebook',
			rateLimit: VISITOR_LIMITS,
			handler: flows.socialStart('facebook'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/sign-in/exchange',
			auth: 'browser',
			feature: ['google', 'apple', 'facebook'],
			rateLimit: VISITOR_LIMITS,
			handler: flows.socialExchange,
		}),
		defineRoute({
			method: 'GET',
			path: '/oauth/google/callback',
			auth: 'none',
			rateLimit: PUBLIC_LIMITS,
			handler: flows.socialCallback('google'),
		}),
		defineRoute({
			method: 'POST',
			path: '/oauth/apple/callback',
			auth: 'none',
			rawBody: true,
			maxBodyBytes: 16 * 1024,
			rateLimit: PUBLIC_LIMITS,
			handler: flows.socialCallback('apple'),
		}),
		defineRoute({
			method: 'GET',
			path: '/oauth/facebook/callback',
			auth: 'none',
			rateLimit: PUBLIC_LIMITS,
			handler: flows.socialCallback('facebook'),
		}),

		// --------------------------------------------------------------------------- two-step, invites, sessions
		defineRoute({
			method: 'POST',
			path: '/v1/sign-in/two-step',
			auth: 'browser',
			feature: 'two_step',
			rateLimit: SENSITIVE_LIMITS,
			handler: flows.twoStep,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/invites/accept',
			auth: 'browser',
			feature: 'approval',
			rateLimit: SENSITIVE_LIMITS,
			handler: flows.acceptInvite,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/session/refresh',
			auth: 'browser',
			feature: ['phone_code', 'phone_password', 'email_password', 'email_code', 'google', 'apple', 'facebook'],
			rateLimit: VISITOR_LIMITS,
			handler: flows.refresh,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/session/sign-out',
			auth: 'browser',
			feature: ['phone_code', 'phone_password', 'email_password', 'email_code', 'google', 'apple', 'facebook'],
			rateLimit: VISITOR_LIMITS,
			handler: flows.signOut,
		}),

		// ------------------------------------------------------------------------- My account (signed-in user)
		defineRoute({
			method: 'GET',
			path: '/v1/me',
			auth: 'browser',
			feature: ['phone_code', 'phone_password', 'email_password', 'email_code', 'google', 'apple', 'facebook'],
			rateLimit: VISITOR_LIMITS,
			handler: account.me,
		}),
		// the same profile for another product of the website that holds the signed-in person's sign-in (Ecommerce asks for
		// the shopper's name and city): the server token or a link key with the scope me.read, the sign-in in SS-Sign-In
		defineRoute({
			method: 'GET',
			path: '/v1/lookup/me',
			auth: 'server',
			runtime: true,
			scope: 'me.read',
			feature: ['phone_code', 'phone_password', 'email_password', 'email_code', 'google', 'apple', 'facebook'],
			handler: account.me,
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/me',
			auth: 'browser',
			feature: ['phone_code', 'phone_password', 'email_password', 'email_code', 'google', 'apple', 'facebook'],
			rateLimit: VISITOR_LIMITS,
			handler: account.updateMe,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/me/sessions',
			auth: 'browser',
			feature: ['phone_code', 'phone_password', 'email_password', 'email_code', 'google', 'apple', 'facebook'],
			rateLimit: VISITOR_LIMITS,
			handler: account.sessions,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/me/sessions/:id',
			auth: 'browser',
			feature: ['phone_code', 'phone_password', 'email_password', 'email_code', 'google', 'apple', 'facebook'],
			rateLimit: VISITOR_LIMITS,
			handler: account.signOutDevice,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/me/sign-out-everywhere',
			auth: 'browser',
			feature: ['phone_code', 'phone_password', 'email_password', 'email_code', 'google', 'apple', 'facebook'],
			rateLimit: VISITOR_LIMITS,
			handler: account.signOutEverywhere,
		}),
		// a fresh code for the user without a password: it proves the person for the password and two-step changes (SR-4-5)
		defineRoute({
			method: 'POST',
			path: '/v1/me/confirm-code',
			auth: 'browser',
			feature: ['email_password', 'phone_password', 'two_step'],
			rateLimit: SENSITIVE_LIMITS,
			handler: account.confirmCode,
		}),
		defineRoute({
			method: 'PUT',
			path: '/v1/me/password',
			auth: 'browser',
			feature: ['email_password', 'phone_password'],
			rateLimit: SENSITIVE_LIMITS,
			handler: account.changePassword,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/me/two-step/setup',
			auth: 'browser',
			feature: 'two_step',
			rateLimit: VISITOR_LIMITS,
			handler: account.twoStepSetup,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/me/two-step/enable',
			auth: 'browser',
			feature: 'two_step',
			rateLimit: SENSITIVE_LIMITS,
			handler: account.twoStepEnable,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/me/two-step/disable',
			auth: 'browser',
			feature: 'two_step',
			rateLimit: SENSITIVE_LIMITS,
			handler: account.twoStepDisable,
		}),
		// new recovery codes (K-27): a code from the app or a recovery code proves the second step again
		defineRoute({
			method: 'POST',
			path: '/v1/me/two-step/recovery-codes',
			auth: 'browser',
			feature: 'two_step',
			rateLimit: SENSITIVE_LIMITS,
			handler: account.newRecoveryCodes,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/me/consents',
			auth: 'browser',
			feature: 'consents',
			rateLimit: VISITOR_LIMITS,
			handler: account.saveConsents,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/me/export',
			auth: 'browser',
			feature: 'data_rights',
			rateLimit: SENSITIVE_LIMITS,
			handler: account.exportData,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/me/delete',
			auth: 'browser',
			feature: 'data_rights',
			rateLimit: SENSITIVE_LIMITS,
			handler: account.requestDeletion,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/me/orders',
			auth: 'browser',
			feature: 'orders_tab',
			rateLimit: VISITOR_LIMITS,
			handler: account.orders,
		}),
		// the data export's single-use download link (15 minutes)
		defineRoute({
			method: 'GET',
			path: '/v1/exports/:websiteId/:token',
			auth: 'none',
			rateLimit: PUBLIC_LIMITS,
			handler: account.download,
		}),

		// ------------------------------------------------------------------- the merchant's server (server token)
		defineRoute({
			method: 'GET',
			path: '/v1/users',
			auth: 'server',
			scope: 'users.read',
			runtime: true,
			feature: 'roles',
			handler: narrowOrStaff(manage.listUsers, manage.listUsersNarrow),
		}),
		// counts with the list's filters (PLAN 0.8.10 K4)
		defineRoute({
			method: 'GET',
			path: '/v1/users/count',
			auth: 'server',
			permission: 'users.read',
			feature: 'roles',
			handler: manage.countUsers,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/users/counts',
			auth: 'server',
			permission: 'users.read',
			feature: 'roles',
			handler: manage.countUsersBy,
		}),
		// tags and saved views of the users list (A5)
		defineRoute({
			method: 'GET',
			path: '/v1/users/tags',
			auth: 'server',
			permission: 'users.read',
			feature: 'roles',
			handler: manage.listTags,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/users/views',
			auth: 'server',
			permission: 'users.read',
			feature: 'roles',
			handler: manage.listViews,
		}),
		defineRoute({
			method: 'PUT',
			path: '/v1/users/views',
			auth: 'server',
			permission: 'users.manage',
			feature: 'roles',
			handler: manage.orderViews,
		}),
		defineRoute({
			method: 'PUT',
			path: '/v1/users/views/:key',
			auth: 'server',
			permission: 'users.manage',
			feature: 'roles',
			handler: manage.saveView,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/users/views/:key',
			auth: 'server',
			permission: 'users.manage',
			feature: 'roles',
			handler: manage.deleteView,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/users',
			auth: 'server',
			permission: 'users.manage',
			feature: 'roles',
			idempotent: true,
			handler: manage.createUser,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/users/:id',
			auth: 'server',
			scope: 'users.read',
			runtime: true,
			feature: 'roles',
			handler: narrowOrStaff(manage.getUser, manage.getUserNarrow, true),
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/users/:id',
			auth: 'server',
			permission: 'users.manage',
			feature: 'roles',
			handler: manage.updateUser,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/users/:id',
			auth: 'server',
			permission: 'users.manage',
			feature: 'roles',
			handler: manage.deleteUser,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/users/:id/sign-in-code',
			auth: 'server',
			permission: 'users.manage',
			feature: 'staff_links',
			handler: manage.signInCode,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/users/:id/setup-link',
			auth: 'server',
			permission: 'users.manage',
			feature: 'staff_links',
			handler: manage.setupLink,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/role-requests',
			auth: 'server',
			permission: 'users.read',
			feature: 'role_requests',
			handler: manage.listRequests,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/role-requests/count',
			auth: 'server',
			permission: 'users.read',
			feature: 'role_requests',
			handler: manage.countRequests,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/role-requests/counts',
			auth: 'server',
			permission: 'users.read',
			feature: 'role_requests',
			handler: manage.countRequestsBy,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/role-requests/:id',
			auth: 'server',
			permission: 'users.read',
			feature: 'role_requests',
			handler: manage.readRequest,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/role-requests/:id/invite',
			auth: 'server',
			permission: 'users.manage',
			feature: 'role_requests',
			handler: manage.inviteRequest,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/role-requests/:id/setup-link',
			auth: 'server',
			permission: 'users.manage',
			feature: 'role_requests',
			handler: manage.renewRequestLink,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/role-requests/:id/decline',
			auth: 'server',
			permission: 'users.manage',
			feature: 'role_requests',
			handler: manage.declineRequest,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/role-requests/:id/reopen',
			auth: 'server',
			permission: 'users.manage',
			feature: 'role_requests',
			handler: manage.reopenRequest,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/users/:id/sign-out',
			auth: 'server',
			permission: 'users.manage',
			feature: 'roles',
			handler: manage.signOutUser,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/users/invite',
			auth: 'server',
			permission: 'users.manage',
			feature: 'approval',
			idempotent: true,
			handler: manage.invite,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/users/:id/approve',
			auth: 'server',
			permission: 'users.manage',
			feature: 'approval',
			handler: manage.approve,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/users/:id/decline',
			auth: 'server',
			permission: 'users.manage',
			feature: 'approval',
			handler: manage.decline,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/users/:id/deletion/approve',
			auth: 'server',
			permission: 'users.manage',
			feature: 'data_rights',
			handler: manage.approveDeletion,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/users/:id/deletion/reject',
			auth: 'server',
			permission: 'users.manage',
			feature: 'data_rights',
			handler: manage.rejectDeletion,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/consents',
			auth: 'server',
			permission: 'users.read',
			feature: 'consents',
			handler: manage.consentList,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/fields',
			auth: 'server',
			permission: 'users.read',
			feature: 'custom_fields',
			handler: manage.customFields,
		}),
		// the definitions a user sees, public (the merchant's own sign-up and My account pages); the route above is the staff's
		defineRoute({
			method: 'GET',
			path: '/v1/fields/public',
			auth: 'browser',
			feature: 'custom_fields',
			rateLimit: PUBLIC_LIMITS,
			handler: manage.publicFields,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/roles',
			auth: 'server',
			scope: 'roles.read',
			runtime: true,
			feature: 'roles',
			handler: manage.listRoles,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/roles/permissions',
			auth: 'server',
			permission: 'roles.manage',
			feature: 'roles',
			handler: manage.catalog,
		}),
		defineRoute({
			method: 'PUT',
			path: '/v1/roles/permissions',
			auth: 'server',
			permission: 'roles.manage',
			feature: 'roles',
			handler: manage.saveOwnPermissions,
		}),
		defineRoute({
			method: 'PUT',
			path: '/v1/roles/:key',
			auth: 'server',
			permission: 'roles.manage',
			feature: 'roles',
			handler: manage.saveRole,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/roles/:key',
			auth: 'server',
			permission: 'roles.manage',
			feature: 'roles',
			handler: manage.deleteRole,
		}),
		// activity-log copies: other products send them with this website's Accounts token; the merchant's server reads them
		defineRoute({
			method: 'POST',
			path: '/v1/activity-copies',
			auth: 'server',
			scope: 'activity.write',
			runtime: true,
			feature: 'activity_copies',
			handler: manage.receiveCopy,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/activity-copies',
			auth: 'server',
			permission: 'activity.read',
			feature: 'activity_copies',
			handler: manage.listCopies,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/activity-copies/count',
			auth: 'server',
			permission: 'activity.read',
			feature: 'activity_copies',
			handler: manage.countCopies,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/activity-copies/counts',
			auth: 'server',
			permission: 'activity.read',
			feature: 'activity_copies',
			handler: manage.countCopiesBy,
		}),

		// --------------------------------------------------------------- admin widgets: Users and Roles (tickets)
		defineRoute({
			method: 'GET',
			path: '/v1/admin/activity-copies',
			auth: 'ticket',
			permission: 'activity.read',
			handler: manage.listCopies,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/activity-copies/count',
			auth: 'ticket',
			permission: 'activity.read',
			handler: manage.countCopies,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/activity-copies/counts',
			auth: 'ticket',
			permission: 'activity.read',
			handler: manage.countCopiesBy,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/users',
			auth: 'ticket',
			permission: 'users.read',
			handler: manage.listUsers,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/users/count',
			auth: 'ticket',
			permission: 'users.read',
			handler: manage.countUsers,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/users/counts',
			auth: 'ticket',
			permission: 'users.read',
			handler: manage.countUsersBy,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/users/tags',
			auth: 'ticket',
			permission: 'users.read',
			handler: manage.listTags,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/users/views',
			auth: 'ticket',
			permission: 'users.read',
			handler: manage.listViews,
		}),
		defineRoute({
			method: 'PUT',
			path: '/v1/admin/users/views',
			auth: 'ticket',
			permission: 'users.manage',
			handler: manage.orderViews,
		}),
		defineRoute({
			method: 'PUT',
			path: '/v1/admin/users/views/:key',
			auth: 'ticket',
			permission: 'users.manage',
			handler: manage.saveView,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/admin/users/views/:key',
			auth: 'ticket',
			permission: 'users.manage',
			handler: manage.deleteView,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/users/:id',
			auth: 'ticket',
			permission: 'users.read',
			handler: manage.getUser,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/users',
			auth: 'ticket',
			permission: 'users.manage',
			idempotent: true,
			handler: manage.createUser,
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/admin/users/:id',
			auth: 'ticket',
			permission: 'users.manage',
			handler: manage.updateUser,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/admin/users/:id',
			auth: 'ticket',
			permission: 'users.manage',
			handler: manage.deleteUser,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/users/:id/sign-in-code',
			auth: 'ticket',
			feature: 'staff_links',
			permission: 'users.manage',
			handler: manage.signInCode,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/users/:id/setup-link',
			auth: 'ticket',
			feature: 'staff_links',
			permission: 'users.manage',
			handler: manage.setupLink,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/role-requests',
			auth: 'ticket',
			feature: 'role_requests',
			permission: 'users.read',
			handler: manage.listRequests,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/role-requests/count',
			auth: 'ticket',
			feature: 'role_requests',
			permission: 'users.read',
			handler: manage.countRequests,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/role-requests/counts',
			auth: 'ticket',
			feature: 'role_requests',
			permission: 'users.read',
			handler: manage.countRequestsBy,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/role-requests/:id',
			auth: 'ticket',
			feature: 'role_requests',
			permission: 'users.read',
			handler: manage.readRequest,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/role-requests/:id/invite',
			auth: 'ticket',
			feature: 'role_requests',
			permission: 'users.manage',
			handler: manage.inviteRequest,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/role-requests/:id/setup-link',
			auth: 'ticket',
			feature: 'role_requests',
			permission: 'users.manage',
			handler: manage.renewRequestLink,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/role-requests/:id/decline',
			auth: 'ticket',
			feature: 'role_requests',
			permission: 'users.manage',
			handler: manage.declineRequest,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/role-requests/:id/reopen',
			auth: 'ticket',
			feature: 'role_requests',
			permission: 'users.manage',
			handler: manage.reopenRequest,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/users/:id/sign-out',
			auth: 'ticket',
			permission: 'users.manage',
			handler: manage.signOutUser,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/users/invite',
			auth: 'ticket',
			feature: 'approval',
			permission: 'users.manage',
			idempotent: true,
			handler: manage.invite,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/users/:id/approve',
			auth: 'ticket',
			feature: 'approval',
			permission: 'users.manage',
			handler: manage.approve,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/users/:id/decline',
			auth: 'ticket',
			feature: 'approval',
			permission: 'users.manage',
			handler: manage.decline,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/users/:id/deletion/approve',
			auth: 'ticket',
			feature: 'data_rights',
			permission: 'users.manage',
			handler: manage.approveDeletion,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/users/:id/deletion/reject',
			auth: 'ticket',
			feature: 'data_rights',
			permission: 'users.manage',
			handler: manage.rejectDeletion,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/fields',
			auth: 'ticket',
			permission: 'users.read',
			feature: 'custom_fields',
			handler: manage.customFields,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/roles',
			auth: 'ticket',
			permission: 'users.read',
			handler: manage.listRoles,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/roles/permissions',
			auth: 'ticket',
			permission: 'roles.manage',
			handler: manage.catalog,
		}),
		defineRoute({
			method: 'PUT',
			path: '/v1/admin/roles/permissions',
			auth: 'ticket',
			permission: 'roles.manage',
			handler: manage.saveOwnPermissions,
		}),
		defineRoute({
			method: 'PUT',
			path: '/v1/admin/roles/:key',
			auth: 'ticket',
			permission: 'roles.manage',
			handler: manage.saveRole,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/admin/roles/:key',
			auth: 'ticket',
			permission: 'roles.manage',
			handler: manage.deleteRole,
		}),

		// ----------------------------------------------------------------------------- dashboard: consents (A2)
		defineRoute({
			method: 'GET',
			path: '/v1/dashboard/websites/:websiteId/consents',
			auth: 'dashboard',
			handler: manage.listConsents,
		}),
		defineRoute({
			method: 'PUT',
			path: '/v1/dashboard/websites/:websiteId/consents',
			auth: 'dashboard',
			handler: manage.orderConsents,
		}),
		defineRoute({
			method: 'PUT',
			path: '/v1/dashboard/websites/:websiteId/consents/:key',
			auth: 'dashboard',
			handler: manage.saveConsent,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/dashboard/websites/:websiteId/consents/:key',
			auth: 'dashboard',
			handler: manage.deleteConsent,
		}),

		// ------------------------------------------------------------------------- dashboard: custom fields (setup)
		defineRoute({
			method: 'GET',
			path: '/v1/dashboard/websites/:websiteId/fields',
			auth: 'dashboard',
			handler: manage.listFields,
		}),
		defineRoute({
			method: 'PUT',
			path: '/v1/dashboard/websites/:websiteId/fields',
			auth: 'dashboard',
			handler: manage.orderFields,
		}),
		defineRoute({
			method: 'PUT',
			path: '/v1/dashboard/websites/:websiteId/fields/:key',
			auth: 'dashboard',
			handler: manage.saveField,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/dashboard/websites/:websiteId/fields/:key',
			auth: 'dashboard',
			handler: manage.deleteField,
		}),

		// public docs: no sign-in, no tokens
		defineRoute({
			method: 'GET',
			path: '/docs',
			auth: 'none',
			handler: (ctx) =>
				new Response(renderDocs({ base: product.address() ?? new URL(ctx.request.url).origin }), {
					headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' },
				}),
		}),
	];
};
