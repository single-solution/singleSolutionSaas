/**
 * Roles and permissions of the merchant's users (PLAN 0.8.6), pure.
 *
 * - Every user of a website has exactly one role. The ready-made roles are a usual shop team (Owner, Business manager,
 *   Product manager, Marketing manager, Support staff) plus Customer, the role of every new sign-up.
 *   The merchant can change them (except their keys), copy them and add their own.
 * - A permission is `<source>:<key>`: `<source>` is the product that supplies it (`accounts`, `chat`, `ecommerce`, …,
 *   from each pasted product's `GET /v1/permissions`) or `site` for the merchant's own names. Owner carries every
 *   permission, written `*`.
 * - A role also sets two-step (optional or required) and session lengths: the session length in hours and "remember
 *   me" in days (0: no remember me). Defaults: 1 day and 30 days. With `sessionRolling` (K-27) a session's end moves
 *   at each renewal to that length from then, so a session in use does not end; without it (the default) the end is
 *   fixed at sign-in.
 * - Per-role sign-in options (PLAN 0.8.10 A6, A10): `remember` (`ask`, `ask_ticked`, or `always`: no box, always
 *   remembered), `methods` (the sign-in methods its users may use; [] = all), `signIn` (`on`, or `paused`: its users,
 *   and new sign-ups while it is the default role, are refused) and `logSignIns` (sign-ins and failures go to the
 *   activity log).
 * - A role has a `rank` (A4): a smaller number ranks higher. The ready-made roles rank Owner 100, Business manager 200,
 *   Product manager 300, Marketing manager 400, Support staff 500 and Customer 900; the merchant places their own roles
 *   between 101 and 899 (600 when not given). Staff never edit, block or delete a user whose role ranks above theirs.
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
/** Where the merchant's own roles may rank (the ready-made Owner is 100 and Customer 900). */
const OWN_RANK = Object.freeze({ min: 101, max: 899, default: 600 });
/** The key of the Owner role (A4: the last unblocked Owner stays). */
export const OWNER_ROLE = 'owner';
/** "Remember me" per role (A6). */
const REMEMBER_OPTIONS = Object.freeze(/** @type {const} */ (['ask', 'ask_ticked', 'always']));
/** The sign-in methods a role may be limited to (A6): the sign-in features. */
export const ROLE_METHODS = Object.freeze(
	/** @type {const} */ (['phone_code', 'phone_password', 'email_password', 'email_code', 'google', 'apple', 'facebook']),
);
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
 * @property {boolean} sessionRolling each renewal moves the session's end to its length from then (K-27)
 * @property {number} rank a smaller number ranks higher (A4)
 * @property {'ask' | 'ask_ticked' | 'always'} remember (A6)
 * @property {string[]} methods the sign-in methods its users may use; [] = all (A6)
 * @property {'on' | 'paused'} signIn (A6)
 * @property {boolean} logSignIns sign-ins, failures, resets and recovery codes in the activity log (A10)
 * @property {boolean} ready a ready-made role (cannot be deleted)
 */

/**
 * @param {string} key @param {string} name @param {number} rank @param {string} description @param {string[]} permissions
 * @returns {Role}
 */
const ready = (key, name, rank, description, permissions) => ({
	key,
	name,
	description,
	permissions,
	twoStep: 'optional',
	sessionHours: 24,
	rememberDays: 30,
	sessionRolling: false,
	rank,
	remember: 'ask',
	methods: [],
	signIn: 'on',
	logSignIns: false,
	ready: true,
});

/**
 * A role as the API answers it: its own members only (never the website or the times the database stamps).
 * @param {Role} role
 * @returns {Role}
 */
export const roleView = (role) => ({
	key: role.key,
	name: role.name,
	description: role.description,
	permissions: role.permissions,
	twoStep: role.twoStep,
	sessionHours: role.sessionHours,
	rememberDays: role.rememberDays,
	sessionRolling: role.sessionRolling,
	rank: role.rank,
	remember: role.remember,
	methods: role.methods,
	signIn: role.signIn,
	logSignIns: role.logSignIns,
	ready: role.ready === true,
});

