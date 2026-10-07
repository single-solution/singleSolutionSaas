/**
 * Presentation of stored records (API shapes). Hashes, sealed secrets and token material never leave here.
 * @module
 */

/** @param {Date | null | undefined} d */
export const iso = (d) => (d instanceof Date ? d.toISOString() : null);

/** @param {Record<string, any>} a two-step state of a login */
export const twoStepOf = (a) => ({
	enabled: Boolean(a.totp),
	recoveryCodesLeft: a.totp ? (a.recoveryHashes ?? []).length : 0,
});

/**
 * A merchant as admins and the merchant itself see it (PLAN 0.2 Merchants). The suspension reason is internal: it is
 * shown to admins only (`forAdmin`).
 * @param {Record<string, any>} m
 * @param {{ forAdmin?: boolean }} [options]
 */
export const presentMerchant = (m, { forAdmin = true } = {}) => ({
	merchantId: String(m._id),
	name: m.name,
	ownerName: m.ownerName ?? null,
	email: m.email ?? null,
	phone: m.phone ?? null,
	address: m.address ?? null,
	country: m.country ?? null,
	status: m.status,
	setupPending: m.status !== 'deleted' && !m.passwordHash,
	twoStep: twoStepOf(m),
	...(forAdmin
		? {
				suspension: m.suspension ? { reason: m.suspension.reason, at: iso(m.suspension.at), by: m.suspension.by } : null,
				lastSignInAt: iso(m.lastSignInAt),
			}
		: {}),
	createdAt: iso(m.createdAt),
	deletedAt: iso(m.deletedAt),
});

/** @param {Record<string, any>} w */
export const presentWebsite = (w) => ({
	websiteId: String(w._id),
	merchantId: w.merchantId,
	domain: w.domain,
	status: w.status,
	createdAt: iso(w.createdAt),
	removedAt: iso(w.removedAt),
});

/** @param {Record<string, any>} a */
export const presentAdmin = (a) => ({
	adminId: String(a._id),
	name: a.name ?? null,
	email: a.email,
	role: a.role,
	status: a.status,
	twoStep: twoStepOf(a),
	lastSignInAt: iso(a.lastSignInAt),
	createdAt: iso(a.createdAt),
});
