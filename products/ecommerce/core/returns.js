/**
 * Return, warranty and exchange claims (PLAN 0.8.8: claims with time windows per item/grade, photos, approval, refund
 * through Payments when paid online, restock exactly once; E33: refund method and reference, restock per line,
 * delivery inside the refund cap, the reference prefix; fixed-choices E17/E18: the merchant's claim kinds and statuses).
 *
 * Like the order flow, the merchant names what a claim can be and where it stands, and code relies only on fixed parts:
 * - the `claim_kinds` list: each kind ({ key, label }) is counted in the `return` or the `warranty` window, ends in some
 *   of the fixed outcomes (`refund`, `replace`, `repair`, `store_credit`) and may be offered to shoppers or made by staff
 *   only (seeded with today's return, warranty and exchange);
 * - the `claim_statuses` list: each status ({ key, label }) has one of the fixed roles ({@link CLAIM_ROLES}); every role
 *   has at least one status, and a role may have more (approved: "label sent", received: "inspecting" …). Staff actions
 *   lead into a role (its first status, or the one they name), and staff move a claim between the statuses of one role.
 *
 * A claim keeps its kind's window and outcomes and its status's role when made, so editing the lists never changes
 * what an existing claim may do. Pure rules: the windows of an order line (the product's own time, else its condition
 * grade's, else the `returns` settings), what is still claimable, checking a shopper's claim, the staff moves, the
 * refund and store credit caps and the loyalty points taken back. No I/O.
 * @module
 */
import { endOf, isDuration, settingDuration } from './durations.js';
import { gradesFor } from './grades.js';
import { boolField, checkNamedList, oneOf } from './named-lists.js';
import { OTHER_WAY, VIA_PAYMENTS, isMethodKey } from './payment-methods.js';

/** @typedef {import('./model.js').ReturnRecord} ReturnRecord */
/** @typedef {import('./model.js').OrderRecord} OrderRecord */
/** @typedef {import('./model.js').OrderLineRecord} OrderLineRecord */

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

/**
 * How a claim's money goes back: `payments` (through Payments), a payment method key of the website's list, or `other`.
 * @typedef {string} RefundMethod
 */

/** The fixed roles of claim statuses (code relies on them; the merchant names the statuses). */
export const CLAIM_ROLES = Object.freeze(
	/** @type {const} */ ([
		'requested',
		'approved',
		'rejected',
		'received',
		'refunded',
		'credited',
		'replaced',
		'repaired',
		'closed',
	]),
);
/** @typedef {typeof CLAIM_ROLES[number]} ClaimRole */
/** What a claim kind may end in. */
export const CLAIM_OUTCOMES = Object.freeze(/** @type {const} */ (['refund', 'store_credit', 'replace', 'repair']));
/** @typedef {typeof CLAIM_OUTCOMES[number]} ClaimOutcome */
/** The windows a kind is counted in. */
export const CLAIM_WINDOWS = Object.freeze(/** @type {const} */ (['return', 'warranty']));
/** @typedef {typeof CLAIM_WINDOWS[number]} WindowName */
/** Engine caps of the lists. */
export const CLAIM_LIST_LIMITS = Object.freeze({ kinds: 10, statuses: 20 });

/**
 * @typedef {{ key: string, label: string, window: WindowName, outcomes: ClaimOutcome[], shoppers: boolean }} ClaimKind
 * @typedef {{ key: string, label: string, role: ClaimRole }} ClaimStatus
 */

/** The claim kinds before the merchant saves the list (today's three). @type {ReadonlyArray<ClaimKind>} */
export const DEFAULT_CLAIM_KINDS = Object.freeze([
	{ key: 'return', label: 'Return', window: 'return', outcomes: ['refund'], shoppers: true },
	{
		key: 'warranty',
		label: 'Warranty repair or replacement',
		window: 'warranty',
		outcomes: ['refund', 'replace', 'repair'],
		shoppers: true,
	},
	{ key: 'exchange', label: 'Exchange', window: 'return', outcomes: ['refund', 'replace'], shoppers: false },
]);

