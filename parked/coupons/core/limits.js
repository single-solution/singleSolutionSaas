/**
 * Usage limits and abuse controls (pure decisions; the repositories apply them with atomic conditional counters).
 *
 * A reservation **claims** one unit of every limit that applies to each of its codes:
 * - `code:<code>` — uses of the code (`limits.per_code`; 1 = single-use, null = unlimited);
 * - `coupon:<couponId>` — uses of the coupon across all its codes (`limits.total`);
 * - `customer:<couponId>:<subject>` — uses per customer (`limits.per_customer`, needs an identity);
 * - `device:<couponId>:<subject>` — uses per device (`limits.per_device`, from `context.deviceId`).
 *
 * Each claim is a single `$inc` guarded by `taken < max`, so two concurrent checkouts can never both take the last use.
 * A claim that fails releases the claims taken before it. Released and expired reservations give their claims back;
 * confirmed redemptions keep them.
 * @module
 */

/**
 * @typedef {object} Claim
 * @property {'code' | 'coupon' | 'customer' | 'device'} kind
 * @property {string} key stable claim name stored on the reservation
 * @property {string} couponId
 * @property {string} code
 * @property {number | null} max null = unlimited (the claim still counts usage)
 * @property {string} [subject] customer id / device id (customer and device claims)
 */

/**
 * Claims for one code of a reservation.
 * @param {{ coupon: Record<string, any>, code: Record<string, any>, customerId: string | null, deviceId: string | null,
 *   defaultPerCustomer: number, hash: (text: string) => string }} input
 * @returns {Claim[]}
 */
export const claimsFor = ({ coupon, code, customerId, deviceId, defaultPerCustomer, hash }) => {
	const limits = coupon.limits ?? {};
	/** @type {Claim[]} */
	const claims = [
		{
			kind: 'code',
			key: `code:${code.code}`,
			couponId: coupon.id,
			code: code.code,
			max: typeof code.maxUses === 'number' ? code.maxUses : null,
		},
		{
			kind: 'coupon',
			key: `coupon:${coupon.id}`,
			couponId: coupon.id,
			code: code.code,
			max: typeof limits.total === 'number' ? limits.total : null,
		},
	];
	const perCustomer =
		typeof limits.per_customer === 'number' ? limits.per_customer : defaultPerCustomer > 0 ? defaultPerCustomer : null;
	if (perCustomer !== null && customerId)
		claims.push({
			kind: 'customer',
			key: `customer:${coupon.id}:${hash(customerId)}`,
			couponId: coupon.id,
			code: code.code,
			max: perCustomer,
			subject: customerId,
		});
	if (typeof limits.per_device === 'number' && deviceId)
		claims.push({
			kind: 'device',
			key: `device:${coupon.id}:${hash(deviceId)}`,
			couponId: coupon.id,
			code: code.code,
			max: limits.per_device,
			subject: deviceId,
		});
	return claims;
};

/**
 * The refusal reason when a claim of this kind cannot be taken.
 * @param {Claim['kind']} kind
 */
export const claimRefusal = (kind) =>
	kind === 'customer' ? 'customer_limit_reached' : kind === 'device' ? 'device_limit_reached' : 'exhausted';

/**
 * Parse a stored claim key back into its parts.
 * @param {string} key
 * @returns {{ kind: string, couponId: string | null, code: string | null, hashed: string | null }}
 */
export const parseClaimKey = (key) => {
	const [kind = '', a = '', b = ''] = key.split(':');
	if (kind === 'code') return { kind, couponId: null, code: key.slice('code:'.length), hashed: null };
	if (kind === 'coupon') return { kind, couponId: a, code: null, hashed: null };
	return { kind, couponId: a, code: null, hashed: b };
};

/**
 * Subject of velocity limits: the customer, else the device, else the network address (hashed by the caller).
 * @param {{ customerId: string | null, deviceId: string | null, address: string | null }} input
 * @returns {string | null}
 */
export const velocitySubject = ({ customerId, deviceId, address }) =>
	customerId ? `c:${customerId}` : deviceId ? `d:${deviceId}` : address ? `a:${address}` : null;

/**
 * Start of the fixed velocity window containing `now`.
 * @param {number} now
 * @param {number} windowMinutes
 */
export const windowStart = (now, windowMinutes) => {
	const size = Math.max(1, Math.floor(windowMinutes)) * 60_000;
	return Math.floor(now / size) * size;
};

/**
 * Is a blocklist entry matching this request?
 * @param {ReadonlyArray<{ kind: string, value: string }>} blocks
 * @param {{ customerId: string | null, email: string | null, deviceId: string | null, code: string | null }} subject
 */
export const isBlocked = (blocks, subject) =>
	blocks.some(
		(block) =>
			(block.kind === 'customer' && block.value === subject.customerId) ||
			(block.kind === 'email' && subject.email !== null && block.value === subject.email) ||
			(block.kind === 'device' && block.value === subject.deviceId) ||
			(block.kind === 'code' && block.value === subject.code),
	);
