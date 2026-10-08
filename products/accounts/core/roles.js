/**
 * Roles and permissions of the merchant's users (PLAN 0.8.6), pure.
 *
 * - Every user of a website has exactly one role. The ready-made roles follow ibrahimMobiles' team roles (Owner,
 *   Business manager, Product manager, Marketing manager, Support staff) plus Customer, the role of every new sign-up.
 *   The merchant can change them (except their keys), copy them and add their own.
 * - A permission is `<source>:<key>`: `<source>` is the product that supplies it (`accounts`, `chat`, `ecommerce`, …,
 *   from each pasted product's `GET /v1/permissions`) or `site` for the merchant's own names. Owner carries every
 *   permission, written `*`.
 * - A role also sets two-step (optional or required) and session lengths: the session length in hours and "remember
 *   me" in days (0: no remember me). Defaults: 1 day and 30 days.
 * - Roles only say what a user may do on the merchant's own site: an Accounts sign-in never authorises admin actions in
 *   any product (those need the server token or a ticket).
 * @module
 */

export const ROLE_KEY = /^[a-z][a-z0-9_]{1,39}$/;
const PERMISSION = /^(?:[a-z][a-z0-9-]{1,30}:[a-z][a-z0-9_.]{0,63}|\*)$/;
const OWN_PERMISSION_KEY = /^[a-z][a-z0-9_.]{0,63}$/;
/** The source of the merchant's own permission names. */
const OWN_SOURCE = 'site';
/** Hard maximums (code constants). */
export const MAX_ROLES = 100;
const MAX_ROLE_PERMISSIONS = 500;
const MAX_OWN_PERMISSIONS = 200;
const MAX_SESSION_HOURS = 720;
const MAX_REMEMBER_DAYS = 365;
/** The role of every new sign-up and of users whose role was deleted. */
export const DEFAULT_ROLE = 'customer';

/**
 * @typedef {object} Role
 * @property {string} key
 * @property {string} name
 * @property {string} description
 * @property {string[]} permissions
 * @property {'optional' | 'required'} twoStep
 * @property {number} sessionHours
 * @property {number} rememberDays
 * @property {boolean} ready a ready-made role (cannot be deleted)
 */

/** @param {string} key @param {string} name @param {string} description @param {string[]} permissions @returns {Role} */
const ready = (key, name, description, permissions) => ({
	key,
	name,
	description,
	permissions,
	twoStep: 'optional',
	sessionHours: 24,
	rememberDays: 30,
	ready: true,
});

/** Ecommerce's published permission keys (its manifest), as `ecommerce:<key>`. */
const shop = (/** @type {string[]} */ ...keys) => keys.map((key) => `ecommerce:${key}`);

/** The ready-made roles, created for a website on first use. */
export const READY_ROLES = Object.freeze([
	ready('customer', 'Customer', 'Shoppers and visitors with an account. No staff permissions.', []),
	ready('owner', 'Owner', 'Runs the business: every permission.', ['*']),
	ready('business_manager', 'Business manager', 'Day-to-day operations lead: users, the shop, chats and messages.', [
		'accounts:users.read',
		'accounts:users.manage',
		'chat:inbox.read',
		'chat:inbox.reply',
		'chat:inbox.manage',
		'chat:knowledge.edit',
		'chat:reports.read',
		'notifications:log.read',
		'notifications:messages.send',
		'notifications:templates.edit',
		...shop(
			'catalog.edit',
			'orders.read',
			'orders.manage',
			'orders.refund',
			'customers.manage',
			'returns.manage',
			'coupons.edit',
			'deals.edit',
			'bundles.edit',
			'loyalty.manage',
			'reviews.moderate',
			'reports.read',
			'csv.run',
			'bulk.run',
		),
	]),
	ready(
		'product_manager',
		'Product manager',
		'Catalog focus: products, CSV and bulk changes, and review moderation.',
		shop('catalog.edit', 'csv.run', 'bulk.run', 'reviews.moderate'),
	),
	ready('marketing_manager', 'Marketing manager', 'Offers, content and messages.', [
		'notifications:templates.edit',
		'chat:reports.read',
		...shop('coupons.edit', 'deals.edit', 'bundles.edit', 'loyalty.manage', 'reports.read'),
	]),
	ready('support_staff', 'Support staff', 'Customer-facing: reads users, answers chats and handles orders and returns.', [
		'accounts:users.read',
		'chat:inbox.read',
		'chat:inbox.reply',
		'notifications:log.read',
		...shop('orders.read', 'orders.manage', 'returns.manage', 'customers.manage'),
	]),
]);