/** The claim statuses before the merchant saves the list: one per role. @type {ReadonlyArray<ClaimStatus>} */
export const DEFAULT_CLAIM_STATUSES = Object.freeze([
	{ key: 'requested', label: 'Requested', role: 'requested' },
	{ key: 'approved', label: 'Approved', role: 'approved' },
	{ key: 'received', label: 'Received by the shop', role: 'received' },
	{ key: 'refunded', label: 'Refunded', role: 'refunded' },
	{ key: 'credited', label: 'Store credit given', role: 'credited' },
	{ key: 'replaced', label: 'Replaced', role: 'replaced' },
	{ key: 'repaired', label: 'Repaired', role: 'repaired' },
	{ key: 'closed', label: 'Closed', role: 'closed' },
	{ key: 'rejected', label: 'Rejected', role: 'rejected' },
]);

/**
 * Check the `claim_kinds` list: each kind a key and name, its window (`return` | `warranty`), its outcomes (at least
 * one, each once) and whether shoppers may make it.
 * @param {unknown} value
 * @returns {{ ok: true, value: ClaimKind[] } | { ok: false, errors: Array<{ path: string, message: string }> }}
 */
export const checkClaimKinds = (value) =>
	/** @type {{ ok: true, value: ClaimKind[] } | { ok: false, errors: Array<{ path: string, message: string }> }} */ (
		checkNamedList(value, {
			max: CLAIM_LIST_LIMITS.kinds,
			what: 'claim kinds',
			fields: (entry, fail) => {
				const outcomes = Array.isArray(entry.outcomes) ? entry.outcomes : [];
				if (
					outcomes.length === 0 ||
					new Set(outcomes).size !== outcomes.length ||
					!outcomes.every((outcome) => /** @type {readonly unknown[]} */ (CLAIM_OUTCOMES).includes(outcome))
				)
					fail('outcomes', `outcomes are one or more of ${CLAIM_OUTCOMES.join(', ')}, each once.`);
				return {
					window: oneOf(entry, 'window', CLAIM_WINDOWS, 'return', fail),
					outcomes: /** @type {ClaimOutcome[]} */ (CLAIM_OUTCOMES.filter((outcome) => outcomes.includes(outcome))),
					shoppers: boolField(entry, 'shoppers', true, fail),
				};
			},
		})
	);

/**
 * Check the `claim_statuses` list: each status a key, a name and a role; every role has at least one status.
 * @param {unknown} value
 * @returns {{ ok: true, value: ClaimStatus[] } | { ok: false, errors: Array<{ path: string, message: string }> }}
 */
export const checkClaimStatuses = (value) => {
	const checked = checkNamedList(value, {
		max: CLAIM_LIST_LIMITS.statuses,
		what: 'claim statuses',
		fields: (entry, fail) => {
			if (!(/** @type {readonly unknown[]} */ (CLAIM_ROLES).includes(entry.role)))
				fail('role', `role is one of ${CLAIM_ROLES.join(', ')}.`);
			return { role: /** @type {ClaimRole} */ (entry.role) };
		},
	});
	if (!checked.ok) return checked;
	const list = /** @type {ClaimStatus[]} */ (checked.value);
	const missing = CLAIM_ROLES.filter((role) => !list.some((status) => status.role === role));
	if (missing.length > 0)
		return { ok: false, errors: [{ path: '/value', message: `Give every role a status: ${missing.join(', ')} has none.` }] };
	return { ok: true, value: list };
};

/**
 * The status a claim takes in a role: the one named (when it has that role), else the role's first.
 * @param {ReadonlyArray<ClaimStatus>} statuses
 * @param {ClaimRole} role
 * @param {unknown} [named]
 * @returns {ClaimStatus | null} null: `named` is not a status of this role
 */
