/**
 * Return and warranty claims (PLAN 0.8.8: claims with time windows per item/grade, photos, approval, refund through
 * Payments when paid online, restock exactly once). Pure rules: the windows of an order line (the product's own days,
 * else its condition grade's, else the `returns` settings), what is still claimable, checking a shopper's claim, the
 * staff moves between statuses, the refund cap and the loyalty points taken back. No I/O.
 * @module
 */

/** @typedef {import('./model.js').ReturnRecord} ReturnRecord */
/** @typedef {import('./model.js').OrderRecord} OrderRecord */
/** @typedef {import('./model.js').OrderLineRecord} OrderLineRecord */
/** @typedef {ReturnRecord['status']} ClaimStatus */
/** @typedef {ReturnRecord['kind']} ClaimKind */

export const DAY_MS = 86_400_000;
/** Lines in one claim, at most. */
export const MAX_CLAIM_LINES = 50;
/** Longest reason. */
export const MAX_REASON = 1000;
/** Longest staff note. */
export const MAX_NOTE = 1000;
/** Photo uploads and photo links last this long. */
export const PHOTO_SECONDS = 300;
/** Photo types a shopper may upload, with their file extension. */
export const PHOTO_TYPES = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' });
export const CLAIM_KINDS = Object.freeze(/** @type {ClaimKind[]} */ (['return', 'warranty']));
export const CLAIM_STATUSES = Object.freeze(
	/** @type {ClaimStatus[]} */ (['requested', 'approved', 'rejected', 'received', 'refunded', 'closed']),
);

/**
 * What the merchant's staff do to a claim, from which statuses, and the status it leads to (refund keeps refunding
 * possible for a top-up; restock does not change the status).
 * @type {Readonly<Record<'approve' | 'reject' | 'receive' | 'refund' | 'close' | 'restock', { from: ClaimStatus[], to: ClaimStatus | null }>>}
 */
export const CLAIM_ACTIONS = Object.freeze({
	approve: { from: ['requested'], to: 'approved' },
	reject: { from: ['requested', 'approved', 'received'], to: 'rejected' },
	receive: { from: ['approved'], to: 'received' },
	refund: { from: ['approved', 'received', 'refunded'], to: 'refunded' },
	close: { from: ['approved', 'received', 'refunded'], to: 'closed' },
	restock: { from: ['approved', 'received', 'refunded', 'closed'], to: null },
});

/** @typedef {keyof typeof CLAIM_ACTIONS} ClaimAction */

/**
 * The actions possible on a claim now.
 * @param {Pick<ReturnRecord, 'status' | 'restockedAt'>} claim
 * @returns {ClaimAction[]}
 */
export const actionsOf = (claim) =>
	/** @type {ClaimAction[]} */ (Object.keys(CLAIM_ACTIONS)).filter(
		(action) => CLAIM_ACTIONS[action].from.includes(claim.status) && !(action === 'restock' && claim.restockedAt !== null),
	);

/**
 * Whether a claim holds its units (they cannot be claimed again): every claim except a rejected one and a warranty
 * claim closed without a refund (a repair: the item went back to the shopper).
 * @param {Pick<ReturnRecord, 'status' | 'kind' | 'refundAmount'>} claim
 */
export const holdsUnits = (claim) =>
	claim.status !== 'rejected' && !(claim.kind === 'warranty' && claim.status === 'closed' && claim.refundAmount === 0);

/**
 * Units of each order line held by claims.
 * @param {Array<Pick<ReturnRecord, 'status' | 'kind' | 'refundAmount' | 'lines'>>} claims
 * @returns {Map<string, { quantity: number, serials: Set<string> }>}
 */
export const claimedByLine = (claims) => {
	/** @type {Map<string, { quantity: number, serials: Set<string> }>} */
	const held = new Map();
	for (const claim of claims) {
		if (!holdsUnits(claim)) continue;
		for (const line of claim.lines) {
			const found = held.get(line.lineId) ?? { quantity: 0, serials: new Set() };
			found.quantity += line.quantity;
			for (const serial of line.serials) found.serials.add(serial);
			held.set(line.lineId, found);
		}
	}
	return held;
};

