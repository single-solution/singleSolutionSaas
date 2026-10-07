/**
 * Role-based access control — pure, no I/O. Implements the rights table of PLAN 0.2 ("Rights per role"); the API
 * checks it on every request, hiding a button is never enough.
 *
 * - **Admins** have exactly one role: `owner`, `support` or `finance`. Their rights cover every merchant and website.
 * - **Merchants** have no roles: a merchant acts on its own records only (`merchantId` of the resource must be its
 *   own), with the merchant column of the table.
 * - `product` actors (client assertions) have no rights here: their routes authorise by protocol, so `can` is false
 *   for them unless the actor carries explicit `permissions`.
 * - Rows the products enforce on their own servers (switching features, settings, widget texts, theme, connections,
 *   global defaults and prices: {@link PRODUCT_ENFORCED_ROWS}) have no Portal permission. The Portal's part of them is
 *   what it signs and accepts: launches carry the role (Finance is never launched), and a feature report is accepted
 *   only for a current Owner or Support admin.
 * - `system` actors (operations, migrations) may do everything.
 * @module
 */

/**
 * @typedef {'admin' | 'merchant' | 'product' | 'system'} ActorType
 * @typedef {'owner' | 'support' | 'finance'} AdminRole
 *
 * @typedef {object} Actor
 * @property {ActorType} type
 * @property {string} id admin id, merchant id, product id or a module name (system)
 * @property {AdminRole | null} [role] admins: the live role
 * @property {string | null} [name] admins: the live name (Activity keeps it)
 * @property {string} [merchantId] merchant actors
 * @property {boolean} [twoStepRequired] admins: Require two-step for admins applies and two-step is not set up
 * @property {string[]} [permissions] explicit extra permissions (rarely needed)
 *
 * @typedef {{ merchantId?: string | null, websiteId?: string | null }} Resource
 */

/** Admin roles (PLAN 0.0). */
export const ADMIN_ROLES = Object.freeze(/** @type {AdminRole[]} */ (['owner', 'support', 'finance']));

/**
 * The permissions, one per row of the rights table (PLAN 0.2) the Portal enforces, plus the read halves the table
 * marks "view".
 */
export const PERMISSIONS = Object.freeze({
	/** See Overview and Activity */
	overviewRead: 'overview.read',
	activityRead: 'activity.read',
	/** Create merchants; edit merchant details (Finance: view) */
	merchantsRead: 'merchants.read',
	merchantsWrite: 'merchants.write',
	/** Suspend and resume merchants */
	merchantsSuspend: 'merchants.suspend',
	/** Resend or copy merchant setup links */
	merchantsSetupLink: 'merchants.setup_link',
	/** Turn off another person's two-step */
	twoStepTurnOff: 'two_step.turn_off',
	/** Delete a merchant */
	merchantsDelete: 'merchants.delete',
	/** Add and remove websites (Finance: view) */
	websitesRead: 'websites.read',
	websitesWrite: 'websites.write',
	/** Add and remove products on websites (Finance: view) */
	productsOnWebsitesRead: 'products_on_websites.read',
	productsOnWebsitesWrite: 'products_on_websites.write',
	/** Reveal, copy and regenerate server tokens */
	tokensManage: 'tokens.manage',
	/** Open a product dashboard for a website */
	dashboardsOpen: 'dashboards.open',
	/** Products: connect, reconnect, set active/inactive, Open as admin with no website */
	productsManage: 'products.manage',
	/** The connected products list (Add product on a website; Owner and Support) */
	productsRead: 'products.read',
	/** Add credits */
	creditsAdd: 'credits.add',
	/** See receipts and charges (Support: view; merchant: own, without amount paid) */
	billingRead: 'billing.read',
	/** Admins: invite, resend (or copy) invite, correct invite e-mail, change role, remove */
	adminsManage: 'admins.manage',
	/** Settings (e-mail, billing rules, branding, support contact, security) */
	settingsPortalWrite: 'portal_settings.write',
});

const P = PERMISSIONS;

