/**
 * Sisters Boutique's shoppers, orders and loyalty into Ecommerce (PLAN 0.8.10 Migration step 6, "Conversion rules"
 * Money, Payments, Orders, Loyalty, "Per store" Orders and Loyalty; IMP-5, IMP-9, IMP-10, IMP-13, IMP-17, IMP-19,
 * IMP-23, IMP-49, CU-6; owner quirk 7):
 *
 * - **customers**: one per normalised phone (`@ss/contracts/phone`, +92); SB's duplicates merge, the member's record
 *   winning, with their notes and "seen" markers; members and password holders name their Accounts user.
 * - **orders**: numbers and status keys kept (the `order_flow` list gives them their roles); money × 100, the stored
 *   discount (offers, member discount and points: what makes SB's total) spread over the lines so every line has its
 *   discount and total (IMP-10); a payment entry by the status rule (bank transfer and card: the total at the first
 *   `confirmed` entry; cash on delivery: at the last `delivered` one; none for a cancelled order) and a refund entry
 *   for a refunded one, noted "Imported" (IMP-13); `deliveredAt` from the last `delivered` entry (IMP-9); the
 *   idempotency key, else `import:<hex>` (IMP-23); stock held and the points flags from SB's flags and timeline
 *   (IMP-49); staff "seen" markers copied (quirk 7); each line's category and brand snapshot from its product (IMP-17).
 * - **loyalty**: lots rebuilt oldest first from SB's transactions (earn, bonus and positive adjustments credit; redeem,
 *   expire and negative adjustments debit; IMP-5), and one correcting entry where SB's stored balance differs.
 * @module
 */
import { ALL, BRANDS, CATEGORIES, TABLES as CATALOG } from './catalog.js';
import {
	CURRENCY,
	derivedId,
	earliest,
	hexKey,
	idOrNull,
	iso,
	isObject,
	mediaKey,
	paisa,
	phoneOf,
	phoneText,
	siteAddress,
	text,
} from './common.js';
import { TABLES as PEOPLE } from './people.js';

/** @typedef {import('../../mapping.js').MappingStep} MappingStep */
/** @typedef {import('../../mapping.js').MapContext} MapContext */
/** @typedef {{ id: string, points: number, left: number, earnedAt: string, expiresAt: null, orderId: string | null, kind: string }} Lot */
/** @typedef {{ at: string, kind: string, points: number, orderId: string | null, note: string }} PointsEntry */

/** Lookup table: an order's id by its number (loyalty transactions name orders by number). */
const ORDER_NUMBERS = 'order-numbers';

/**
 * SB's statuses with their roles (`packages/db/src/models/Order.ts`:3; labels `packages/shared/src/notifications/
 * orderEventNotify.ts`:11-20); `awaiting-confirmation` is added because every flow has one (no SB order enters it:
 * cash on delivery starts confirmed, `cod.startStatus: open`, and free orders wait for payment,
 * `checkout.freeOrderStart: awaiting_payment`).
 */
export const STATUSES = Object.freeze([
	{ key: 'pending-payment', label: 'Pending payment', role: 'awaiting_payment' },
	{ key: 'awaiting-confirmation', label: 'Awaiting confirmation', role: 'awaiting_confirmation' },
	{ key: 'confirmed', label: 'Confirmed', role: 'open' },
	{ key: 'packed', label: 'Packed', role: 'packed' },
	{ key: 'dispatched', label: 'Dispatched', role: 'shipped' },
	{ key: 'delivered', label: 'Delivered', role: 'delivered' },
	{ key: 'cancelled', label: 'Cancelled', role: 'cancelled' },
	{ key: 'refunded', label: 'Refunded', role: 'refunded' },
	{ key: 'returned', label: 'Returned', role: 'returned' },
]);
/** @param {string} status */
const roleOf = (status) => STATUSES.find((each) => each.key === status)?.role ?? 'open';