/** Ecommerce's published permission keys (its manifest), as `ecommerce:<key>`. */
const shop = (/** @type {string[]} */ ...keys) => keys.map((key) => `ecommerce:${key}`);

/** The ready-made roles, created for a website on first use. */
export const READY_ROLES = Object.freeze([
	ready('customer', 'Customer', 900, 'Shoppers and visitors with an account. No staff permissions.', []),
	ready('owner', 'Owner', 100, 'Runs the business: every permission.', ['*']),
	ready('business_manager', 'Business manager', 200, 'Day-to-day operations lead: users, the shop, chats and messages.', [
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
		300,
		'Catalog focus: products, CSV and bulk changes, and review moderation.',
		shop('catalog.edit', 'csv.run', 'bulk.run', 'reviews.moderate'),
	),
	ready('marketing_manager', 'Marketing manager', 400, 'Offers, content and messages.', [
		'notifications:templates.edit',
		'chat:reports.read',
		...shop('coupons.edit', 'deals.edit', 'bundles.edit', 'loyalty.manage', 'reports.read'),
	]),
	ready('support_staff', 'Support staff', 500, 'Customer-facing: reads users, answers chats and handles orders and returns.', [
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
	const readyMade = READY_ROLES.find((each) => each.key === key);
	const rank = readyMade ? readyMade.rank : (body.rank ?? OWN_RANK.default);
	if (
		!Number.isInteger(rank) ||
		Number(rank) < (readyMade ? 1 : OWN_RANK.min) ||
		Number(rank) > (readyMade ? 1000 : OWN_RANK.max)
	)
		return { ok: false, field: 'rank', message: `Place your own roles at rank ${OWN_RANK.min} to ${OWN_RANK.max}.` };
	const remember = body.remember ?? 'ask';
	if (!REMEMBER_OPTIONS.includes(/** @type {any} */ (remember)))
		return { ok: false, field: 'remember', message: 'Remember me is ask, ask_ticked or always.' };
	const methods = Array.isArray(body.methods) ? [...new Set(body.methods)] : body.methods === undefined ? [] : null;
	if (!methods || methods.some((m) => !ROLE_METHODS.includes(/** @type {any} */ (m))))
		return { ok: false, field: 'methods', message: `Methods are a list of ${ROLE_METHODS.join(', ')} ([] = all).` };
	const signIn = body.signIn ?? 'on';
	if (signIn !== 'on' && signIn !== 'paused') return { ok: false, field: 'signIn', message: 'Sign-in is on or paused.' };
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
			sessionRolling: body.sessionRolling === true,
			rank: Number(rank),
			remember: /** @type {Role['remember']} */ (remember),
			methods: /** @type {string[]} */ (methods),
			signIn,
			logSignIns: body.logSignIns === true,
		},
	};
};

/**
 * Whether a role grants a permission (`<source>:<key>`; `*` grants every one).
 * @param {Pick<Role, 'permissions'>} role
 * @param {string} permission
 */
export const grants = (role, permission) => role.permissions.includes('*') || role.permissions.includes(permission);

/**
 * Whether a role's users may sign in with a method (A6): sign-in not paused and the method allowed.
 * @param {Pick<Role, 'methods' | 'signIn'>} role
 * @param {string} method
 * @returns {'sign_in_paused' | 'method_refused' | null}
 */
export const signInRefusal = (role, method) => {
	if (role.signIn === 'paused') return 'sign_in_paused';
	return role.methods.length > 0 && ROLE_METHODS.includes(/** @type {any} */ (method)) && !role.methods.includes(method)
		? 'method_refused'
		: null;
};

/**
 * Whether a session is remembered (A6): always for a role set to `always`, else as the user chose.
 * @param {Pick<Role, 'remember'>} role
 * @param {boolean} asked
 */
export const remembered = (role, asked) => role.remember === 'always' || asked;

/**
 * When a session ends, from now: the role's session length, or its remember-me days when the user asked to be
 * remembered (at sign-in, and at each renewal while the role's sessions roll).
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