/**
 * Check a role as the merchant saves it (the key comes from the path).
 * @param {string} key
 * @param {unknown} input
 * @returns {{ ok: true, value: Omit<Role, 'ready'> } | { ok: false, field: string, message: string }}
 */
export const checkRole = (key, input) => {
	const body = typeof input === 'object' && input !== null ? /** @type {Record<string, unknown>} */ (input) : {};
	if (!ROLE_KEY.test(key)) return { ok: false, field: 'key', message: 'Use 2–40 lower-case letters, digits or _.' };
	const name = typeof body.name === 'string' ? body.name.trim() : '';
	if (name.length === 0 || name.length > 60)
		return { ok: false, field: 'name', message: 'Name the role (at most 60 characters).' };
	const description = typeof body.description === 'string' ? body.description.trim() : '';
	if (description.length > 300) return { ok: false, field: 'description', message: 'At most 300 characters.' };
	const permissions = Array.isArray(body.permissions) ? [...new Set(body.permissions)] : [];
	if (permissions.length > MAX_ROLE_PERMISSIONS || permissions.some((p) => typeof p !== 'string' || !PERMISSION.test(p)))
		return { ok: false, field: 'permissions', message: 'Permissions are <product>:<key>, site:<key> or * (at most 500).' };
	const twoStep = body.twoStep === 'required' ? 'required' : 'optional';
	const sessionHours = body.sessionHours ?? 24;
	if (!Number.isInteger(sessionHours) || Number(sessionHours) < 1 || Number(sessionHours) > MAX_SESSION_HOURS)
		return { ok: false, field: 'sessionHours', message: `Session length is 1 to ${MAX_SESSION_HOURS} hours.` };
	const rememberDays = body.rememberDays ?? 30;
	if (!Number.isInteger(rememberDays) || Number(rememberDays) < 0 || Number(rememberDays) > MAX_REMEMBER_DAYS)
		return { ok: false, field: 'rememberDays', message: `Remember me is 0 to ${MAX_REMEMBER_DAYS} days.` };
	return {
		ok: true,
		value: {
			key,
			name,
			description,
			permissions: /** @type {string[]} */ (permissions),
			twoStep,
			sessionHours: Number(sessionHours),
			rememberDays: Number(rememberDays),
		},
	};
};

/**
 * When a new session ends: the role's session length, or its remember-me days when the user asked to be remembered.
 * @param {{ now: number, remember: boolean, role: Pick<Role, 'sessionHours' | 'rememberDays'> }} input
 */
export const sessionEnd = ({ now, remember, role }) =>
	now + (remember && role.rememberDays > 0 ? role.rememberDays * 24 : role.sessionHours) * 3_600_000;

/**
 * The permission catalog the Roles admin offers: Accounts' own, each pasted product's and the merchant's own names.
 * @param {{ products: Array<{ productId: string, permissions: Array<{ key: string, name: string }> }>,
 *   own: Array<{ key: string, name: string }> }} input
 */
export const permissionCatalog = ({ products, own }) => [
	...products.map(({ productId, permissions }) => ({
		source: productId,
		permissions: permissions.map((p) => ({ key: `${productId}:${p.key}`, name: p.name })),
	})),
	{ source: OWN_SOURCE, permissions: own.map((p) => ({ key: `${OWN_SOURCE}:${p.key}`, name: p.name })) },
];

/**
 * Check the merchant's own permission names (`[{ key, name }]`).
 * @param {unknown} input
 * @returns {{ ok: true, value: Array<{ key: string, name: string }> } | { ok: false, message: string }}
 */
export const checkOwnPermissions = (input) => {
	if (!Array.isArray(input) || input.length > MAX_OWN_PERMISSIONS)
		return { ok: false, message: `Send up to ${MAX_OWN_PERMISSIONS} permissions as [{ key, name }].` };
	/** @type {Map<string, string>} */
	const out = new Map();
	for (const item of input) {
		const key = typeof item?.key === 'string' ? item.key.trim() : '';
		const name = typeof item?.name === 'string' ? item.name.trim() : '';
		if (!OWN_PERMISSION_KEY.test(key) || name.length === 0 || name.length > 80)
			return { ok: false, message: 'Each permission needs a key (lower-case letters, digits, _ or .) and a name.' };
		out.set(key, name);
	}
	return { ok: true, value: [...out].map(([key, name]) => ({ key, name })) };
};