/** SB's payment methods → Ecommerce's (IMP-32), and the method of a payment or refund entry of each. */
const METHODS = Object.freeze(
	/** @type {Record<string, string>} */ ({ 'bank-transfer': 'bank_transfer', cod: 'cod', card: 'online' }),
);
const ENTRY_METHODS = Object.freeze(
	/** @type {Record<string, string>} */ ({ bank_transfer: 'bank_transfer', cod: 'cash', online: 'online' }),
);
/** Roles of orders that gave their stock back, and of orders never delivered (Ecommerce's import rules). */
const RELEASED = Object.freeze(['cancelled', 'returned_to_origin', 'returned']);
const UNDELIVERED = Object.freeze([
	'awaiting_payment',
	'awaiting_confirmation',
	'open',
	'packed',
	'shipped',
	'cancelled',
	'returned_to_origin',
]);
/** Statuses whose move gives redeemed points back in SB (`packages/db/src/orderTransitions.ts`:17). */
const REDEEM_REFUND = Object.freeze(['cancelled', 'refunded', 'returned']);
/** Statuses a delivered order's earned points are reversed in (`orderTransitions.ts`:16). */
const REVERSING = Object.freeze(['cancelled', 'refunded']);
/** Most staff ids a record keeps as having opened it (Ecommerce's `seenBy`). */
const MAX_SEEN = 50;
/** The note of what the importer adds. */
const IMPORTED = 'Imported';

/**
 * SB's "seen by" admin ids as staff user ids, the newest 50.
 * @param {unknown} ids
 * @returns {string[]}
 */
const seenOf = (ids) =>
	[...new Set((Array.isArray(ids) ? ids : []).map((id) => idOrNull('usr', id)).filter((id) => id !== null))].slice(-MAX_SEEN);

/**
 * Ecommerce customers: SB's customers, one per normalised phone; the member's record wins a merge (its id is the one
 * the member's Accounts user and orders name).
 * @type {MappingStep}
 */
export const customerStep = {
	product: 'ecommerce',
	collection: 'customers',
	source: 'customers',
	prefix: 'cus',
	mergeKey: (doc) => phoneOf(doc.phoneNumber),
	merge: (kept, next) => {
		const [base, other] = !kept.userId && next.userId ? [next, kept] : [kept, next];
		const notes = [...new Set([text(base.note), text(other.note)].filter(Boolean))];
		return {
			...base,
			name: text(base.name) || text(other.name),
			city: text(base.city) || text(other.city),
			...(notes.length > 0 ? { note: notes.join('\n') } : {}),
			seenBy: [.../** @type {string[]} */ (kept.seenBy), .../** @type {string[]} */ (next.seenBy)]
				.filter((id, index, all) => all.indexOf(id) === index)
				.slice(-MAX_SEEN),
			createdAt: earliest(kept.createdAt, next.createdAt),
		};
	},
	map: (doc, ctx) => {
		const member = text(doc.passwordHash) !== '' || doc.isMember === true;
		return {
			id: ctx.id('cus', doc._id),
			...(member ? { userId: ctx.id('usr', doc._id) } : {}),
			name: text(doc.name),
			phone: phoneText(doc.phoneNumber),
			city: text(doc.city),
			...(text(doc.notes) ? { note: text(doc.notes) } : {}),
			seenBy: seenOf(doc.seenByAdminIds),
			createdAt: iso(doc.createdAt),
		};
	},
	sums: () => ({ customers: 1 }),
};

/**
 * An amount spread over lines in proportion to their gross amounts (largest remainders), each share at most its line's.
 * @param {number} amount @param {number[]} gross
 * @returns {number[]}
 */
