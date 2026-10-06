/**
 * Role-based access control — pure, no I/O.
 *
 * Permissions are dotted strings (`websites.write`, `platform.credits.adjust`). Role bundles grant permission
 * patterns, where `*` matches everything and `a.*` matches `a.<anything>`. Two role families:
 *
 * - **platform** (staff): `superadmin`, `admin`, `support`, `finance`. Staff permissions are global: they apply to
 *   every merchant and website (admin has full powers on merchant resources, PLAN §2).
 * - **merchant** (merchant users): `owner`, `admin`, `billing`, `developer`, `editor`. Merchant roles apply to
 *   resources of the actor's own merchant only. A merchant-wide role covers every website of that merchant; a
 *   **website-scoped grant** (`grants: [{ websiteId, roles }]`) covers only that website, and never merchant-level
 *   operations (a resource without `websiteId`).
 *
 * `product` actors (client assertions) and `website` actors (website keys) have no roles: their routes authorise by
 * protocol (app identity, key scopes), so `can` is false for them unless the actor carries explicit `permissions`.
 * `system` actors (operations, migrations) may do everything.
 * @module
 */

/**
 * @typedef {'staff' | 'merchant_user' | 'product' | 'website' | 'system'} ActorType
 *
 * @typedef {object} Actor
 * @property {ActorType} type
 * @property {string} id user id, app id, website key id or job name
 * @property {string[]} [roles] staff: platform roles; merchant_user: merchant-wide roles
 * @property {string} [merchantId] merchant_user / website actors
 * @property {Array<{ websiteId: string, roles: string[] }>} [grants] website-scoped merchant roles
 * @property {string[]} [permissions] explicit extra permission patterns (rarely needed)
 * @property {{ type: 'staff', id: string, name?: string | null }} [via] impersonation: the staff member acting as this user
 *
 * @typedef {{ merchantId?: string | null, websiteId?: string | null }} Resource
 */

/** Merchant-level permissions (scoped to the actor's merchant; website grants apply where a websiteId is given). */
export const MERCHANT_PERMISSIONS = Object.freeze([
	'merchant.read',
	'merchant.settings.write',
	'merchant.delete',
	'merchant.owner.transfer',
	'merchant.team.read',
	'merchant.team.manage',
	'billing.read',
	'billing.manage',
	'websites.read',
	'websites.create',
	'websites.write',
	'websites.delete',
	'keys.read',
	'keys.manage',
	'subscriptions.read',
	'subscriptions.manage',
	'config.read',
	'config.write',
	'connectors.read',
	'connectors.manage',
	'audit.read',
]);

/** Platform (staff-only) permissions. */
export const STAFF_PERMISSIONS = Object.freeze([
	'platform.merchants.read',
	'platform.merchants.write',
	'platform.impersonate',
	'platform.launch.admin',
	'platform.credits.adjust',
	'platform.finance.read',
	'platform.apps.read',
	'platform.apps.review',
	'platform.apps.manage',
	'platform.jobs.read',
	'platform.jobs.manage',
	'platform.audit.read',
	'platform.settings.write',
	'platform.config.write',
	'platform.staff.manage',
]);

export const ALL_PERMISSIONS = Object.freeze([...STAFF_PERMISSIONS, ...MERCHANT_PERMISSIONS]);

const READ_ONLY_MERCHANT = Object.freeze(MERCHANT_PERMISSIONS.filter((p) => p.endsWith('.read')));

/** Staff role bundles. */
export const STAFF_ROLE_BUNDLES = Object.freeze({
	superadmin: Object.freeze(['*']),
	admin: Object.freeze([...STAFF_PERMISSIONS.filter((p) => p !== 'platform.staff.manage'), ...MERCHANT_PERMISSIONS]),
	support: Object.freeze([
		'platform.merchants.read',
		'platform.launch.admin',
		'platform.apps.read',
		'platform.jobs.read',
		'platform.audit.read',
		...READ_ONLY_MERCHANT,
	]),
	finance: Object.freeze([
		'platform.merchants.read',
		'platform.finance.read',
		'platform.credits.adjust',
		'platform.audit.read',
		'merchant.read',
		'billing.read',
		'subscriptions.read',
		'audit.read',
	]),
});