export const statusIn = (statuses, role, named) => {
	if (named !== undefined && named !== null && named !== '')
		return statuses.find((status) => status.key === named && status.role === role) ?? null;
	return statuses.find((status) => status.role === role) ?? { key: role, label: role, role };
};

/**
 * What saving the claim statuses would break: a status that has claims must stay, with the same role.
 * @param {ReadonlyArray<ClaimStatus>} next
 * @param {ReadonlyArray<{ status: string, role: string }>} used the status and role pairs claims have
 * @returns {Array<{ path: string, message: string }>}
 */
export const claimStatusProblems = (next, used) =>
	used
		.filter(({ status, role }) => !next.some((entry) => entry.key === status && entry.role === role))
		.map(({ status, role }) => ({
			path: '/value',
			message: `Claims are in the status ${status} (${role}): keep it with that role, or move them first.`,
		}));

/**
 * What the merchant's staff do to a claim, from which roles, the role it leads to (refund and credit keep giving more
 * possible; restock does not change the status) and the outcome the claim's kind must allow. `replaced` and
 * `repaired` are final.
 * @type {Readonly<Record<'approve' | 'reject' | 'receive' | 'refund' | 'credit' | 'replace' | 'repair' | 'close' | 'restock',
 *   { from: ClaimRole[], to: ClaimRole | null, outcome?: ClaimOutcome }>>}
 */
export const CLAIM_ACTIONS = Object.freeze({
	approve: { from: ['requested'], to: 'approved' },
	reject: { from: ['requested', 'approved', 'received'], to: 'rejected' },
	receive: { from: ['approved'], to: 'received' },
	refund: { from: ['approved', 'received', 'refunded'], to: 'refunded', outcome: 'refund' },
	credit: { from: ['approved', 'received', 'credited'], to: 'credited', outcome: 'store_credit' },
	replace: { from: ['approved', 'received'], to: 'replaced', outcome: 'replace' },
	repair: { from: ['approved', 'received'], to: 'repaired', outcome: 'repair' },
	close: { from: ['approved', 'received', 'refunded', 'credited'], to: 'closed' },
	restock: { from: ['approved', 'received', 'refunded', 'credited', 'replaced', 'closed'], to: null },
});

/**
 * History entries of a claim the server writes itself (PLAN 0.4.10): the code is kept as `code` and as the `note`
 * (the widgets' words `ordersAdmin.historyNote.<code>`). `restocked`: items went back in stock.
 */
export const CLAIM_NOTES = Object.freeze(/** @type {const} */ (['restocked']));
/** @typedef {typeof CLAIM_NOTES[number]} ClaimNote */

/** @typedef {keyof typeof CLAIM_ACTIONS} ClaimAction */

/**
 * Whether an action may be taken on a claim in its role, with the outcomes its kind allows.
 * @param {ClaimAction} action
 * @param {Pick<ReturnRecord, 'role'> & Partial<Pick<ReturnRecord, 'outcomes'>>} claim
 */