export const spread = (amount, gross) => {
	const total = gross.reduce((sum, value) => sum + value, 0);
	if (total <= 0 || amount <= 0) return gross.map(() => 0);
	const part = Math.min(amount, total);
	const exact = gross.map((value) => (part * value) / total);
	const shares = exact.map(Math.floor);
	let left = part - shares.reduce((sum, value) => sum + value, 0);
	const order = exact
		.map((value, index) => ({ index, rest: value - Math.floor(value) }))
		.sort((a, b) => b.rest - a.rest || a.index - b.index);
	for (const { index } of order) {
		if (left <= 0) break;
		if ((shares[index] ?? 0) < (gross[index] ?? 0)) {
			shares[index] = (shares[index] ?? 0) + 1;
			left -= 1;
		}
	}
	return shares;
};

/**
 * What an order's line snapshots say of its product (IMP-17): its categories and brand.
 * @param {string} productId @param {MapContext} ctx
 */
const snapshotOf = (productId, ctx) => ({
	categoryIds: CATEGORIES.all(ALL, ctx).filter((id) => ctx.lookup(CATALOG.productInCategory, `${productId}|${id}`) !== null),
	brandId: BRANDS.all(ALL, ctx).find((id) => ctx.lookup(CATALOG.productBrand, `${productId}|${id}`) !== null) ?? null,
});

/**
 * The order's payments and refunds by SB's status rule (IMP-13).
 * @param {Record<string, any>} doc @param {string} method @param {number} total
 * @param {Array<{ status: string, at: string }>} timeline @param {MapContext} ctx
 */
const moneyOf = (doc, method, total, timeline, ctx) => {
	const role = roleOf(text(doc.status));
	const paidAt =
		method === 'cod'
			? timeline.filter((entry) => entry.status === 'delivered').at(-1)?.at
			: timeline.find((entry) => entry.status === 'confirmed')?.at;
	if (total <= 0 || role === 'cancelled' || !paidAt) return { payments: [], refunds: [] };
	const entryMethod = ENTRY_METHODS[method] ?? 'other';
	const payments = [{ id: ctx.id('opy', doc._id), method: entryMethod, amount: total, note: IMPORTED, at: paidAt }];
	const refundedAt = role === 'refunded' ? timeline.filter((entry) => entry.status === 'refunded').at(-1)?.at : undefined;
	const refunds = refundedAt
		? [
				{
					id: ctx.id('orf', doc._id),
					method: entryMethod,
					amount: total,
					note: IMPORTED,
					at: refundedAt < paidAt ? paidAt : refundedAt,
				},
			]
		: [];
	return { payments, refunds };
};

/**
 * The order's history (each status a key of the flow, the last one the order's status): SB's timeline in order; an
 * order without one gets its placement, and one whose last entry is not its status gets a closing entry.
 * @param {Record<string, any>} doc @param {Array<{ status: string, at: string, note: string }>} timeline
 */
const historyOf = (doc, timeline) => {
	const status = text(doc.status);
	const entries = timeline.map((entry, index) => ({
		at: entry.at,
		from: index === 0 ? null : /** @type {{ status: string }} */ (timeline[index - 1]).status,
		to: entry.status,
		by: '',
		note: entry.note,
	}));
	const last = entries.at(-1);
	if (!last)
		return [{ at: iso(doc.placedAt) ?? iso(doc.createdAt), from: null, to: status, by: '', note: `${IMPORTED}: no timeline` }];
	if (last.to !== status)
		entries.push({
			at: iso(doc.updatedAt) ?? last.at,
			from: last.to,
			to: status,
			by: '',
			note: `${IMPORTED}: the status at the move`,
		});
	return entries;
};

/**
 * What the order's points did (IMP-49): credited when it reached `delivered` (SB credits there), reversed when a
 * delivered order was cancelled or refunded, given back (`released`) once it was cancelled, refunded or returned.
 * @param {Record<string, any>} doc @param {Array<{ status: string }>} timeline
 */