/**
 * A condition grade of the `grades` list as this part reads it (days are optional).
 * @typedef {{ key: string, label?: string, returnDays?: number | null, warrantyDays?: number | null }} GradeDays
 */

/**
 * @typedef {{ returnDays: number, warrantyDays: number }} WindowDefaults the `returns` settings
 * @typedef {{ days: number, until: Date | null, open: boolean }} ClaimWindow
 */

/** @param {unknown} value @returns {value is number} */
const isDays = (value) => Number.isSafeInteger(value) && Number(value) >= 0;

/**
 * Days of a line's window of one kind: the product's own, else its grade's, else the setting.
 * @param {ClaimKind} kind
 * @param {{ returnDays: number | null, warrantyDays: number | null } | null} product the product now (null: deleted)
 * @param {GradeDays | null} grade
 * @param {WindowDefaults} defaults
 */
export const windowDays = (kind, product, grade, defaults) => {
	const field = kind === 'return' ? 'returnDays' : 'warrantyDays';
	const own = product?.[field];
	if (isDays(own)) return own;
	const graded = grade?.[field];
	if (isDays(graded)) return graded;
	return isDays(defaults[field]) ? defaults[field] : 0;
};

/**
 * A window counted from delivery.
 * @param {number} days
 * @param {Date | null} deliveredAt
 * @param {number} now
 * @returns {ClaimWindow}
 */
export const windowOf = (days, deliveredAt, now) => {
	if (!deliveredAt || days <= 0) return { days, until: null, open: false };
	const until = new Date(deliveredAt.getTime() + days * DAY_MS);
	return { days, until, open: now <= until.getTime() };
};

/**
 * What can still be claimed on each line of a delivered order (only physical items are claimed).
 * @param {{ order: Pick<OrderRecord, 'lines' | 'deliveredAt'>, claims: Array<Pick<ReturnRecord, 'status' | 'kind' | 'refundAmount' | 'lines'>>,
 *   products: Map<string, { returnDays: number | null, warrantyDays: number | null }>, grades: GradeDays[], defaults: WindowDefaults,
 *   now: number }} input
 */
export const returnableLines = ({ order, claims, products, grades, defaults, now }) => {
	const held = claimedByLine(claims);
	return order.lines
		.filter((line) => line.kind === 'physical')
		.map((line) => {
			const product = products.get(line.productId) ?? null;
			const grade = line.grade ? (grades.find((entry) => entry.key === line.grade) ?? null) : null;
			const taken = held.get(line.id);
			const claimable = Math.max(0, line.quantity - (taken?.quantity ?? 0));
			return {
				line,
				claimable,
				freeSerials: line.serials.filter((serial) => !taken?.serials.has(serial)),
				return: windowOf(windowDays('return', product, grade, defaults), order.deliveredAt, now),
				warranty: windowOf(windowDays('warranty', product, grade, defaults), order.deliveredAt, now),
			};
		});
};

/** @typedef {ReturnType<typeof returnableLines>[number]} ReturnableLine */

/**
 * @typedef {{ orderId: string, kind: ClaimKind, lines: Array<{ lineId: string, quantity: number }>, reason: string,
 *   photos: string[] }} ClaimInput
 */

/** @param {unknown} value */
const plain = (value) =>
	typeof value === 'string'
		? value
				// eslint-disable-next-line no-control-regex
				.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
				.trim()
		: '';

/**
 * Plain text: control characters removed (new lines kept), trimmed.
 * @param {unknown} value
 */
export const plainText = plain;

/**
 * Check a shopper's claim.
 * @param {unknown} body
 * @param {{ maxPhotos: number }} limits
 * @returns {{ ok: true, value: ClaimInput } | { ok: false, field: string, message: string }}
 */
