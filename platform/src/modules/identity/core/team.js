/**
 * Pure team rules: who may be changed, what a membership must contain, and ownership transfer.
 * @module
 */

/** @typedef {{ websiteId: string, roles: string[] }} Grant */
/** @typedef {{ userId: string, roles: string[], grants: Grant[] }} Member */

/**
 * @param {Pick<Member, 'roles'>} member
 */
export const isOwner = (member) => member.roles.includes('owner');

/**
 * A membership must grant something: merchant-wide roles or at least one website grant.
 * @param {string[]} roles
 * @param {Grant[]} grants
 */
export const grantsSomething = (roles, grants) => roles.length > 0 || grants.length > 0;

/**
 * Website ids in `grants` that are not among the merchant's live websites.
 * @param {Grant[]} grants
 * @param {ReadonlySet<string>} liveWebsiteIds
 * @returns {string[]}
 */
export const unknownGrantWebsites = (grants, liveWebsiteIds) =>
	grants.map((grant) => grant.websiteId).filter((id) => !liveWebsiteIds.has(id));

/**
 * Validate a role/grant change for a member.
 * @param {Member} target
 * @param {{ roles?: string[], grants?: Grant[] }} change
 * @returns {{ ok: true, roles: string[], grants: Grant[] } | { ok: false, code: 'owner_protected' | 'validation_failed', message: string }}
 */
export const applyMemberChange = (target, change) => {
	if (isOwner(target))
		return { ok: false, code: 'owner_protected', message: 'The owner cannot be changed; transfer ownership first.' };
	const roles = change.roles ?? target.roles;
	const grants = change.grants ?? target.grants;
	if (!grantsSomething(roles, grants))
		return { ok: false, code: 'validation_failed', message: 'A member needs roles or website grants.' };
	return { ok: true, roles, grants };
};

/**
 * Validate an ownership transfer.
 * @param {Member | null} target
 * @param {string} currentOwnerId
 * @returns {{ ok: true } | { ok: false, code: 'not_found' | 'conflict', message: string }}
 */
export const checkOwnerTransfer = (target, currentOwnerId) => {
	if (!target) return { ok: false, code: 'not_found', message: 'The new owner must be a member of this merchant.' };
	if (target.userId === currentOwnerId)
		return { ok: false, code: 'conflict', message: 'This member already owns the merchant.' };
	return { ok: true };
};

/**
 * Merchant status transitions (staff only, with a reason).
 * @param {'active' | 'suspended'} from
 * @param {'active' | 'suspended'} to
 */
export const statusTransition = (from, to) => from !== to;
