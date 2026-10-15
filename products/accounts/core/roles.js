/**
 * Roles and permissions of the merchant's users (PLAN 0.8.6), pure.
 *
 * - Every user of a website has exactly one role. On first use a website gets ready-made templates: a usual business
 *   team (Owner, Business manager, Product manager, Marketing manager, Support staff) plus Customer, the role for new
 *   sign-ups. They are the merchant's roles from then on: changed (except their keys), copied, deleted for good, and
 *   the merchant adds their own (A3).
 * - Only two roles are system roles (`system`), which cannot be deleted: Owner (every permission, rank 100) and the role
 *   for new sign-ups (`signUp`; exactly one role, never Owner, the Customer template at first). The merchant moves the
 *   sign-up choice by choosing another role; users of a deleted role get the sign-up role (A4).
 * - `membership` (A4): the role shows as a membership on the user's own account ("Member since"); the templates show it
 *   for every role but Customer, and a new role shows it unless the merchant turns it off.
 * - A permission is `<source>:<key>`: `<source>` is the product that supplies it (`accounts`, `chat`, `ecommerce`, …,
 *   from each pasted product's `GET /v1/permissions`) or `site` for the merchant's own names. Owner carries every
 *   permission, written `*`.
 * - A role also sets two-step (optional or required) and session lengths: the session length in hours and "remember
 *   me" in days (0: no remember me). Defaults: 1 day and 30 days. With `sessionRolling` (K-27) a session's end moves
 *   at each renewal to that length from then, so a session in use does not end; without it (the default) the end is
 *   fixed at sign-in.
 * - Per-role sign-in options (PLAN 0.8.10 A6, A10, A14): `remember` (`ask`, `ask_ticked`, `always`: no box, always
 *   remembered, or `never`: no box, never remembered, so the session ends when the browser closes, and on the server
 *   at the latest after the role's longer length, its session length or its remember-me days), `methods` (the sign-in
 *   methods its users may use; [] = all), `signIn` (`on`, or `paused`: its users, and new sign-ups while it is the
 *   default role, are refused) and `logSignIns` (sign-ins and failures go to the activity log).
 * - A role has a `rank` (A4): a smaller number ranks higher. Owner is always 100; every other role sits between 101 and
 *   999 (600 when not given). The templates rank Business manager 200, Product manager 300, Marketing manager 400,
 *   Support staff 500 and Customer 900. Staff never edit, block or delete a user whose role ranks above theirs.
 * - Roles only say what a user may do on the merchant's own site: an Accounts sign-in never authorizes admin actions in
 *   any product (those need the server token or a ticket).
 * @module
 */
import { SIGN_IN_METHODS } from './widgets.js';

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
/** Where every role but Owner may rank (Owner is always 100). */
const RANK = Object.freeze({ owner: 100, min: 101, max: 999, default: 600 });
/** The key of the Owner role (A4: the last unblocked Owner stays). */
export const OWNER_ROLE = 'owner';
/** "Remember me" per role (A6; `never`, A14). */
const REMEMBER_OPTIONS = Object.freeze(/** @type {const} */ (['ask', 'ask_ticked', 'always', 'never']));
/** The sign-in methods a role may be limited to (A6): the sign-in features. */
export const ROLE_METHODS = SIGN_IN_METHODS;
/**
 * The template that is the role for new sign-ups on first use, and the last resort while no role is chosen (a website
 * whose roles were all imported without one).
 */
export const SIGN_UP_TEMPLATE = 'customer';

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
 * @property {'ask' | 'ask_ticked' | 'always' | 'never'} remember (A6, A14)
 * @property {string[]} methods the sign-in methods its users may use; [] = all (A6)
 * @property {'on' | 'paused'} signIn (A6)
 * @property {boolean} logSignIns sign-ins, failures, resets and recovery codes in the activity log (A10)
 * @property {boolean} signUp the role for new sign-ups (exactly one role; A4)
 * @property {boolean} membership shown as a membership on the user's own account, "Member since" (A4)
 */

/**
 * @param {string} key @param {string} name @param {number} rank @param {string} description @param {string[]} permissions
 * @returns {Role}
 */
const template = (key, name, rank, description, permissions) => ({
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
	signUp: key === SIGN_UP_TEMPLATE,
	membership: key !== SIGN_UP_TEMPLATE,
});

/**
 * Whether a role is a system role, which cannot be deleted: Owner, or the role for new sign-ups (A3).
 * @param {Pick<Role, 'key' | 'signUp'>} role
 */
export const isSystemRole = (role) => role.key === OWNER_ROLE || role.signUp === true;

/**
 * A role as the API answers it: its own members only (never the website or the times the database stamps), and
 * whether it is a system role.
 * @param {Role} role
 * @returns {Role & { system: boolean }}
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
	signUp: role.signUp === true,
	membership: role.membership === true,
	system: isSystemRole(role),
});

/** Ecommerce's published permission keys (its manifest), as `ecommerce:<key>`. */
const ecommerce = (/** @type {string[]} */ ...keys) => keys.map((key) => `ecommerce:${key}`);