const pointsOf = (doc, timeline) => {
	const earned = Math.max(0, Math.round(Number(doc.pointsEarned) || 0));
	const redeemed = Math.max(0, Math.round(Number(doc.pointsRedeemed) || 0));
	let credited = 0;
	let reversed = 0;
	timeline.forEach((entry, index) => {
		const before = index === 0 ? null : timeline[index - 1]?.status;
		if (entry.status === 'delivered' && before !== 'delivered') credited += 1;
		if (before === 'delivered' && REVERSING.includes(entry.status)) reversed += 1;
	});
	return {
		pointsRedeemed: redeemed,
		pointsValue: redeemed * 100,
		pointsEarned: earned,
		...(earned > 0 ? { pointsCredited: credited > 0 } : {}),
		...(earned > 0 && credited > 0 && reversed >= credited ? { pointsReversed: earned } : {}),
		released: timeline.some((entry) => REDEEM_REFUND.includes(entry.status)) || REDEEM_REFUND.includes(text(doc.status)),
	};
};

/**
 * Orders (PLAN 0.8.8 `OrderRecord`), with their lines, money, payments, history and SB's markers.
 * @type {MappingStep}
 */
export const orderStep = {
	product: 'ecommerce',
	collection: 'orders',
	source: 'orders',
	prefix: 'ord',
	lookups: { [ORDER_NUMBERS]: (record) => String(record.number) },
	map: (doc, ctx) => {
		const status = text(doc.status);
		const role = roleOf(status);
		const totals = isObject(doc.totals) ? doc.totals : {};
		const items = (Array.isArray(doc.items) ? doc.items : []).filter(isObject);
		const gross = items.map((item) => paisa(item.unitPriceRupees) * Math.max(1, Math.round(Number(item.quantity) || 1)));
		const subtotal = gross.reduce((sum, value) => sum + value, 0);
		const delivery = paisa(totals.shippingRupees);
		const fee = paisa(totals.paymentSurchargeRupees);
		const total = paisa(totals.totalRupees);
		// SB keeps offers and the member discount in discountRupees and takes points off on top: what makes its total
		const discount = Math.min(subtotal, Math.max(0, subtotal - (total - delivery - fee)));
		const shares = spread(discount, gross);
		const lines = items.map((item, index) => {
			const productId = ctx.id('prd', item.productId);
			const lineGross = gross[index] ?? 0;
			const share = shares[index] ?? 0;
			const dealId = idOrNull('deal', item.appliedOfferId);
			return {
				id: ctx.id('oln', item._id),
				productId,
				variantId: ctx.id('var', item.variantId),
				name: text(item.productName),
				variantName: text(item.variantSummary),
				unitPrice: paisa(item.unitPriceRupees),
				quantity: Math.max(1, Math.round(Number(item.quantity) || 1)),
				discount: share,
				total: lineGross - share,
				...snapshotOf(productId, ctx),
				...(dealId ? { dealId } : {}),
			};
		});
		const timeline = (Array.isArray(doc.timeline) ? doc.timeline : [])
			.filter(isObject)
			.map((entry) => ({
				status: text(entry.status),
				at: /** @type {string} */ (iso(entry.occurredAt)),
				note: text(entry.note),
			}))
			.filter((entry) => entry.at !== null);
		const method = METHODS[text(doc.payment)] ?? 'cod';
		const { payments, refunds } = moneyOf(doc, method, total, timeline, ctx);
		const history = historyOf(doc, timeline);
		const customerId = ctx.ref('customers', doc.customerId);
		const snapshot = isObject(doc.customerSnapshot) ? doc.customerSnapshot : {};
		const address = isObject(doc.address) ? doc.address : null;
		const delivered = timeline.filter((entry) => entry.status === 'delivered').at(-1)?.at ?? null;
		const packedAt = timeline.find((entry) => entry.status === 'packed')?.at ?? null;
		const video = text(doc.dispatchVideoUrl);
		const deals = [...new Set(lines.map((line) => line.dealId).filter(Boolean))];
		return {
			id: ctx.id('ord', doc._id),
			number: text(doc.orderNumber),
			customer: {
				userId: (customerId && ctx.lookup(PEOPLE.members, customerId.slice(customerId.indexOf('_') + 1))) ?? '',
				customerId,
				name: text(snapshot.name),
				email: '',
				phone: phoneText(snapshot.phoneNumber),
			},
			address: address
				? {
						name: text(address.recipientName),
						phone: phoneText(address.phoneNumber),
						line1: text(address.street),
						line2: '',
						city: text(address.city),
						area: text(address.area),
						postalCode: text(address.postalCode),
						country: '',
						notes: '',
					}
				: null,
			delivery: { method: doc.delivery === 'pickup' ? 'pickup' : 'delivery', zone: '', fee: delivery, locationId: null },
			lines,
			totals: { subtotal, discount, delivery, tax: 0, total, currency: CURRENCY, taxIncluded: true, fee, roleDiscount: 0 },
			promotions: { dealIds: deals, ...pointsOf(doc, timeline) },
			payment: { method, ...(method === 'bank_transfer' ? { via: 'manual' } : {}) },
			payments,
			refunds,
			status,
			history,
			...(text(doc.trackingNote) || iso(doc.estimatedDeliveryAt)
				? { shipment: { trackingNote: text(doc.trackingNote), estimatedDeliveryAt: iso(doc.estimatedDeliveryAt) } }
				: {}),
			...(video
				? {
						media: [
							{
								kind: 'dispatch_video',
								...(/^(https?:)?\/\//i.test(video) ? { url: siteAddress(video) } : { key: mediaKey(video) }),
								...(packedAt ? { at: packedAt } : {}),
							},
						],
					}
				: {}),
			seenBy: seenOf(doc.seenByAdminIds),
			stockHeld: doc.inventoryReserved === true && !RELEASED.includes(role),
			holdUntil: null,
			idempotencyKey: text(doc.idempotencyKey) || `import:${hexKey(doc._id)}`,
			placedAt: iso(doc.placedAt) ?? iso(doc.createdAt),
			// a delivered or returned order without a `delivered` entry: the move that closed its history
			deliveredAt: UNDELIVERED.includes(role)
				? null
				: (delivered ?? (role === 'delivered' || role === 'returned' ? (history.at(-1)?.at ?? null) : null)),
			createdAt: iso(doc.placedAt) ?? iso(doc.createdAt),
		};
	},
	sums: (record) => ({
		[`orders.${record.status}.count`]: 1,
		[`orders.${record.status}.total`]: /** @type {{ total: number }} */ (record.totals).total,
	}),
	countPath: '/v1/orders/count',
};

/**
 * Take points out of lots: the given order's lot first (a reversal), then the oldest (Ecommerce's `takeFromLots` and
 * `spendFromLots`).
 * @param {Lot[]} lots @param {number} points @param {string | null} orderId
 * @returns {Lot[]}
 */
const takePoints = (lots, points, orderId) => {
	const order = lots
		.map((_, index) => index)
		.sort(
			(a, b) =>
				Number(orderId !== null && lots[b]?.orderId === orderId) - Number(orderId !== null && lots[a]?.orderId === orderId) ||
				a - b,
		);
	const out = [...lots];
	let left = points;
	for (const index of order) {
		const lot = /** @type {Lot} */ (out[index]);
		const take = Math.min(lot.left, left);
		out[index] = { ...lot, left: lot.left - take };
		left -= take;
	}
	return out;
};

/** @param {Lot[]} lots */
const balanceOf = (lots) => lots.reduce((sum, lot) => sum + lot.left, 0);

/**
 * A history entry's kind for an SB transaction (IMP-5): SB writes its order give-backs and reversals as adjustments.
 * @param {string} kind @param {boolean} credit @param {string} reason
 */
const entryKind = (kind, credit, reason) => {
	if (kind === 'earn' || kind === 'redeem' || kind === 'expire') return kind;
	if (credit && reason.startsWith('Redeemed points refunded')) return 'refund';
	if (!credit && reason.startsWith('Reversed for')) return 'reverse';
	return 'adjust';
};

/**
 * Loyalty accounts (E20), one per customer (merged customers' accounts join): lots rebuilt from SB's transactions, and
 * a correcting entry where SB's stored balance differs (IMP-5).
 * @type {MappingStep}
 */
export const loyaltyStep = {
	product: 'ecommerce',
	collection: 'loyalty',
	source: 'loyaltyaccounts',
	prefix: 'lot',
	key: ['customerId'],
	mergeKey: (_doc, record) => String(record.customerId),
	merge: (kept, next) => {
		/** @param {string} field */
		const joined = (field) =>
			[
				.../** @type {Array<{ at?: string, earnedAt?: string }>} */ (kept[field]),
				.../** @type {Array<{ at?: string, earnedAt?: string }>} */ (next[field]),
			].sort((a, b) => String(a.at ?? a.earnedAt).localeCompare(String(b.at ?? b.earnedAt)));
		return { ...kept, lots: joined('lots'), history: joined('history'), createdAt: earliest(kept.createdAt, next.createdAt) };
	},
	map: (doc, ctx) => {
		const customerId = ctx.ref('customers', doc.customerId);
		if (!customerId) return null;
		const transactions = (Array.isArray(doc.transactions) ? doc.transactions : [])
			.filter(isObject)
			.map((transaction, index) => ({ transaction, index, at: iso(transaction.occurredAt) }))
			.filter((entry) => entry.at !== null)
			.sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.index - b.index);
		/** @type {Lot[]} */
		let lots = [];
		/** @type {PointsEntry[]} */
		const history = [];
		for (const { transaction, index, at } of transactions) {
			const amount = Math.round(Number(transaction.amount) || 0);
			const points = Math.abs(amount);
			if (points === 0) continue;
			const kind = text(transaction.kind);
			const reason = text(transaction.reason);
			const credit = kind === 'earn' || kind === 'bonus' || (kind === 'adjust' && amount > 0);
			const orderRef = text(transaction.orderRef);
			const orderId = orderRef ? ctx.lookup(ORDER_NUMBERS, orderRef) : null;
			const entry = entryKind(kind, credit, reason);
			if (credit)
				lots.push({
					id: idOrNull('lot', transaction._id) ?? derivedId('lot', `${hexKey(doc._id)}:${index}`),
					points,
					left: points,
					earnedAt: /** @type {string} */ (at),
					expiresAt: null,
					orderId,
					kind: entry === 'earn' || entry === 'refund' ? entry : 'adjust',
				});
			else lots = takePoints(lots, points, entry === 'reverse' ? orderId : null);
			history.push({ at: /** @type {string} */ (at), kind: entry, points, orderId, note: reason });
		}
		// one correcting entry where SB's stored balance differs from what its transactions give
		const stored = Math.max(0, Math.round(Number(doc.balance) || 0));
		const difference = stored - balanceOf(lots);
		const correctedAt = iso(doc.updatedAt) ?? history.at(-1)?.at ?? iso(doc.createdAt);
		if (difference !== 0 && correctedAt) {
			if (difference > 0)
				lots.push({
					id: ctx.id('lot', doc._id),
					points: difference,
					left: difference,
					earnedAt: correctedAt,
					expiresAt: null,
					orderId: null,
					kind: 'adjust',
				});
			else lots = takePoints(lots, -difference, null);
			history.push({
				at: correctedAt,
				kind: 'adjust',
				points: Math.abs(difference),
				orderId: null,
				note: `${IMPORTED}: balance correction`,
			});
		}
		return {
			customerId,
			userId: ctx.lookup(PEOPLE.members, customerId.slice(customerId.indexOf('_') + 1)),
			lots,
			history,
			createdAt: iso(doc.createdAt),
		};
	},
	sums: (record) => ({
		'loyalty.points': /** @type {Lot[]} */ (record.lots).reduce((sum, lot) => sum + lot.left, 0),
	}),
};