export const allows = (action, claim) => {
	const { from, outcome } = CLAIM_ACTIONS[action];
	return from.includes(claim.role) && (!outcome || (claim.outcomes ?? []).includes(outcome));
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
 * @param {Pick<ReturnRecord, 'role' | 'restockedAt'> & Partial<Pick<ReturnRecord, 'outcomes' | 'lines'>>} claim
 * @returns {ClaimAction[]}
 */
export const actionsOf = (claim) =>
	/** @type {ClaimAction[]} */ (Object.keys(CLAIM_ACTIONS)).filter(
		(action) => allows(action, claim) && !(action === 'restock' && linesToRestock(claim).length === 0),
	);

/**
 * Whether a claim holds its units (they cannot be claimed again): every claim except a rejected one, a repaired one and
 * a claim of the warranty window closed with no money given (a repair: the item went back to the shopper).
 * @param {Pick<ReturnRecord, 'role' | 'window' | 'refundAmount'> & Partial<Pick<ReturnRecord, 'creditAmount'>>} claim
 */
export const holdsUnits = (claim) =>
	claim.role !== 'rejected' &&
	claim.role !== 'repaired' &&
	!(claim.window === 'warranty' && claim.role === 'closed' && claim.refundAmount === 0 && !(Number(claim.creditAmount) > 0));

/**
 * Units of each order line held by claims.
 * @param {Array<Pick<ReturnRecord, 'role' | 'window' | 'refundAmount' | 'lines'> & Partial<Pick<ReturnRecord, 'creditAmount'>>>} claims
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
 * A condition grade of the `grades` list as this part reads it (times are optional, E14).
 * @typedef {{ key: string, label?: string, returnTime?: Duration | null, warrantyTime?: Duration | null }} GradeTimes
 */

/**
 * @typedef {import('./durations.js').Duration} Duration
 * @typedef {{ returnTime: Duration, warrantyTime: Duration }} WindowDefaults the `returns` settings
 * @typedef {{ time: Duration, until: Date | null, open: boolean }} ClaimWindow
 */

/**
 * The `returns` settings' times: each a number and its unit (`returnTime` + `returnTimeUnit`, E14).
 * @param {Record<string, unknown>} settings
 * @returns {WindowDefaults}
 */
export const windowDefaults = (settings) => ({
	returnTime: settingDuration(settings.returnTime, settings.returnTimeUnit),
	warrantyTime: settingDuration(settings.warrantyTime, settings.warrantyTimeUnit),
});

/** No time. @type {Duration} */
const NONE = Object.freeze({ amount: 0, unit: 'days' });

/**
 * The time of a line's window: the product's own, else its grade's, else the setting.
 * @param {WindowName} kind
 * @param {{ returnTime: Duration | null, warrantyTime: Duration | null } | null} product the product now (null: deleted)
 * @param {GradeTimes | null} grade
 * @param {WindowDefaults} defaults
 * @returns {Duration}
 */
export const windowTime = (kind, product, grade, defaults) => {
	const field = kind === 'return' ? 'returnTime' : 'warrantyTime';
	const own = product?.[field];
	if (isDuration(own)) return own;
	const graded = grade?.[field];
	if (isDuration(graded)) return graded;
	return isDuration(defaults[field]) ? defaults[field] : NONE;
};

/**
 * A window counted from delivery (months and years on the calendar).
 * @param {Duration} time
 * @param {Date | null} deliveredAt
 * @param {number} now
 * @returns {ClaimWindow}
 */
export const windowOf = (time, deliveredAt, now) => {
	if (!deliveredAt || time.amount <= 0) return { time, until: null, open: false };
	const until = endOf(deliveredAt, time);
	return { time, until, open: now <= until.getTime() };
};

/**
 * What can still be claimed on each line of a delivered order (only physical items are claimed).
 * @param {{ order: Pick<OrderRecord, 'lines' | 'deliveredAt'>, claims: Array<Pick<ReturnRecord, 'role' | 'window' | 'refundAmount' | 'lines'>>,
 *   products: Map<string, { returnTime: Duration | null, warrantyTime: Duration | null }>, grades: GradeTimes[],
 *   lineage: (categoryIds: string[]) => string[], defaults: WindowDefaults, now: number }} input `lineage`: a line's
 *   categories with those above them, nearest first (`core/catalog-taxonomy.js` `lineageOf`), for the grade a line's
 *   category or one above it defines
 */
export const returnableLines = ({ order, claims, products, grades, lineage, defaults, now }) => {
	const held = claimedByLine(claims);
	return order.lines
		.filter((line) => line.kind === 'physical')
		.map((line) => {
			const product = products.get(line.productId) ?? null;
			// the grade as the line's category (or the nearest one above it) defines it, else the entry for every category (E45)
			const grade = line.grade ? (gradesFor(grades, lineage(line.categoryIds)).get(line.grade) ?? null) : null;
			const taken = held.get(line.id);
			const claimable = Math.max(0, line.quantity - (taken?.quantity ?? 0));
			return {
				line,
				claimable,
				freeSerials: line.serials.filter((serial) => !taken?.serials.has(serial)),
				return: windowOf(windowTime('return', product, grade, defaults), order.deliveredAt, now),
				// the warranty kept on the line at placement wins (E12); a line without one (none was set, or an imported
				// line) uses the product, grade and setting
				warranty: windowOf(
					isDuration(line.warrantyTime) ? line.warrantyTime : windowTime('warranty', product, grade, defaults),
					order.deliveredAt,
					now,
				),
			};
		});
};

/** @typedef {ReturnType<typeof returnableLines>[number]} ReturnableLine */

/**
 * @typedef {{ orderId: string, kind: string, lines: Array<{ lineId: string, quantity: number }>, reason: string,
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
 * Check a shopper's claim: its kind one of the `claim_kinds` list offered to shoppers and, when the shop lists reasons,
 * one of them or (with `otherReason`) the shopper's own words (E17; no list = free text).
 * @param {unknown} body
 * @param {{ maxPhotos: number, kinds?: ReadonlyArray<Pick<ClaimKind, 'key' | 'shoppers'>>, reasons?: readonly string[],
 *   otherReason?: boolean }} limits
 * @returns {{ ok: true, value: ClaimInput } | { ok: false, field: string, message: string }}
 */
export const checkClaimInput = (body, { maxPhotos, kinds = DEFAULT_CLAIM_KINDS, reasons = [], otherReason = true }) => {
	const input = typeof body === 'object' && body !== null ? /** @type {Record<string, unknown>} */ (body) : {};
	if (typeof input.orderId !== 'string' || !/^ord_[A-Za-z0-9]{1,64}$/.test(input.orderId))
		return { ok: false, field: 'orderId', message: 'Name the order.' };
	const taken = kinds.filter((kind) => kind.shoppers).map((kind) => kind.key);
	if (typeof input.kind !== 'string' || !taken.includes(input.kind))
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
	if (reasons.length > 0 && !otherReason && !reasons.includes(reason))
		return { ok: false, field: 'reason', message: 'Pick one of the reasons.' };
	const photos = input.photos ?? [];
	if (!Array.isArray(photos) || photos.length > maxPhotos || !photos.every((key) => typeof key === 'string'))
		return { ok: false, field: 'photos', message: `Add at most ${maxPhotos} photos.` };
	if (new Set(photos).size !== photos.length) return { ok: false, field: 'photos', message: 'Add each photo once.' };
	return { ok: true, value: { orderId: input.orderId, kind: input.kind, lines, reason, photos } };
};

/**
 * The claim's lines if every one is claimable now (the window of the claim's kind open, enough units left; a measured line — its quantity in thousandths of its unit — in its steps), with the serial
 * numbers of the units claimed (the line's serials not held by other claims, in order).
 * @param {WindowName} span the claim kind's window
 * @param {ClaimInput['lines']} wanted
 * @param {ReturnableLine[]} returnable
 * @returns {{ ok: true, lines: ReturnRecord['lines'] } | { ok: false, lineId: string,
 *   reason: 'unknown' | 'window_closed' | 'quantity' | 'step' }}
 */
export const planClaim = (span, wanted, returnable) => {
	/** @type {ReturnRecord['lines']} */
	const lines = [];
	for (const want of wanted) {
		const found = returnable.find((entry) => entry.line.id === want.lineId);
		if (!found) return { ok: false, lineId: want.lineId, reason: 'unknown' };
		if (!found[span].open) return { ok: false, lineId: want.lineId, reason: 'window_closed' };
		if (want.quantity > found.claimable) return { ok: false, lineId: want.lineId, reason: 'quantity' };
		const step = found.line.measure?.step ?? 1;
		if (want.quantity % step !== 0 && want.quantity !== found.claimable)
			return { ok: false, lineId: want.lineId, reason: 'step' };
		lines.push({ lineId: want.lineId, quantity: want.quantity, serials: found.freeSerials.slice(0, want.quantity) });
	}
	return { ok: true, lines };
};

/**
 * What a claim's lines were paid: each line's total × the claimed units / the units bought (rounded down; exact in
 * BigInt, as a measured line counts thousandths of its unit).
 * @param {Pick<OrderRecord, 'lines'>} order
 * @param {Pick<ReturnRecord, 'lines'>} claim
 */
export const claimValue = (order, claim) =>
	claim.lines.reduce((sum, claimed) => {
		const line = order.lines.find((entry) => entry.id === claimed.lineId);
		return line && line.quantity > 0
			? sum + Number((BigInt(line.total) * BigInt(claimed.quantity)) / BigInt(line.quantity))
			: sum;
	}, 0);

/**
 * The most that can still be refunded on a claim: what its lines were paid (plus the delivery still left to refund,
 * when the `refundDelivery` setting is on) minus what this claim refunded or gave as store credit, never more than what
 * the order was paid minus everything refunded on it (OR-3: money never received is never refunded).
 * @param {Pick<OrderRecord, 'lines' | 'totals' | 'payment'>} order
 * @param {Pick<ReturnRecord, 'lines' | 'refundAmount'> & Partial<Pick<ReturnRecord, 'creditAmount'>>} claim
 * @param {number} [delivery] the delivery this claim may also refund ({@link deliveryLeft})
 */
export const refundCap = (order, claim, delivery = 0) =>
	Math.max(
		0,
		Math.min(
			claimValue(order, claim) + delivery - claim.refundAmount - (claim.creditAmount ?? 0),
			order.payment.paid - order.payment.refunded,
		),
	);

/**
 * The most store credit a claim can still give (E18 outcome `store_credit`): what its lines were paid minus what it
 * refunded or credited, never more than what the order was paid minus everything refunded on it.
 * @param {Pick<OrderRecord, 'lines' | 'payment'>} order
 * @param {Pick<ReturnRecord, 'lines' | 'refundAmount'> & Partial<Pick<ReturnRecord, 'creditAmount'>>} claim
 */
export const creditCap = (order, claim) =>
	Math.max(
		0,
		Math.min(
			claimValue(order, claim) - claim.refundAmount - (claim.creditAmount ?? 0),
			order.payment.paid - order.payment.refunded,
		),
	);

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
 * refunded through Payments and any other is recorded as `other`; a recorded way (a payment method of the list, or
 * `other`, E16) never calls Payments.
 * @param {unknown} body
 * @param {boolean} online some of what the order was paid can go back through Payments
 * @param {ReadonlyArray<string>} keys the `payment_methods` list's keys
 * @returns {{ ok: true, method: RefundMethod, reference: string } | { ok: false, field: string, message: string }}
 */
export const checkRefundMethod = (body, online, keys) => {
	const input = typeof body === 'object' && body !== null ? /** @type {Record<string, unknown>} */ (body) : {};
	const given = input.method === undefined || input.method === null ? null : input.method;
	if (given !== null && given !== VIA_PAYMENTS && !(given === OTHER_WAY || (isMethodKey(given) && keys.includes(given))))
		return { ok: false, field: 'method', message: 'method is payments, one of the payment methods, or other.' };
	if (given === VIA_PAYMENTS && !online)
		return { ok: false, field: 'method', message: 'This order was not paid through Payments.' };
	const raw = input.reference === undefined || input.reference === null ? '' : input.reference;
	if (typeof raw !== 'string' || plain(raw).length > MAX_REFERENCE)
		return { ok: false, field: 'reference', message: `A reference has at most ${MAX_REFERENCE} characters.` };
	const method = /** @type {RefundMethod} */ (given ?? (online ? VIA_PAYMENTS : OTHER_WAY));
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
