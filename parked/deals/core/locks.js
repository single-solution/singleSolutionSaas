/**
 * Price locks (pure): "honour the price the shopper was shown for N minutes". Ported from ibrahimMobiles
 * `cartOfferLock.ts` (a catalog deal locked onto a cart line when it was added, honoured even after the deal lapsed),
 * made stateless: a lock is a signed token (adapters/locks.js, HMAC) over these claims —
 *
 *   { v: 1, w: websiteId, cur: currency, i: itemId, vr: variantId | null, u: base unit amount, p: locked unit price,
 *     n: units covered, d: deal ids, k: their stacking classes, c: customer id | null, iat, exp (seconds) }
 *
 * — so any instance verifies it without a database. A quote that carries the token honours `p` on the matching line
 * while the lock is valid. Stale behaviour is configuration (`price_locks`): an expired lock is repriced or refused;
 * a changed base price keeps the lock (never above the new list price) or reprices. Usage and stock limits are still
 * enforced when the order commits.
 * @module
 */

/**
 * @typedef {object} LockClaims
 * @property {1} v
 * @property {string} w
 * @property {string} cur
 * @property {string} i
 * @property {string | null} vr
 * @property {number} u
 * @property {number} p
 * @property {number} n
 * @property {string[]} d
 * @property {string[]} k
 * @property {string | null} c
 * @property {number} iat
 * @property {number} exp
 */
/**
 * @typedef {object} LockPolicy
 * @property {'reprice' | 'reject'} onExpired
 * @property {'honor' | 'reprice'} onBasePriceChange
 * @property {number} graceSeconds tolerated clock skew past `exp`
 */

/**
 * Claims of a lock for one evaluated line.
 * @param {{ websiteId: string, currency: string, itemId: string, variantId: string | null, unitAmount: number,
 *   unitPrice: number, units: number, dealIds: string[], classes: string[], customerId: string | null,
 *   ttlMinutes: number, now: number }} input
 * @returns {LockClaims}
 */
export const lockClaims = ({
	websiteId,
	currency,
	itemId,
	variantId,
	unitAmount,
	unitPrice,
	units,
	dealIds,
	classes,
	customerId,
	ttlMinutes,
	now,
}) => {
	const iat = Math.floor(now / 1000);
	return {
		v: 1,
		w: websiteId,
		cur: currency,
		i: itemId,
		vr: variantId,
		u: unitAmount,
		p: unitPrice,
		n: units,
		d: dealIds,
		k: [...new Set(classes)],
		c: customerId,
		iat,
		exp: iat + Math.max(1, Math.floor(ttlMinutes)) * 60,
	};
};

/**
 * Structural check of decoded claims.
 * @param {unknown} value
 * @returns {value is LockClaims}
 */
export const isLockClaims = (value) => {
	if (!value || typeof value !== 'object') return false;
	const c = /** @type {Record<string, unknown>} */ (value);
	const ints = ['u', 'p', 'n', 'iat', 'exp'].every((key) => Number.isSafeInteger(c[key]) && /** @type {number} */ (c[key]) >= 0);
	return (
		c.v === 1 &&
		ints &&
		typeof c.w === 'string' &&
		typeof c.cur === 'string' &&
		typeof c.i === 'string' &&
		(c.vr === null || typeof c.vr === 'string') &&
		(c.c === null || typeof c.c === 'string') &&
		Array.isArray(c.d) &&
		c.d.length > 0 &&
		c.d.every((x) => typeof x === 'string') &&
		Array.isArray(c.k) &&
		c.k.every((x) => typeof x === 'string')
	);
};

/**
 * What a verified lock means for a cart line.
 * @param {LockClaims} claims
 * @param {{ websiteId: string, currency: string, line: import('./scope.js').Line, customerId: string | null, now: number,
 *   policy: LockPolicy }} input
 * @returns {{ status: 'honoured', candidate: import('./evaluate.js').LockCandidate }
 *   | { status: 'stale', reason: 'expired' | 'base_price_changed' }
 *   | { status: 'mismatch', reason: 'website' | 'currency' | 'item' | 'customer' }}
 */
export const applyLock = (claims, { websiteId, currency, line, customerId, now, policy }) => {
	if (claims.w !== websiteId) return { status: 'mismatch', reason: 'website' };
	if (claims.cur !== currency) return { status: 'mismatch', reason: 'currency' };
	if (claims.i !== line.itemId || claims.vr !== line.variantId) return { status: 'mismatch', reason: 'item' };
	if (claims.c !== null && claims.c !== customerId) return { status: 'mismatch', reason: 'customer' };
	if (now / 1000 > claims.exp + Math.max(0, policy.graceSeconds)) return { status: 'stale', reason: 'expired' };
	if (claims.u !== line.unitAmount && policy.onBasePriceChange === 'reprice')
		return { status: 'stale', reason: 'base_price_changed' };
	return {
		status: 'honoured',
		candidate: {
			lock: true,
			id: `lock:${line.lineId}`,
			lineId: line.lineId,
			unitPrice: Math.min(claims.p, line.unitAmount),
			maxUnits: claims.n,
			dealIds: claims.d,
			classes: claims.k,
			priority: Number.MAX_SAFE_INTEGER,
		},
	};
};