/** Rows of the rights table (PLAN 0.2) that each product checks on its own server for every request. */
export const PRODUCT_ENFORCED_ROWS = Object.freeze([
	'Switch features on and off',
	'Edit settings, widget texts, theme and connections',
	'Edit global defaults and prices',
]);

/** Every permission. */
export const ALL_PERMISSIONS = Object.freeze(Object.values(PERMISSIONS));

/** What each admin role may do (PLAN 0.2). */
export const ROLE_PERMISSIONS = Object.freeze({
	owner: Object.freeze([...ALL_PERMISSIONS]),
	support: Object.freeze([
		P.overviewRead,
		P.activityRead,
		P.merchantsRead,
		P.merchantsWrite,
		P.merchantsSuspend,
		P.merchantsSetupLink,
		P.websitesRead,
		P.websitesWrite,
		P.productsOnWebsitesRead,
		P.productsOnWebsitesWrite,
		P.tokensManage,
		P.dashboardsOpen,
		P.productsRead,
		P.billingRead,
	]),
	finance: Object.freeze([
		P.overviewRead,
		P.activityRead,
		P.merchantsRead,
		P.websitesRead,
		P.productsOnWebsitesRead,
		P.creditsAdd,
		P.billingRead,
	]),
});

/** What a merchant may do on its own records (PLAN 0.2, merchant column). */
export const MERCHANT_PERMISSIONS = Object.freeze([
	P.overviewRead,
	P.activityRead,
	P.merchantsRead,
	P.websitesRead,
	P.productsOnWebsitesRead,
	P.tokensManage,
	P.dashboardsOpen,
	P.billingRead,
]);

/**
 * Permissions of an actor for a resource (pure).
 * @param {Actor | null | undefined} actor
 * @param {Resource} [resource]
 * @returns {string[]}
 */
export const permissionsFor = (actor, resource = {}) => {
	if (!actor) return [];
	const extra = actor.permissions ?? [];
	switch (actor.type) {
		case 'system':
			return [...ALL_PERMISSIONS];
		case 'admin': {
			const role = actor.role ?? null;
			return [...(role && Object.hasOwn(ROLE_PERMISSIONS, role) ? ROLE_PERMISSIONS[role] : []), ...extra];
		}
		case 'merchant': {
			if (!actor.merchantId) return [];
			if (resource.merchantId !== undefined && resource.merchantId !== null && resource.merchantId !== actor.merchantId)
				return [];
			return [...MERCHANT_PERMISSIONS];
		}
		default:
			return [...extra];
	}
};

/**
 * Can `actor` perform `permission` on `resource`? Pure; unknown roles grant nothing. A merchant's unscoped check is
 * evaluated against its own merchant.
 * @param {Actor | null | undefined} actor
 * @param {string} permission
 * @param {Resource} [resource]
 * @returns {boolean}
 */
export const can = (actor, permission, resource = {}) => {
	if (typeof permission !== 'string' || permission.length === 0) return false;
	if (actor?.type === 'merchant' && (resource.merchantId === undefined || resource.merchantId === null))
		return permissionsFor(actor, { ...resource, merchantId: actor.merchantId ?? null }).includes(permission);
	return permissionsFor(actor, resource).includes(permission);
};

/**
 * Websites an actor may see for a permission: `'all'` (admins with the permission, the system) or the merchant's own
 * (`'own'`), else none.
 * @param {Actor | null | undefined} actor
 * @param {string} permission
 * @returns {'all' | 'own' | 'none'}
 */
export const websitesVisible = (actor, permission) => {
	if (!actor) return 'none';
	if (actor.type === 'system') return 'all';
	if (actor.type === 'admin') return can(actor, permission) ? 'all' : 'none';
	if (actor.type === 'merchant') return can(actor, permission) ? 'own' : 'none';
	return 'none';
};

/**
 * @param {unknown} role
 * @returns {role is AdminRole}
 */
export const validRole = (role) => typeof role === 'string' && ADMIN_ROLES.includes(/** @type {AdminRole} */ (role));
