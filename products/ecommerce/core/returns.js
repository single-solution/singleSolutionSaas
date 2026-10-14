/**
 * Return, warranty and exchange claims (PLAN 0.8.8: claims with time windows per item/grade, photos, approval, refund
 * through Payments when paid online, restock exactly once; E33: exchange claims, fixed reasons, replaced and repaired
 * outcomes, restock per line, refund method and reference, delivery inside the refund cap, the reference prefix).
 * Pure rules: the windows of an order line (the product's own days, else its condition grade's, else the `returns`
 * settings), what is still claimable, checking a shopper's claim, the staff moves between statuses, the refund cap and
 * the loyalty points taken back. No I/O.
 * @module
 */
import { gradesFor } from './grades.js';

/** @typedef {import('./model.js').ReturnRecord} ReturnRecord */
/** @typedef {import('./model.js').OrderRecord} OrderRecord */
/** @typedef {import('./model.js').OrderLineRecord} OrderLineRecord */
/** @typedef {ReturnRecord['status']} ClaimStatus */
/** @typedef {ReturnRecord['kind']} ClaimKind */

export const DAY_MS = 86_400_000;
/** Lines in one claim, at most. */
const MAX_CLAIM_LINES = 50;
/** Longest reason. */
const MAX_REASON = 1000;
/** Longest staff note. */
const MAX_NOTE = 1000;
/** Longest refund reference. */
const MAX_REFERENCE = 120;
/** Photo uploads and photo links last this long. */
export const PHOTO_SECONDS = 300;
/** Photo types a shopper may upload, with their file extension. */
const PHOTO_TYPES = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' });
export const CLAIM_KINDS = Object.freeze(/** @type {ClaimKind[]} */ (['return', 'warranty', 'exchange']));
export const CLAIM_STATUSES = Object.freeze(
	/** @type {ClaimStatus[]} */ (['requested', 'approved', 'rejected', 'received', 'refunded', 'replaced', 'repaired', 'closed']),
);
/** How a refund was given back: `online` through Payments, the rest recorded by staff (E33, as E26). */
export const REFUND_METHODS = Object.freeze(/** @type {const} */ (['online', 'bank_transfer', 'cash', 'other']));
/** @typedef {typeof REFUND_METHODS[number]} RefundMethod */
/**
 * History entries of a claim the server writes itself (PLAN 0.4.10): the code is kept as `code` and as the `note`
 * (the widgets' words `ordersAdmin.historyNote.<code>`). `restocked`: items went back in stock.
 */
export const CLAIM_NOTES = Object.freeze(/** @type {const} */ (['restocked']));
/** @typedef {typeof CLAIM_NOTES[number]} ClaimNote */

/**
 * What the merchant's staff do to a claim, from which statuses, and the status it leads to (refund keeps refunding
 * possible for a top-up; restock does not change the status). `replaced` and `repaired` are final (E33): a replacement
 * is for exchange and warranty claims, a repair for warranty claims only (`kinds`).
 * @type {Readonly<Record<'approve' | 'reject' | 'receive' | 'refund' | 'replace' | 'repair' | 'close' | 'restock',
 *   { from: ClaimStatus[], to: ClaimStatus | null, kinds?: ClaimKind[] }>>}
 */
export const CLAIM_ACTIONS = Object.freeze({
	approve: { from: ['requested'], to: 'approved' },
	reject: { from: ['requested', 'approved', 'received'], to: 'rejected' },
	receive: { from: ['approved'], to: 'received' },
	refund: { from: ['approved', 'received', 'refunded'], to: 'refunded' },
	replace: { from: ['approved', 'received'], to: 'replaced', kinds: ['exchange', 'warranty'] },
	repair: { from: ['approved', 'received'], to: 'repaired', kinds: ['warranty'] },
	close: { from: ['approved', 'received', 'refunded'], to: 'closed' },
	restock: { from: ['approved', 'received', 'refunded', 'replaced', 'closed'], to: null },
});

/** @typedef {keyof typeof CLAIM_ACTIONS} ClaimAction */

/**
 * Whether an action may be taken on a claim of this kind in this status.
 * @param {ClaimAction} action
 * @param {Pick<ReturnRecord, 'status'> & Partial<Pick<ReturnRecord, 'kind'>>} claim
 */
export const allows = (action, claim) => {
	const { from, kinds } = CLAIM_ACTIONS[action];
	return from.includes(claim.status) && (!kinds || (claim.kind !== undefined && kinds.includes(claim.kind)));
};