export const checkClaimInput = (body, { maxPhotos }) => {
	const input = typeof body === 'object' && body !== null ? /** @type {Record<string, unknown>} */ (body) : {};
	if (typeof input.orderId !== 'string' || !/^ord_[A-Za-z0-9]{1,64}$/.test(input.orderId))
		return { ok: false, field: 'orderId', message: 'Name the order.' };
	if (!CLAIM_KINDS.includes(/** @type {ClaimKind} */ (input.kind)))
		return { ok: false, field: 'kind', message: 'kind is return or warranty.' };
	if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > MAX_CLAIM_LINES)
		return { ok: false, field: 'lines', message: `Choose 1 to ${MAX_CLAIM_LINES} items.` };
	/** @type {ClaimInput['lines']} */
	const lines = [];
	for (const [index, raw] of input.lines.entries()) {
		const line = typeof raw === 'object' && raw !== null ? /** @type {Record<string, unknown>} */ (raw) : {};
		if (typeof line.lineId !== 'string' || line.lineId.length > 80 || lines.some((l) => l.lineId === line.lineId))
			return { ok: false, field: `lines/${index}/lineId`, message: 'Name each item once.' };
		if (!Number.isSafeInteger(line.quantity) || Number(line.quantity) < 1)
			return { ok: false, field: `lines/${index}/quantity`, message: 'The quantity is a whole number from 1.' };
		lines.push({ lineId: line.lineId, quantity: Number(line.quantity) });
	}
	const reason = plain(input.reason);
	if (reason === '' || reason.length > MAX_REASON)
		return { ok: false, field: 'reason', message: `Say why, in at most ${MAX_REASON} characters.` };
	const photos = input.photos ?? [];
	if (!Array.isArray(photos) || photos.length > maxPhotos || !photos.every((key) => typeof key === 'string'))
		return { ok: false, field: 'photos', message: `Add at most ${maxPhotos} photos.` };
	if (new Set(photos).size !== photos.length) return { ok: false, field: 'photos', message: 'Add each photo once.' };
	return { ok: true, value: { orderId: input.orderId, kind: /** @type {ClaimKind} */ (input.kind), lines, reason, photos } };
};

/**
 * The claim's lines if every one is claimable now (its window of this kind open, enough units left), with the serial
 * numbers of the units claimed (the line's serials not held by other claims, in order).
 * @param {ClaimKind} kind
 * @param {ClaimInput['lines']} wanted
 * @param {ReturnableLine[]} returnable
 * @returns {{ ok: true, lines: ReturnRecord['lines'] } | { ok: false, lineId: string, reason: 'unknown' | 'window_closed' | 'quantity' }}
 */
export const planClaim = (kind, wanted, returnable) => {
	/** @type {ReturnRecord['lines']} */
	const lines = [];
	for (const want of wanted) {
		const found = returnable.find((entry) => entry.line.id === want.lineId);
		if (!found) return { ok: false, lineId: want.lineId, reason: 'unknown' };
		if (!found[kind].open) return { ok: false, lineId: want.lineId, reason: 'window_closed' };
		if (want.quantity > found.claimable) return { ok: false, lineId: want.lineId, reason: 'quantity' };
		lines.push({ lineId: want.lineId, quantity: want.quantity, serials: found.freeSerials.slice(0, want.quantity) });
	}
	return { ok: true, lines };
};

/**
 * What a claim's lines were paid: each line's total × the claimed units / the units bought (rounded down).
 * @param {Pick<OrderRecord, 'lines'>} order
 * @param {Pick<ReturnRecord, 'lines'>} claim
 */
export const claimValue = (order, claim) =>
	claim.lines.reduce((sum, claimed) => {
		const line = order.lines.find((entry) => entry.id === claimed.lineId);
		return line && line.quantity > 0 ? sum + Math.floor((line.total * claimed.quantity) / line.quantity) : sum;
	}, 0);

/**
 * The most that can still be refunded on a claim: what its lines were paid minus what this claim refunded, never more
 * than the order's total minus everything refunded on it.
 * @param {Pick<OrderRecord, 'lines' | 'totals' | 'payment'>} order
 * @param {Pick<ReturnRecord, 'lines' | 'refundAmount'>} claim
 */
