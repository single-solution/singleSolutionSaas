/**
 * Public views of stored documents (pure) and JSON Merge Patch (RFC 7386) for `PATCH /v1/coupons/{id}`. Internal
 * fields (`_id`, `websiteId`, `merchantId`, `env`, `schemaVersion`, claim lists, optimistic versions) never leave.
 * @module
 */

/** Coupon fields a merchant may change with PATCH (code fields are fixed at creation). */
export const EDITABLE_FIELDS = Object.freeze([
	'name',
	'description',
	'status',
	'currency',
	'action',
	'eligibility',
	'limits',
	'stacking',
	'validity',
	'custom',
]);

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** @param {unknown} value */
const isoOrNull = (value) => (value instanceof Date ? value.toISOString() : typeof value === 'string' ? value : null);

/**
 * JSON Merge Patch: objects merge recursively, `null` removes a member, anything else replaces.
 * @param {unknown} target
 * @param {unknown} patch
 * @returns {unknown}
 */
export const mergePatch = (target, patch) => {
	if (!isObject(patch)) return structuredClone(patch);
	/** @type {Record<string, unknown>} */
	const out = isObject(target) ? structuredClone(target) : {};
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) delete out[key];
		else out[key] = mergePatch(out[key], value);
	}
	return out;
};

/**
 * The editable part of a coupon (what PATCH merges into).
 * @param {Record<string, any>} coupon
 * @returns {Record<string, unknown>}
 */
export const editableOf = (coupon) =>
	Object.fromEntries(
		EDITABLE_FIELDS.filter((key) => coupon[key] !== undefined && coupon[key] !== null).map((key) => [
			key,
			structuredClone(coupon[key]),
		]),
	);

/**
 * @param {Record<string, any>} coupon stored coupon
 */
export const couponView = (coupon) => ({
	id: coupon.id,
	name: coupon.name,
	description: coupon.description ?? '',
	status: coupon.status,
	mode: coupon.mode,
	currency: coupon.currency ?? null,
	action: coupon.action,
	eligibility: { when: coupon.eligibility?.when ?? '', conditions: coupon.eligibility?.conditions ?? [] },
	limits: {
		total: coupon.limits?.total ?? null,
		per_customer: coupon.limits?.per_customer ?? null,
		per_device: coupon.limits?.per_device ?? null,
		per_code: coupon.limits?.per_code ?? null,
	},
	stacking: coupon.stacking ?? {},
	validity: coupon.validity ?? {},
	custom: coupon.custom ?? {},
	codes: coupon.codeCount ?? 0,
	usage: { taken: coupon.counters?.taken ?? 0, redeemed: coupon.counters?.redeemed ?? 0 },
	createdAt: isoOrNull(coupon.createdAt),
	updatedAt: isoOrNull(coupon.updatedAt),
	archivedAt: isoOrNull(coupon.archivedAt),
});

/**
 * @param {Record<string, any>} code stored code
 */
export const codeView = (code) => ({
	code: code.code,
	couponId: code.couponId,
	status: code.status,
	maxUses: code.maxUses ?? null,
	taken: code.taken ?? 0,
	redeemed: code.redeemed ?? 0,
	remaining: typeof code.maxUses === 'number' ? Math.max(0, code.maxUses - (code.taken ?? 0)) : null,
	batchId: code.batchId ?? null,
	createdAt: isoOrNull(code.createdAt),
});

/**
 * @param {Record<string, any>} reservation stored reservation
 */
export const reservationView = (reservation) => ({
	id: reservation.id,
	status: reservation.status,
	reference: reservation.reference ?? null,
	orderId: reservation.orderId ?? null,
	customerId: reservation.customerId ?? null,
	codes: (reservation.coupons ?? []).map((/** @type {{ code: string }} */ coupon) => coupon.code),
	coupons: (reservation.coupons ?? []).map((/** @type {Record<string, any>} */ coupon) => ({
		couponId: coupon.couponId,
		code: coupon.code,
		discount: coupon.discount,
		shippingDiscount: coupon.shippingDiscount,
		freeShipping: coupon.freeShipping,
		gifts: coupon.gifts ?? [],
		lines: coupon.lines ?? [],
	})),
	currency: reservation.cart?.currency ?? null,
	totals: reservation.totals ?? null,
	loyaltyAllowed: reservation.loyaltyAllowed ?? true,
	dealsAllowed: reservation.dealsAllowed ?? true,
	expiresAt: reservation.expiresAt ?? null,
	createdAt: isoOrNull(reservation.createdAt),
	redeemedAt: reservation.redeemedAt ?? null,
	releasedAt: reservation.releasedAt ?? null,
	releaseReason: reservation.releaseReason ?? null,
});

/**
 * A stack result as the API returns it (quotes and validations).
 * @param {import('./stacking.js').StackResult} stack
 * @param {string} currency
 */
export const quoteView = (stack, currency) => ({
	currency,
	subtotal: stack.subtotal,
	discount: stack.discount,
	shipping: stack.shipping,
	shippingDiscount: stack.shippingDiscount,
	total: stack.total,
	freeShipping: stack.freeShipping,
	gifts: stack.gifts,
	lines: stack.lines,
	applied: stack.applied.map((coupon) => ({
		couponId: coupon.couponId,
		code: coupon.code,
		name: coupon.name,
		class: coupon.class,
		discount: coupon.discount,
		shippingDiscount: coupon.shippingDiscount,
		freeShipping: coupon.freeShipping,
		gifts: coupon.gifts,
		lines: coupon.lines,
	})),
	rejected: stack.rejected.map((entry) => ({ code: entry.code, reason: entry.reason })),
	loyaltyAllowed: stack.loyaltyAllowed,
	dealsAllowed: stack.dealsAllowed,
});