/** Merchant role bundles. */
export const MERCHANT_ROLES = Object.freeze({
	owner: Object.freeze([...MERCHANT_PERMISSIONS]),
	admin: Object.freeze(MERCHANT_PERMISSIONS.filter((p) => p !== 'merchant.delete' && p !== 'merchant.owner.transfer')),
	billing: Object.freeze([
		'merchant.read',
		'billing.read',
		'billing.manage',
		'websites.read',
		'subscriptions.read',
		'subscriptions.manage',
	]),
	developer: Object.freeze([
		'merchant.read',
		'websites.read',
		'websites.write',
		'keys.read',
		'keys.manage',
		'subscriptions.read',
		'config.read',
		'config.write',
		'connectors.read',
		'connectors.manage',
		'audit.read',
	]),
	editor: Object.freeze(['merchant.read', 'websites.read', 'subscriptions.read', 'config.read', 'config.write']),
});

/**
 * @param {string} pattern
 * @param {string} permission
 * @returns {boolean}
 */
export const permissionMatches = (pattern, permission) => {
	if (pattern === '*' || pattern === permission) return true;
	return pattern.endsWith('.*') && permission.startsWith(pattern.slice(0, -1));
};

/**
 * @param {ReadonlyArray<string>} patterns
 * @param {string} permission
 */
const anyMatch = (patterns, permission) => patterns.some((pattern) => permissionMatches(pattern, permission));

/**
 * @param {Readonly<Record<string, ReadonlyArray<string>>>} bundles
 * @param {ReadonlyArray<string> | undefined} roles
 * @returns {string[]}
 */
const expand = (bundles, roles) =>
	(roles ?? []).flatMap((role) => (Object.hasOwn(bundles, role) ? [...(bundles[role] ?? [])] : []));

/**
 * Permission patterns of an actor for a resource (pure).
 * @param {Actor | null | undefined} actor
 * @param {Resource} [resource]
 * @returns {string[]}
 */
export const permissionsFor = (actor, resource = {}) => {
	if (!actor) return [];
	const extra = actor.permissions ?? [];
	switch (actor.type) {
		case 'system':
			return ['*'];
		case 'staff':
			return [...expand(STAFF_ROLE_BUNDLES, actor.roles), ...extra];
		case 'merchant_user': {
			if (!actor.merchantId) return [];
			if (resource.merchantId !== undefined && resource.merchantId !== null && resource.merchantId !== actor.merchantId)
				return [];
			const own = expand(MERCHANT_ROLES, actor.roles);
			const websiteId = resource.websiteId ?? null;
			const scoped = websiteId
				? (actor.grants ?? [])
						.filter((grant) => grant.websiteId === websiteId)
						.flatMap((grant) => expand(MERCHANT_ROLES, grant.roles))
				: [];
			// merchant users never hold platform permissions, whatever `permissions` says
			return [...own, ...scoped, ...extra].filter((p) => !p.startsWith('platform.') && p !== '*');
		}
		default:
			return [...extra];
	}
};

/**
 * Can `actor` perform `permission` on `resource`? Pure; unknown roles grant nothing.
 * @param {Actor | null | undefined} actor
 * @param {string} permission
 * @param {Resource} [resource]
 * @returns {boolean}
 */
export const can = (actor, permission, resource = {}) => {
	if (typeof permission !== 'string' || permission.length === 0) return false;
	if (actor?.type === 'merchant_user' && (resource.merchantId === undefined || resource.merchantId === null)) {
		// merchant users act on their own merchant only; an unscoped check is evaluated against it
		return anyMatch(permissionsFor(actor, { ...resource, merchantId: actor.merchantId ?? null }), permission);
	}
	return anyMatch(permissionsFor(actor, resource), permission);
};

/**
 * Websites an actor may see for a permission: `'all'` (staff or merchant-wide role) or an explicit list.
 * @param {Actor | null | undefined} actor
 * @param {string} permission
 * @returns {'all' | string[]}
 */
export const websitesVisible = (actor, permission) => {
	if (!actor) return [];
	if (actor.type === 'system') return 'all';
	if (actor.type === 'staff') return can(actor, permission) ? 'all' : [];
	if (actor.type !== 'merchant_user') return [];
	if (anyMatch(permissionsFor({ ...actor, grants: [] }, { merchantId: actor.merchantId ?? null }), permission)) return 'all';
	return (actor.grants ?? [])
		.filter((grant) => anyMatch(expand(MERCHANT_ROLES, grant.roles), permission))
		.map((grant) => grant.websiteId);
};

/**
 * Validate role names against a family (for identity modules storing roles).
 * @param {'platform' | 'merchant'} family
 * @param {unknown} roles
 * @returns {roles is string[]}
 */
export const validRoles = (family, roles) => {
	const bundles = family === 'platform' ? STAFF_ROLE_BUNDLES : MERCHANT_ROLES;
	return (
		Array.isArray(roles) && roles.length > 0 && roles.every((role) => typeof role === 'string' && Object.hasOwn(bundles, role))
	);
};
