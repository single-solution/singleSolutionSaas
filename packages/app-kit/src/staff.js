/**
 * Staff on the merchant's server: who may change configuration and work with business data.
 *
 * A website's server token runs the website; it cannot change anything by itself. A route that changes configuration
 * (settings, texts, theme, Format, lists, connections, templates, roles …) or works with business data (orders,
 * products, customers …) is called with the server token **and** the Accounts sign-in of a staff member
 * (`SS-Sign-In`), which the kit verifies for the request's own website (`ctx.signIn()`, see `identity.js`) and whose
 * role must grant the route's permission. Otherwise:
 *
 * - no sign-in: 403 `needs_signed_in_staff`;
 * - a sign-in that is not valid for this website (another website's, expired, wrong signature): 401 `invalid_sign_in`;
 * - a valid sign-in whose role lacks the permission: 403 `forbidden`.
 *
 * The acting person is the one the verified sign-in names, never a header the caller wrote (the old `SS-Actor-*`
 * headers are ignored). Changes are recorded in the activity log and in Recent changes with that person.
 *
 * A permission in a role is `<product>:<key>` (`*`: every permission, the Owner role). The kit adds the permissions
 * below to every product's own, so Accounts offers them on roles.
 * @module
 */

import { problem } from './http/results.js';

/**
 * The permissions the kit adds to every product (`GET /v1/permissions`): its own routes need them.
 * @type {ReadonlyArray<Readonly<{ key: string, name: string }>>}
 */
export const KIT_PERMISSIONS = Object.freeze([
	Object.freeze({ key: 'settings.manage', name: 'Change settings, texts, theme, Format and lists' }),
	Object.freeze({ key: 'connections.manage', name: 'Change connections (keys, tokens and storage)' }),
	Object.freeze({ key: 'audit.read', name: 'Read the activity log' }),
]);

/** The permission a role grants when it holds every permission (the Owner role). */
const ALL = '*';

/**
 * Whether a verified user's role grants a permission of this product.
 * @param {{ permissions?: readonly string[] } | null | undefined} user the user of a verified sign-in
 * @param {string} productId
 * @param {string} permission the product's own key (`orders.manage`), without the product prefix
 * @returns {boolean}
 */
export const grants = (user, productId, permission) => {
	const held = user?.permissions;
	if (!Array.isArray(held)) return false;
	return held.includes(ALL) || held.includes(`${productId}:${permission}`);
};

/**
 * The permission keys of this product a verified user holds, out of some asked for.
 * @param {{ permissions?: readonly string[] } | null | undefined} user
 * @param {string} productId
 * @param {readonly string[]} wanted
 * @returns {string[]}
 */
export const grantedOf = (user, productId, wanted) => wanted.filter((key) => grants(user, productId, key));

/** What a refused sign-in tells the merchant's server (the failure code of `verifyIdentityToken`). @type {Record<string, string>} */
export const SIGN_IN_DETAIL = Object.freeze({
	accounts_not_connected: "Accounts is not on this website: add it in the Portal so this product can take sign-ins.",
	audience: 'The sign-in was made for another website.',
	expired: 'The sign-in has expired. Renew it at Accounts and send the new one.',
	too_old: 'The sign-in is too old. Renew it at Accounts and send the new one.',
	not_yet_valid: 'The sign-in is not valid yet.',
	signature: 'The sign-in is not signed by the keys of this website’s Accounts.',
	unknown_key: 'The sign-in is signed by a key this website’s Accounts does not have.',
	issuer: 'The sign-in was not issued by this website’s Accounts.',
	algorithm: 'The sign-in uses a signature algorithm that is not accepted.',
	subject: 'The sign-in does not name a user.',
	malformed: 'SS-Sign-In must be the Accounts sign-in of the signed-in person.',
});

/**
 * The gate of a staff route of the server token: the verified Accounts sign-in of a staff member, whose role grants
 * `permission` when one is asked for (any staff role otherwise). Answers the problem that refuses the call, else null with
 * `ctx.actor` set to the verified person. Used by the request handler for every route that says `permission` or `staff`,
 * and by a route that is a runtime route for some calls only (`requireStaff`).
 * @param {{ staffSignIn: () => Promise<import('./identity.js').RequestSignIn | null>, actor: import('./actor.js').ActingUser | null }} ctx
 * @param {{ productId: string, permission?: string, headers?: Record<string, string> }} route `headers`: answer headers to add
 * @returns {Promise<import('./http/results.js').ProblemResult | null>}
 */
export const checkStaff = async (ctx, { productId, permission, headers }) => {
	const found = await ctx.staffSignIn();
	if (found === null)
		return problem(
			'needs_signed_in_staff',
			'This needs the signed-in staff member: send their Accounts sign-in in SS-Sign-In next to the server token. The server token alone cannot do it.',
		);
	if (!found.ok) {
		if (found.code === 'accounts_unavailable') {
			// eslint-disable-next-line no-param-reassign -- the answer's headers are the caller's to fill
			if (headers) headers['retry-after'] = '5';
			return problem('accounts_unavailable', 'The sign-in cannot be checked right now. Try again shortly.');
		}
		return problem('invalid_sign_in', SIGN_IN_DETAIL[found.code] ?? SIGN_IN_DETAIL.malformed, {
			extensions: { cause: found.code },
		});
	}
	const { user } = found;
	if (permission !== undefined && !grants(user, productId, permission))
		return problem(
			'forbidden',
			`The role of this person does not allow it: it needs the permission ${productId}:${permission}.`,
		);
	if (permission === undefined && !(Array.isArray(user.permissions) && user.permissions.length > 0))
		return problem('forbidden', 'This person has no staff role on this website.');
	// eslint-disable-next-line no-param-reassign -- the verified person is what the request acts as
	ctx.actor = {
		kind: 'user',
		id: user.id,
		name: user.name ?? user.email ?? user.id,
		...(user.role ? { role: user.role } : {}),
		...(user.email ? { email: user.email } : {}),
	};
	return null;
};