/** The ready-made templates, created for a website on first use (Owner first); then the merchant's to change or delete. */
export const ROLE_TEMPLATES = Object.freeze([
	template('owner', 'Owner', 100, 'Runs the business: every permission.', ['*']),
	template('customer', 'Customer', 900, 'Customers and visitors with an account. No staff permissions.', []),
	template('business_manager', 'Business manager', 200, 'Day-to-day operations lead: users, sales, chats and messages.', [
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
		...ecommerce(
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
	template(
		'product_manager',
		'Product manager',
		300,
		'Catalog focus: products, CSV and bulk changes, and review moderation.',
		ecommerce('catalog.edit', 'csv.run', 'bulk.run', 'reviews.moderate'),
	),
	template('marketing_manager', 'Marketing manager', 400, 'Offers, content and messages.', [
		'notifications:templates.edit',
		'chat:reports.read',
		...ecommerce('coupons.edit', 'deals.edit', 'bundles.edit', 'loyalty.manage', 'reports.read'),
	]),
	template(
		'support_staff',
		'Support staff',
		500,
		'Customer-facing: reads users, answers chats and handles orders and returns.',
		[
			'accounts:users.read',
			'chat:inbox.read',
			'chat:inbox.reply',
			'notifications:log.read',
			...ecommerce('orders.read', 'orders.manage', 'returns.manage', 'customers.manage'),
		],
	),
]);

/**
 * Check a role as the merchant saves it (the key comes from the path).
 * @param {string} key
 * @param {unknown} input
 * @returns {{ ok: true, value: Role } | { ok: false, field: string, message: string }}
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
	const owner = key === OWNER_ROLE;
	if (owner && !permissions.includes('*'))
		return { ok: false, field: 'permissions', message: 'Owner keeps every permission (*).' };
	const twoStep = body.twoStep === 'required' ? 'required' : 'optional';
	const sessionHours = body.sessionHours ?? 24;
	if (!Number.isInteger(sessionHours) || Number(sessionHours) < 1 || Number(sessionHours) > MAX_SESSION_HOURS)
		return { ok: false, field: 'sessionHours', message: `Session length is 1 to ${MAX_SESSION_HOURS} hours.` };
	const rememberDays = body.rememberDays ?? 30;
	if (!Number.isInteger(rememberDays) || Number(rememberDays) < 0 || Number(rememberDays) > MAX_REMEMBER_DAYS)
		return { ok: false, field: 'rememberDays', message: `Remember me is 0 to ${MAX_REMEMBER_DAYS} days.` };
	const rank = owner ? RANK.owner : (body.rank ?? RANK.default);
	if (!Number.isInteger(rank) || Number(rank) < (owner ? RANK.owner : RANK.min) || Number(rank) > RANK.max)
		return { ok: false, field: 'rank', message: `Place roles at rank ${RANK.min} to ${RANK.max} (Owner is ${RANK.owner}).` };
	const remember = body.remember ?? 'ask';
	if (!REMEMBER_OPTIONS.includes(/** @type {any} */ (remember)))
		return { ok: false, field: 'remember', message: 'Remember me is ask, ask_ticked, always or never.' };
	const methods = Array.isArray(body.methods) ? [...new Set(body.methods)] : body.methods === undefined ? [] : null;
	if (!methods || methods.some((m) => !ROLE_METHODS.includes(/** @type {any} */ (m))))
		return { ok: false, field: 'methods', message: `Methods are a list of ${ROLE_METHODS.join(', ')} ([] = all).` };
	const signIn = body.signIn ?? 'on';
	if (signIn !== 'on' && signIn !== 'paused') return { ok: false, field: 'signIn', message: 'Sign-in is on or paused.' };
	const signUp = body.signUp === true;
	if (owner && signUp) return { ok: false, field: 'signUp', message: 'New sign-ups never get the Owner role.' };
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
			signUp,
			membership: body.membership === undefined ? true : body.membership === true,
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
 * Whether a session is remembered (A6, A14): always for a role set to `always`, never for a role set to `never`, else as
 * the user chose.
 * @param {Pick<Role, 'remember'>} role
 * @param {boolean} asked
 */
export const remembered = (role, asked) => role.remember !== 'never' && (role.remember === 'always' || asked);

/**
 * When a session ends, from now (at sign-in, and at each renewal while the role's sessions roll): the role's session
 * length, or its remember-me days when the user asked to be remembered. A role set to `never` (A14) is never
 * remembered: the browser forgets the session when it closes, and the server ends it at the latest after the role's
 * longer length (its session length or its remember-me days).
 * @param {{ now: number, remember: boolean, role: Pick<Role, 'sessionHours' | 'rememberDays'> & Partial<Pick<Role, 'remember'>> }} input
 */
export const sessionEnd = ({ now, remember, role }) => {
	const hours =
		role.remember === 'never'
			? Math.max(role.sessionHours, role.rememberDays * 24)
			: remember && role.rememberDays > 0
				? role.rememberDays * 24
				: role.sessionHours;
	return now + hours * 3_600_000;
};

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