/**
 * The claim's lines still to be put back in stock: not restocked yet, and not kept out by staff when received (E33).
 * A claim restocked before lines had their own times counts as done.
 * @param {Pick<ReturnRecord, 'restockedAt'> & Partial<Pick<ReturnRecord, 'lines'>>} claim
 */
export const linesToRestock = (claim) =>
	claim.restockedAt ? [] : (claim.lines ?? []).filter((line) => line.restock !== false && !line.restockedAt);

/**
 * The actions possible on a claim now.
 * @param {Pick<ReturnRecord, 'status' | 'restockedAt'> & Partial<Pick<ReturnRecord, 'kind' | 'lines'>>} claim
 * @returns {ClaimAction[]}
 */
export const actionsOf = (claim) =>
	/** @type {ClaimAction[]} */ (Object.keys(CLAIM_ACTIONS)).filter(
		(action) => allows(action, claim) && !(action === 'restock' && linesToRestock(claim).length === 0),
	);

/**
 * Whether a claim holds its units (they cannot be claimed again): every claim except a rejected one, a repaired one and
 * a warranty claim closed without a refund (a repair: the item went back to the shopper).
 * @param {Pick<ReturnRecord, 'status' | 'kind' | 'refundAmount'>} claim
 */
export const holdsUnits = (claim) =>
	claim.status !== 'rejected' &&
	claim.status !== 'repaired' &&
	!(claim.kind === 'warranty' && claim.status === 'closed' && claim.refundAmount === 0);

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
			// the grade as the line's category defines it, else the entry for every category (E45)
			const grade = line.grade ? (gradesFor(grades, line.categoryIds ?? []).get(line.grade) ?? null) : null;
			const taken = held.get(line.id);
			const claimable = Math.max(0, line.quantity - (taken?.quantity ?? 0));
			return {
				line,
				claimable,
				freeSerials: line.serials.filter((serial) => !taken?.serials.has(serial)),
				return: windowOf(windowDays('return', product, grade, defaults), order.deliveredAt, now),
				// the warranty kept on the line at placement wins (E12); a line without one (none was set, or an imported
				// line) uses the product, grade and setting
				warranty: windowOf(
					typeof line.warrantyDays === 'number' ? line.warrantyDays : windowDays('warranty', product, grade, defaults),
					order.deliveredAt,
					now,
				),
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
 * Check a shopper's claim: its kind one the shop takes (the `kinds` setting) and, when the shop lists reasons, one of
 * them (E33; no list = free text).
 * @param {unknown} body
 * @param {{ maxPhotos: number, kinds?: readonly string[], reasons?: readonly string[] }} limits
 * @returns {{ ok: true, value: ClaimInput } | { ok: false, field: string, message: string }}
 */
export const checkClaimInput = (body, { maxPhotos, kinds = ['return', 'warranty'], reasons = [] }) => {
	const input = typeof body === 'object' && body !== null ? /** @type {Record<string, unknown>} */ (body) : {};
	if (typeof input.orderId !== 'string' || !/^ord_[A-Za-z0-9]{1,64}$/.test(input.orderId))
		return { ok: false, field: 'orderId', message: 'Name the order.' };
	const taken = CLAIM_KINDS.filter((kind) => kinds.includes(kind));
	if (!taken.includes(/** @type {ClaimKind} */ (input.kind)))
		return { ok: false, field: 'kind', message: `kind is ${taken.join(' or ') || 'not open'}.` };
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
	if (reasons.length > 0 && !reasons.includes(reason))
		return { ok: false, field: 'reason', message: 'Pick one of the reasons.' };
	const photos = input.photos ?? [];
	if (!Array.isArray(photos) || photos.length > maxPhotos || !photos.every((key) => typeof key === 'string'))
		return { ok: false, field: 'photos', message: `Add at most ${maxPhotos} photos.` };
	if (new Set(photos).size !== photos.length) return { ok: false, field: 'photos', message: 'Add each photo once.' };
	return { ok: true, value: { orderId: input.orderId, kind: /** @type {ClaimKind} */ (input.kind), lines, reason, photos } };
};

/**
 * The claim's lines if every one is claimable now (its window of this kind open, enough units left; an exchange uses
 * the return window), with the serial numbers of the units claimed (the line's serials not held by other claims, in
 * order).
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
		if (!found[kind === 'warranty' ? 'warranty' : 'return'].open)
			return { ok: false, lineId: want.lineId, reason: 'window_closed' };
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
 * The most that can still be refunded on a claim: what its lines were paid (plus the delivery still left to refund,
 * when the `refundDelivery` setting is on) minus what this claim refunded, never more than what the order was paid
 * minus everything refunded on it (OR-3: money never received is never refunded).
 * @param {Pick<OrderRecord, 'lines' | 'totals' | 'payment'>} order
 * @param {Pick<ReturnRecord, 'lines' | 'refundAmount'>} claim
 * @param {number} [delivery] the delivery this claim may also refund ({@link deliveryLeft})
 */
export const refundCap = (order, claim, delivery = 0) =>
	Math.max(0, Math.min(claimValue(order, claim) + delivery - claim.refundAmount, order.payment.paid - order.payment.refunded));

/**
 * The order's delivery fee not yet refunded by its other claims (a claim refunded beyond what its lines were paid gave
 * back delivery), so the fee is refunded once across claims (E33 `refundDelivery`).
 * @param {Pick<OrderRecord, 'lines' | 'totals'>} order
 * @param {Array<Pick<ReturnRecord, 'id' | 'lines' | 'refundAmount'>>} claims the order's claims
 * @param {string} claimId the claim being refunded (not counted)
 */
export const deliveryLeft = (order, claims, claimId) => {
	const used = claims
		.filter((claim) => claim.id !== claimId)
		.reduce((sum, claim) => sum + Math.max(0, claim.refundAmount - claimValue(order, claim)), 0);
	return Math.max(0, (order.totals.delivery ?? 0) - used);
};

/**
 * Check how a claim's refund is given back and its reference (E33). Without a method an order paid online is
 * refunded through Payments and any other is recorded as `other`; a recorded method never calls Payments.
 * @param {unknown} body
 * @param {boolean} online some of what the order was paid can go back through Payments
 * @returns {{ ok: true, method: RefundMethod, reference: string } | { ok: false, field: string, message: string }}
 */
export const checkRefundMethod = (body, online) => {
	const input = typeof body === 'object' && body !== null ? /** @type {Record<string, unknown>} */ (body) : {};
	const given = input.method === undefined || input.method === null ? null : input.method;
	if (given !== null && !REFUND_METHODS.includes(/** @type {RefundMethod} */ (given)))
		return { ok: false, field: 'method', message: 'method is online, bank_transfer, cash or other.' };
	if (given === 'online' && !online) return { ok: false, field: 'method', message: 'This order was not paid through Payments.' };
	const raw = input.reference === undefined || input.reference === null ? '' : input.reference;
	if (typeof raw !== 'string' || plain(raw).length > MAX_REFERENCE)
		return { ok: false, field: 'reference', message: `A reference has at most ${MAX_REFERENCE} characters.` };
	const method = /** @type {RefundMethod} */ (given ?? (online ? 'online' : 'other'));
	return { ok: true, method, reference: plain(raw) };
};

/**
 * Check what staff decided for each received line (E33 `lines[].restock`): each named line is one of the claim's,
 * once, with a yes or no.
 * @param {unknown} value
 * @param {Pick<ReturnRecord, 'lines'>} claim
 * @returns {{ ok: true, choices: Map<string, boolean> } | { ok: false, field: string, message: string }}
 */
export const checkRestockChoices = (value, claim) => {
	/** @type {Map<string, boolean>} */
	const choices = new Map();
	if (value === undefined || value === null) return { ok: true, choices };
	if (!Array.isArray(value) || value.length > MAX_CLAIM_LINES)
		return { ok: false, field: 'lines', message: 'lines lists the claimed items.' };
	for (const [index, raw] of value.entries()) {
		const line = typeof raw === 'object' && raw !== null ? /** @type {Record<string, unknown>} */ (raw) : {};
		if (
			typeof line.lineId !== 'string' ||
			!claim.lines.some((claimed) => claimed.lineId === line.lineId) ||
			choices.has(line.lineId)
		)
			return { ok: false, field: `lines/${index}/lineId`, message: 'Name each claimed item once.' };
		if (typeof line.restock !== 'boolean')
			return { ok: false, field: `lines/${index}/restock`, message: 'restock is true or false.' };
		choices.set(line.lineId, line.restock);
	}
	return { ok: true, choices };
};

/**
 * Loyalty points earned on the returned part of an order, to take back (in proportion to what the lines were paid; the
 * `pointsBack` setting `proportional`).
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
 * A short reference of a claim for people (`R-3F9A2C`), with the shop's prefix (E33 `referencePrefix`).
 * @param {string} id
 * @param {unknown} [prefix]
 */
export const claimReference = (id, prefix = 'R-') => `${typeof prefix === 'string' ? prefix : 'R-'}${id.slice(-6).toUpperCase()}`;

/**
 * A claim's reference: the one kept when it was made, else (an imported claim without one) the default one.
 * @param {Pick<ReturnRecord, 'id' | 'reference'>} claim
 */
export const referenceOf = (claim) => claim.reference ?? claimReference(claim.id);

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
