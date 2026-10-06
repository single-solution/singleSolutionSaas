/**
 * Presentation of stored records (API shapes). Hashes, sealed secrets and token material never leave here.
 * @module
 */

/** @param {Date | null | undefined} d */
export const iso = (d) => (d instanceof Date ? d.toISOString() : null);

/** @param {Record<string, any>} m */
export const presentMerchant = (m) => ({
	merchantId: String(m._id),
	name: m.name,
	status: m.status,
	ownerUserId: m.ownerUserId ?? null,
	suspension: m.suspension ? { reason: m.suspension.reason, at: iso(m.suspension.at), by: m.suspension.by } : null,
	createdAt: iso(m.createdAt),
});

/** @param {Record<string, any>} w */
export const presentWebsite = (w) => ({
	websiteId: String(w._id),
	merchantId: w.merchantId,
	domain: w.domain,
	env: w.env,
	twinId: w.twinId,
	status: w.status,
	// website settings (F.16): products read them from the entitlement document's `website` section
	timeZone: w.settings?.timeZone ?? null,
	language: w.settings?.language ?? null,
	currency: w.settings?.currency ?? null,
	createdAt: iso(w.createdAt),
	deletedAt: iso(w.deletedAt),
});

/** @param {Record<string, any>} u */
const mfaOf = (u) => ({ enabled: Boolean(u.totp), recoveryCodesLeft: u.totp ? (u.recoveryHashes ?? []).length : 0 });

/** @param {Record<string, any>} u */
export const presentUser = (u) => ({
	userId: String(u._id),
	email: u.email,
	name: u.name ?? null,
	status: u.status,
	mfa: mfaOf(u),
	createdAt: iso(u.createdAt),
});

/** @param {Record<string, any>} s */
export const presentStaff = (s) => ({
	staffId: String(s._id),
	login: s.login ?? null,
	email: s.email ?? null,
	name: s.name ?? null,
	roles: [...(s.roles ?? [])],
	status: s.status,
	mfa: mfaOf(s),
	passwordSet: Boolean(s.passwordHash),
	createdAt: iso(s.createdAt),
});

/**
 * @param {Record<string, any>} m membership
 * @param {Record<string, any> | null | undefined} user
 */
export const presentMember = (m, user) => ({
	userId: m.userId,
	email: user?.email ?? null,
	name: user?.name ?? null,
	roles: [...(m.roles ?? [])],
	grants: (m.grants ?? []).map((/** @type {any} */ g) => ({ websiteId: g.websiteId, roles: [...g.roles] })),
	status: user?.status ?? 'unknown',
	createdAt: iso(m.createdAt),
});

/** @param {Record<string, any>} i */
export const presentInvite = (i) => ({
	inviteId: String(i._id),
	email: i.email,
	roles: [...(i.roles ?? [])],
	grants: (i.grants ?? []).map((/** @type {any} */ g) => ({ websiteId: g.websiteId, roles: [...g.roles] })),
	status: i.status,
	expiresAt: iso(i.expiresAt),
	createdAt: iso(i.createdAt),
});

/**
 * Partner or developer.
 * @param {Record<string, any>} p
 * @param {'partnerId' | 'developerId'} idKey
 */
export const presentParty = (p, idKey) => ({
	[idKey]: String(p._id),
	name: p.name,
	email: p.email,
	status: p.status,
	grants: (p.grants ?? []).map((/** @type {any} */ g) => ({ ...g, ...(g.at ? { at: iso(g.at) } : {}) })),
	createdAt: iso(p.createdAt),
});