export const refundCap = (order, claim) =>
	Math.max(0, Math.min(claimValue(order, claim) - claim.refundAmount, order.totals.total - order.payment.refunded));

/**
 * Whether the order was paid online through Payments (a refund then goes through Payments).
 * @param {Pick<OrderRecord, 'payment'>} order
 */
export const paidOnline = (order) =>
	Boolean(order.payment.paymentId) && (order.payment.state === 'paid' || order.payment.state === 'partially_refunded');

/**
 * The order's payment state after `refunded` in total was given back.
 * @param {Pick<OrderRecord, 'payment' | 'totals'>} order
 * @param {number} refunded
 * @returns {'refunded' | 'partially_refunded'}
 */
export const refundedState = (order, refunded) =>
	refunded >= (order.payment.paid > 0 ? order.payment.paid : order.totals.total) ? 'refunded' : 'partially_refunded';

/**
 * Loyalty points earned on the returned part of an order, to take back (in proportion to what the lines were paid).
 * @param {Pick<OrderRecord, 'lines' | 'promotions'>} order
 * @param {Pick<ReturnRecord, 'lines'>} claim
 */
export const pointsToReverse = (order, claim) => {
	const earned = order.promotions.pointsEarned;
	const paid = order.lines.reduce((sum, line) => sum + line.total, 0);
	if (earned <= 0 || paid <= 0) return 0;
	return Math.min(earned, Math.floor((earned * claimValue(order, claim)) / paid));
};

/**
 * A short reference of a claim for people (`R-3F9A2C`).
 * @param {string} id
 */
export const claimReference = (id) => `R-${id.slice(-6).toUpperCase()}`;

/**
 * The storage folder of a shopper's claim photos (`ecommerce/returns/<user>/`).
 * @param {string} userId
 */
export const photoFolder = (userId) => `ecommerce/returns/${userId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)}/`;

/**
 * Whether a key names a photo upload of this shopper.
 * @param {string} key
 * @param {string} userId
 */
export const isPhotoKey = (key, userId) => {
	const folder = photoFolder(userId);
	return key.startsWith(folder) && /^[A-Za-z0-9_]{1,64}\.(jpg|png|webp)$/.test(key.slice(folder.length));
};

/**
 * Check a photo upload request.
 * @param {unknown} body
 * @param {{ photoMaxMb: number }} limits
 * @returns {{ ok: true, type: keyof typeof PHOTO_TYPES, extension: string, size: number } | { ok: false, field: string, message: string }}
 */
export const checkPhotoInput = (body, { photoMaxMb }) => {
	const input = typeof body === 'object' && body !== null ? /** @type {Record<string, unknown>} */ (body) : {};
	const type = typeof input.type === 'string' && Object.hasOwn(PHOTO_TYPES, input.type) ? input.type : null;
	if (!type) return { ok: false, field: 'type', message: 'Upload a JPEG, PNG or WebP photo.' };
	if (!Number.isSafeInteger(input.size) || Number(input.size) < 1 || Number(input.size) > photoMaxMb * 1_048_576)
		return { ok: false, field: 'size', message: `The largest photo is ${photoMaxMb} MB.` };
	const key = /** @type {keyof typeof PHOTO_TYPES} */ (type);
	return { ok: true, type: key, extension: PHOTO_TYPES[key], size: Number(input.size) };
};

/**
 * Check a staff note (optional unless `required`).
 * @param {unknown} value
 * @param {boolean} [required]
 * @returns {{ ok: true, note: string } | { ok: false, message: string }}
 */
export const checkNote = (value, required = false) => {
	const note = plain(value);
	if (note.length > MAX_NOTE) return { ok: false, message: `The note is at most ${MAX_NOTE} characters.` };
	if (required && note === '') return { ok: false, message: 'Add a note for the shopper.' };
	return { ok: true, note };
};
