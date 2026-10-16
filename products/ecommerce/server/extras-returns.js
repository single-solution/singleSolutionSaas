/**
 * Return and warranty claims (feature `returns`, PLAN 0.8.8): a signed-in shopper claims items of their own delivered
 * order within each item's window, with photos uploaded straight to the merchant's storage; the merchant's staff (or
 * server) approve or reject, mark the package received, refund (through Payments when the order was paid online, else
 * recorded), restock each line exactly once (the ledger's `restockClaimLines`) and close. Loyalty points earned on the
 * returned part are taken back on the first refund. The shopper gets a message (`ecommerce.return_status`) at each
 * step. Each step's history entry names who did it (a ticket's user, the staff member a server-token call names in its
 * `SS-Actor-*` headers, else `Server`), and its activity entry the claim (order number and reference) and the move.
 *
 * E33: staff choose per line when receiving whether it goes back in stock (those lines are restocked at once, each
 * exactly once); a refund names its method and reference and is also written on the order's `refunds` (with the
 * claim's id), the delivery fee inside the cap when `refundDelivery` is on, and points taken back as `pointsBack` says;
 * staff notes; a new claim raises the `return.requested` hook.
 *
 * E17/E18: the merchant's claim kinds (`claim_kinds`: window, outcomes, offered to shoppers or not) and claim statuses
 * (`claim_statuses`, each on a fixed role, `core/returns.js`); the shopper's form reads the kinds and reasons from
 * `returnable`; staff move a claim between the statuses of one role (`POST …/status`); the `store_credit` outcome gives
 * the shopper a one-use code of the credited amount (a fixed coupon, so it needs the Coupons feature), told in the
 * claim message.
 * @module
 */
import { randomBytes } from 'node:crypto';
import { createId } from '@ss/contracts';
import { countHandlers, created, defineRoute, paginate, problem } from '@ss/app-kit';
import { categoriesOf } from '../adapters/catalog-store.js';
import { applyTransition, isPointsChanged, restockClaimLines } from '../adapters/ledger.js';
import { userIdsOf } from '../adapters/extras-store.js';
import { insertOffers } from '../adapters/promotions-store.js';
import { checkCouponInput, drawCode } from '../core/coupons.js';
import { labelIn } from '../core/named-lists.js';
import { lineageOf } from '../core/catalog-taxonomy.js';
import { afterFilter, keyOf, sortOf } from '../core/extras-pages.js';
import { COLLECTIONS, ID_PREFIX, NO_ID } from '../core/model.js';
import {
	CLAIM_ACTIONS,
	CLAIM_ROLES,
	PHOTO_SECONDS,
	actionsOf,
	allows,
	CLAIM_NOTES,
	checkClaimInput,
	checkNote,
	checkPhotoInput,
	checkRefundMethod,
	checkRestockChoices,
	claimReference,
	claimedByLine,
	creditCap,
	deliveryLeft,
	isPhotoKey,
	linesToRestock,
	photoFolder,
	planClaim,
	pointsToReverse,
	referenceOf,
	refundCap,
	returnableLines,
	statusIn,
	windowDefaults,
} from '../core/returns.js';
import { measureView, piecesOf, quantityText } from '../core/measure.js';
import { byActor, earnedLeft, pointsOwner, refundSplit, refundable, warningsOf } from '../core/orders.js';
import { createMedia } from './catalog-media.js';
import { createMoves } from './orders-moves.js';
import { SERVER_LIMITS, VISITOR_LIMITS, VISITOR_WRITE_LIMITS, bodyOf } from './service.js';

/** Tries of taking a claim's points back while the order or its loyalty account changes meanwhile. */
const POINTS_TRIES = 5;

/**
 * The values of the claim message `ecommerce.return_status` (`business` is added by `service.notify`); `tell` below
 * fills exactly these, and `schemas/messages.json` declares them.
 */
export const RETURN_MESSAGE_VALUES = Object.freeze(
	/** @type {const} */ (['number', 'claim', 'kind', 'status', 'reason', 'amount', 'credit', 'creditCode', 'name']),
);

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */
/** @typedef {import('../core/model.js').ReturnRecord} ReturnRecord */
/** @typedef {import('../core/durations.js').Duration} Duration */
/** @typedef {import('../core/model.js').OrderRecord} OrderRecord */
/** @typedef {import('../core/model.js').OrderRefundEntry} OrderRefundEntry */
/** @typedef {import('../core/returns.js').ClaimAction} ClaimAction */
/** @typedef {import('../core/returns.js').ClaimKind} ClaimKind */
/** @typedef {import('../core/returns.js').ClaimStatus} ClaimStatus */
/** @typedef {import('../core/returns.js').ClaimRole} ClaimRole */
/** @typedef {{ kinds: ClaimKind[], statuses: ClaimStatus[] }} ClaimLists */
/** @typedef {ReturnRecord & { createdAt: Date, updatedAt: Date }} StoredClaim */

/** Newest claims first. @type {import('../core/extras-pages.js').SortField[]} */
const NEWEST = [
	{ field: 'createdAt', direction: -1, date: true },
	{ field: 'id', direction: -1 },
];

/** Why a line cannot be claimed, for the shopper. */
const NOT_RETURNABLE = Object.freeze({
	unknown: 'This item is not part of the order or cannot be returned.',
	window_closed: 'The time to claim this item has passed.',
	quantity: 'More units than can still be claimed.',
	step: 'This item is sold in a unit of its own: claim it in the steps it was sold in.',
});

/** @param {Date | null | undefined} at */
const iso = (at) => (at ? new Date(at).toISOString() : null);

/** A claim as the activity log names it: its order number and reference. @param {ReturnRecord} claim */
const claimLabel = (claim) => `${claim.orderNumber} ${referenceOf(claim)}`;

/** Store credit codes start with this, then 8 random characters. */
const CREDIT_PREFIX = 'CREDIT-';

/** A random byte source for codes. */
const byteSource = () => {
	let buffer = randomBytes(64);
	let offset = 0;
	return () => {
		if (offset >= buffer.length) {
			buffer = randomBytes(64);
			offset = 0;
		}
		const byte = /** @type {number} */ (buffer[offset]);
		offset += 1;
		return byte;
	};
};

/**
 * @param {Product} product
 * @param {Service} service
 */
export const createReturns = (product, service) => {
	const media = createMedia(product);
	// a claim's refund is an order refund (OR-3)
	const moves = createMoves(product, service);

	/**
	 * Whether some of what an order was paid can still go back through Payments (PM-2).
	 * @param {OrderRecord} order
	 */
	const paidOnline = (order) => refundSplit(order, 1).online > 0;

	/** @param {WebsiteData} data */
	const claims = (data) => data.collection(COLLECTIONS.returns);

	/**
	 * The merchant's claim kinds and statuses (E18).
	 * @param {Site} s
	 * @returns {Promise<ClaimLists>}
	 */
	const listsOf = async (s) => {
		const [kinds, statuses] = await Promise.all([s.list('claim_kinds'), s.list('claim_statuses')]);
		return { kinds: Array.isArray(kinds) ? kinds : [], statuses: Array.isArray(statuses) ? statuses : [] };
	};

	/**
	 * @param {WebsiteData} data
	 * @param {Record<string, unknown>} filter
	 * @returns {Promise<OrderRecord | null>}
	 */
	const findOrder = async (data, filter) =>
		/** @type {OrderRecord | null} */ (
			await data.collection(COLLECTIONS.orders).findOne({ websiteId: data.websiteId, ...filter }, NO_ID)
		);

	/**
	 * @param {WebsiteData} data
	 * @param {unknown} id
	 * @returns {Promise<StoredClaim>}
	 */
	const claimOf = async (data, id) => {
		const found =
			typeof id === 'string' && id.length <= 80
				? /** @type {StoredClaim | null} */ (await claims(data).findOne({ websiteId: data.websiteId, id }, NO_ID))
				: null;
		if (!found) throw problem('not_found', 'No such claim.');
		return found;
	};

	/**
	 * What can still be claimed on an order's lines.
	 * @param {Site} s
	 * @param {WebsiteData} data
	 * @param {OrderRecord} order
	 */
	const returnableOf = async (s, data, order) => {
		const existing = /** @type {ReturnRecord[]} */ (
			await claims(data).find({ websiteId: data.websiteId, orderId: order.id }, NO_ID).toArray()
		);
		const ids = [...new Set(order.lines.map((line) => line.productId))];
		const products = /** @type {Array<{ id: string, returnTime: Duration | null, warrantyTime: Duration | null }>} */ (
			await data
				.collection(COLLECTIONS.products)
				.find(
					{ websiteId: data.websiteId, id: { $in: ids } },
					{ projection: { _id: 0, id: 1, returnTime: 1, warrantyTime: 1 } },
				)
				.toArray()
		);
		const graded = order.lines.some((line) => line.grade);
		const [grades, categories] = graded ? await Promise.all([s.list('grades'), categoriesOf(data)]) : [[], []];
		const byId = new Map(categories.map((category) => [category.id, category]));
		const settings = await s.values('returns');
		return returnableLines({
			order,
			claims: existing,
			products: new Map(
				products.map((p) => [p.id, { returnTime: p.returnTime ?? null, warrantyTime: p.warrantyTime ?? null }]),
			),
			grades: Array.isArray(grades) ? grades : [],
			lineage: (categoryIds) => lineageOf(categoryIds, byId),
			defaults: windowDefaults(settings),
			now: service.now(),
		});
	};

	/**
	 * Tell the shopper where their claim is (on the `checkout` setting `messageChannels`): the kind and status by the
	 * merchant's names (the `claim_kinds` and `claim_statuses` lists, as the shopper's claims list shows them), the
	 * reason they gave, the refund and the store credit with its code.
	 * @param {Site} s
	 * @param {OrderRecord | null} order
	 * @param {ReturnRecord} claim
	 */
	const tell = async (s, order, claim) => {
		if (!order) return;
		const { messageChannels } = await s.values('checkout');
		const { kinds, statuses } = await listsOf(s);
		const { money } = await s.format();
		const credit = claim.creditAmount ?? 0;
		/** Exactly {@link RETURN_MESSAGE_VALUES}. @type {Record<typeof RETURN_MESSAGE_VALUES[number], string>} */
		const values = {
			number: order.number,
			claim: referenceOf(claim),
			kind: labelIn(kinds, claim.kind),
			status: labelIn(statuses, claim.status),
			reason: claim.reason.slice(0, 1000),
			amount: claim.refundAmount > 0 ? money(claim.refundAmount, order.totals.currency) : '',
			credit: credit > 0 ? money(credit, order.totals.currency) : '',
			creditCode: (claim.creditCodes ?? []).at(-1) ?? '',
			name: order.customer.name,
		};
		await service.notify(
			s,
			'ecommerce.return_status',
			{ email: order.customer.email, phone: order.customer.phone },
			values,
			Array.isArray(messageChannels) ? messageChannels : ['email'],
			// about the shopper's own order: required, and tried again when Notifications cannot be reached (K-17)
			{ required: true },
		);
	};

	/**
	 * A claim as its shopper sees it: the staff's notes to them, never the shop's own notes (`restocked`).
	 * @param {StoredClaim} claim
	 * @param {ClaimLists} lists
	 */
	const shopperView = (claim, { kinds, statuses }) => ({
		id: claim.id,
		reference: referenceOf(claim),
		orderId: claim.orderId,
		orderNumber: claim.orderNumber,
		kind: claim.kind,
		kindLabel: labelIn(kinds, claim.kind),
		lines: claim.lines.map((line) => ({ lineId: line.lineId, quantity: line.quantity })),
		reason: claim.reason,
		status: claim.status,
		statusLabel: labelIn(statuses, claim.status),
		role: claim.role,
		refundAmount: claim.refundAmount,
		creditAmount: claim.creditAmount ?? 0,
		creditCodes: claim.creditCodes ?? [],
		history: claim.history.map((entry) => ({
			at: iso(entry.at),
			status: entry.status,
			statusLabel: labelIn(statuses, entry.status),
			note: /** @type {readonly string[]} */ (CLAIM_NOTES).includes(entry.note) ? '' : entry.note,
		})),
		createdAt: iso(claim.createdAt),
	});

	/**
	 * @param {StoredClaim} claim
	 * @param {ClaimLists} lists
	 */
	const staffView = (claim, { kinds, statuses }) => ({
		id: claim.id,
		reference: referenceOf(claim),
		orderId: claim.orderId,
		orderNumber: claim.orderNumber,
		userId: claim.userId,
		kind: claim.kind,
		kindLabel: labelIn(kinds, claim.kind),
		window: claim.window,
		outcomes: claim.outcomes,
		lines: claim.lines.map((line) => ({ ...line, restockedAt: iso(line.restockedAt) })),
		reason: claim.reason,
		photos: claim.photos.map((photo) => ({ key: photo.key, type: photo.type, size: photo.size })),
		status: claim.status,
		statusLabel: labelIn(statuses, claim.status),
		role: claim.role,
		// the other statuses of the claim's role staff may move it to (`POST …/status`)
		statuses: statuses
			.filter((status) => status.role === claim.role && status.key !== claim.status)
			.map((status) => ({ key: status.key, label: status.label })),
		refundAmount: claim.refundAmount,
		creditAmount: claim.creditAmount ?? 0,
		creditCodes: claim.creditCodes ?? [],
		refundId: claim.refundId,
		refundMethod: claim.refundMethod ?? null,
		refundReference: claim.refundReference ?? '',
		restockedAt: iso(claim.restockedAt),
		history: claim.history.map((entry) => ({ ...entry, at: iso(entry.at), statusLabel: labelIn(statuses, entry.status) })),
		notes: (claim.notes ?? []).map((entry) => ({ ...entry, at: iso(entry.at) })),
		actions: actionsOf(claim),
		createdAt: iso(claim.createdAt),
		updatedAt: iso(claim.updatedAt),
	});

	// ------------------------------------------------------------------------------------------------- shopper

	/** @param {any} ctx */
	const returnable = async (ctx) => {
		const s = await service.site(ctx);
		const shopper = await service.requireShopper(s);
		const data = await s.data();
		const order = await findOrder(data, { id: String(ctx.params.id), 'customer.userId': shopper.id });
		if (!order) throw problem('not_found', 'No such order.');
		const lines = order.deliveredAt ? await returnableOf(s, data, order) : [];
		const [{ kinds }, settings] = await Promise.all([listsOf(s), s.values('returns')]);
		return {
			orderId: order.id,
			number: order.number,
			deliveredAt: iso(order.deliveredAt),
			// what the shopper may ask for: the merchant's kinds offered to shoppers, each with the window it is counted in
			kinds: kinds.filter((kind) => kind.shoppers).map((kind) => ({ key: kind.key, label: kind.label, window: kind.window })),
			// the merchant's reasons (none: the shopper says why in their own words) and whether "Other" is offered (E17)
			reasons: Array.isArray(settings.reasons) ? settings.reasons : [],
			otherReason: settings.otherReason !== false,
			lines: await Promise.all(
				lines.map(async (entry) => ({
					lineId: entry.line.id,
					productId: entry.line.productId,
					name: entry.line.name,
					variantName: entry.line.variantName,
					image: await media.mediaUrl(s, entry.line.image),
					quantity: entry.line.quantity,
					claimable: entry.claimable,
					// an item sold in a unit of its own: its unit and step (quantities are thousandths of the unit)
					measure: entry.line.measure
						? {
								unit: entry.line.measure.unit,
								step: entry.line.measure.step,
								quantityText: quantityText(entry.claimable, true),
							}
						: null,
					// each window's time as the merchant typed it (E14)
					return: { time: entry.return.time, until: iso(entry.return.until), open: entry.return.open },
					warranty: { time: entry.warranty.time, until: iso(entry.warranty.until), open: entry.warranty.open },
				})),
			),
		};
	};

	/** @param {any} ctx */
	const uploadPhoto = async (ctx) => {
		const s = await service.site(ctx);
		const shopper = await service.requireShopper(s);
		const settings = await s.values('returns');
		if (Number(settings.maxPhotos) < 1) throw service.invalid('type', 'Photos are not taken with claims.');
		const checked = checkPhotoInput(bodyOf(ctx), { photoMaxMb: Number(settings.photoMaxMb) });
		if (!checked.ok) throw service.invalid(checked.field, checked.message);
		const storage = await service.storage(s);
		const signed = storage.presignPut({
			key: `${photoFolder(shopper.id)}${createId('pho')}.${checked.extension}`,
			contentType: checked.type,
			contentLength: checked.size,
			expiresIn: PHOTO_SECONDS,
		});
		return created({
			upload: { method: signed.method, url: signed.url, headers: signed.headers },
			key: signed.key,
			expiresAt: signed.expiresAt,
		});
	};

	/** @param {any} ctx */
	const createClaim = async (ctx) => {
		const s = await service.site(ctx);
		const shopper = await service.requireShopper(s);
		const settings = await s.values('returns');
		const lists = await listsOf(s);
		const checked = checkClaimInput(bodyOf(ctx), {
			maxPhotos: Number(settings.maxPhotos),
			kinds: lists.kinds,
			reasons: Array.isArray(settings.reasons) ? settings.reasons : [],
			otherReason: settings.otherReason !== false,
		});
		if (!checked.ok) throw service.invalid(checked.field, checked.message);
		const input = checked.value;
		const kind = /** @type {ClaimKind} */ (lists.kinds.find((entry) => entry.key === input.kind));
		const requested = /** @type {ClaimStatus} */ (statusIn(lists.statuses, 'requested'));
		const data = await s.data();
		const order = await findOrder(data, { id: input.orderId, 'customer.userId': shopper.id });
		if (!order) throw problem('not_found', 'No such order.');
		if (!order.deliveredAt) throw problem('not_returnable', 'Items can be claimed once the order is delivered.');
		const planned = planClaim(kind.window, input.lines, await returnableOf(s, data, order));
		if (!planned.ok)
			throw problem('not_returnable', NOT_RETURNABLE[planned.reason], {
				errors: [{ path: '/lines', message: NOT_RETURNABLE[planned.reason], code: planned.reason }],
			});
		/** @type {ReturnRecord['photos']} */
		const photos = [];
		if (input.photos.length > 0) {
			const storage = await service.storage(s);
			for (const key of input.photos) {
				const head = isPhotoKey(key, shopper.id) ? await storage.headObject({ key }) : null;
				if (!head?.exists) throw service.invalid('photos', 'A photo was not uploaded.');
				photos.push({ key, type: head.contentType ?? '', size: head.size, alt: '' });
			}
		}
		const at = new Date(service.now());
		const id = createId(ID_PREFIX.claim);
		/** @type {ReturnRecord} */
		const claim = {
			id,
			reference: claimReference(id, settings.referencePrefix),
			orderId: order.id,
			orderNumber: order.number,
			userId: shopper.id,
			kind: kind.key,
			window: kind.window,
			outcomes: [...kind.outcomes],
			lines: planned.lines,
			reason: input.reason,
			photos,
			status: requested.key,
			role: 'requested',
			refundAmount: 0,
			refundId: null,
			restockedAt: null,
			history: [{ at, status: requested.key, role: 'requested', by: 'shopper', note: '' }],
			notes: [],
		};
		await claims(data).insertOne({ ...claim });
		// two claims made at the same moment: the later one gives way if together they claim too much
		const all = /** @type {StoredClaim[]} */ (
			await claims(data).find({ websiteId: data.websiteId, orderId: order.id }, NO_ID).toArray()
		);
		const held = claimedByLine(all);
		const over = claim.lines.some((line) => {
			const bought = order.lines.find((l) => l.id === line.lineId)?.quantity ?? 0;
			return (held.get(line.lineId)?.quantity ?? 0) > bought;
		});
		const mine = /** @type {StoredClaim} */ (all.find((c) => c.id === claim.id));
		if (over && all.some((c) => c.id !== claim.id && c.createdAt.getTime() <= mine.createdAt.getTime())) {
			await claims(data).deleteOne({ websiteId: data.websiteId, id: claim.id });
			throw problem('not_returnable', NOT_RETURNABLE.quantity);
		}
		await tell(s, order, claim);
		await service.emit('return.requested', s, { claim: mine, order });
		return created(shopperView(mine, lists));
	};

	/** @param {any} ctx */
	const myClaims = async (ctx) => {
		const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url }, { defaultLimit: 20 });
		const s = await service.site(ctx);
		const shopper = await service.requireShopper(s);
		const data = await s.data();
		const rows = /** @type {StoredClaim[]} */ (
			await claims(data)
				.find(
					{ websiteId: data.websiteId, userId: shopper.id, ...afterFilter(NEWEST, page.after) },
					{ ...NO_ID, sort: sortOf(NEWEST), limit: page.fetchLimit },
				)
				.toArray()
		);
		const lists = await listsOf(s);
		return page.respond(
			rows.map((row) => shopperView(row, lists)),
			(view) => [/** @type {string} */ (view.createdAt), view.id],
		);
	};

	// --------------------------------------------------------------------------------------------------- staff

	/**
	 * The staff claim list's collection and filter (`status`, `role`, `kind`, `orderId`, `userId`), shared by the list
	 * and its counts (PLAN 0.8.10 K4).
	 * @param {any} ctx
	 */
	const claimSource = async (ctx) => {
		const data = await (await service.site(ctx)).data();
		const { status, role, kind, orderId, userId } = ctx.query;
		/** @param {unknown} value */
		const key = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(value);
		return {
			collection: claims(data),
			filter: {
				websiteId: data.websiteId,
				...(key(status) ? { status } : {}),
				.../** @type {readonly string[]} */ (CLAIM_ROLES.includes(role) ? { role } : {}),
				...(key(kind) ? { kind } : {}),
				...(typeof orderId === 'string' && orderId ? { orderId } : {}),
				...(typeof userId === 'string' && userId ? { userId } : {}),
			},
		};
	};
	const claimCounts = countHandlers({ source: claimSource, by: { status: 'status', role: 'role', kind: 'kind' } });

	/** @param {any} ctx */
	const listClaims = async (ctx) => {
		const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url }, { defaultLimit: 25 });
		const { collection, filter } = await claimSource(ctx);
		const rows = /** @type {StoredClaim[]} */ (
			await collection
				.find({ ...filter, ...afterFilter(NEWEST, page.after) }, { ...NO_ID, sort: sortOf(NEWEST), limit: page.fetchLimit })
				.toArray()
		);
		const lists = await listsOf(await service.site(ctx));
		return page.respond(
			rows.map((row) => staffView(row, lists)),
			(view) => keyOf(NEWEST, view),
		);
	};

	/**
	 * The most that can still be refunded on a claim: with the `refundDelivery` setting, the order's delivery fee not yet
	 * refunded by its other claims is inside the cap (E33).
	 * @param {Site} s
	 * @param {WebsiteData} data
	 * @param {OrderRecord} order
	 * @param {ReturnRecord} claim
	 */
	const capOf = async (s, data, order, claim) => {
		const { refundDelivery } = await s.values('returns');
		if (refundDelivery !== true) return refundCap(order, claim);
		const all = /** @type {ReturnRecord[]} */ (
			await claims(data).find({ websiteId: data.websiteId, orderId: order.id }, NO_ID).toArray()
		);
		return refundCap(order, claim, deliveryLeft(order, all, claim.id));
	};

	/**
	 * A claim with its order, the claimed lines as bought, photo links (5 minutes) and what can still be refunded.
	 * @param {Site} s
	 * @param {StoredClaim} claim
	 */
	const detailOf = async (s, claim) => {
		const data = await s.data();
		const order = await findOrder(data, { id: claim.orderId });
		const storage = claim.photos.length > 0 ? await product.connections.storage(s.websiteId) : null;
		return {
			...staffView(claim, await listsOf(s)),
			photos: claim.photos.map((photo) => ({
				key: photo.key,
				type: photo.type,
				size: photo.size,
				url: storage ? storage.presignGet({ key: photo.key, expiresIn: PHOTO_SECONDS }).url : null,
			})),
			lines: claim.lines.map((claimed) => {
				const line = order?.lines.find((l) => l.id === claimed.lineId);
				return {
					...claimed,
					restockedAt: iso(claimed.restockedAt),
					productId: line?.productId ?? null,
					variantId: line?.variantId ?? null,
					name: line?.name ?? '',
					variantName: line?.variantName ?? '',
					sku: line?.sku ?? '',
					unitPrice: line?.unitPrice ?? 0,
					bought: line?.quantity ?? 0,
					measure: measureView(claimed.quantity, line?.measure),
					total: line?.total ?? 0,
				};
			}),
			order: order
				? {
						id: order.id,
						number: order.number,
						customer: order.customer,
						currency: order.totals.currency,
						total: order.totals.total,
						payment: {
							method: order.payment.method,
							state: order.payment.state,
							paid: order.payment.paid,
							refunded: order.payment.refunded,
						},
						deliveredAt: iso(order.deliveredAt),
					}
				: null,
			refundable: order ? await capOf(s, data, order, claim) : 0,
			creditable: order ? creditCap(order, claim) : 0,
			refundsOnline: order ? paidOnline(order) : false,
		};
	};

	/**
	 * The merchant's claim kinds and statuses, for the staff screens' filters and moves (E18).
	 * @param {any} ctx
	 */
	const claimLists = async (ctx) => listsOf(await service.site(ctx));

	/** @param {any} ctx */
	const readClaim = async (ctx) => {
		const s = await service.site(ctx);
		return detailOf(s, await claimOf(await s.data(), ctx.params.id));
	};

	/**
	 * Put some of a claim's lines back in stock, each exactly once, with a history entry, an activity entry and the
	 * `products.changed` hook (back-in-stock alerts).
	 * @param {Site} s
	 * @param {any} ctx
	 * @param {WebsiteData} data
	 * @param {StoredClaim} claim
	 * @param {string[]} lineIds
	 * @returns {Promise<number>} the lines restocked now
	 */
	const restockLines = async (s, ctx, data, claim, lineIds) => {
		const order = await findOrder(data, { id: claim.orderId });
		if (!order) throw problem('not_found', 'The order of this claim is gone.');
		const lines = claim.lines
			.filter((claimed) => lineIds.includes(claimed.lineId))
			.map((claimed) => {
				const line = order.lines.find((l) => l.id === claimed.lineId);
				const physical = line?.kind === 'physical';
				return {
					lineId: claimed.lineId,
					serials: claimed.serials,
					productId: line?.productId ?? '',
					variantId: line?.variantId ?? '',
					quantity: physical ? claimed.quantity : 0,
					locationId: line?.locationId ?? null,
					measure: line?.measure ?? null,
				};
			});
		const productIds = [...new Set(lines.filter((line) => line.quantity > 0).map((line) => line.productId))];
		const before = /** @type {Array<{ id: string, price: number, inStock: boolean }>} */ (
			await data
				.collection(COLLECTIONS.products)
				.find({ websiteId: data.websiteId, id: { $in: productIds } }, { projection: { _id: 0, id: 1, price: 1, inStock: 1 } })
				.toArray()
		);
		const done = await restockClaimLines(data, { claimId: claim.id, orderId: order.id, lines, now: service.now() });
		if (done.length === 0) return 0;
		await claims(data).updateOne(
			{ websiteId: data.websiteId, id: claim.id },
			{
				$push: {
					history: {
						at: new Date(service.now()),
						status: claim.status,
						role: claim.role,
						...byActor(service.actor(ctx)),
						note: 'restocked',
						code: 'restocked',
					},
				},
			},
		);
		const back = lines.filter((line) => done.includes(line.lineId));
		const units = back.reduce((sum, line) => sum + piecesOf(line), 0);
		await service.log(ctx, 'return.restocked', claim.id, {
			label: claimLabel(claim),
			detail: `${units} item(s) back in stock`,
		});
		await service.emit('products.changed', s, {
			productIds,
			before: new Map(before.map((p) => [p.id, { price: p.price, inStock: p.inStock }])),
		});
		return done.length;
	};

	/**
	 * The status of a role a move leads to: the one staff name (`status`, of that role), else the claim's own when it
	 * already has that role (a refund or credit given again), else the role's first.
	 * @param {Site} s @param {StoredClaim} claim @param {ClaimRole} role @param {unknown} named
	 * @returns {Promise<ClaimStatus>}
	 */
	const targetOf = async (s, claim, role, named) => {
		const { statuses } = await listsOf(s);
		const given = named === undefined || named === null || named === '' ? null : named;
		const target = statusIn(statuses, role, given ?? (claim.role === role ? claim.status : null));
		if (!target) throw service.invalid('status', `status is a key of the claim_statuses list with the role ${role}.`);
		return target;
	};

	/**
	 * Approve, reject, mark received (with the staff's restock choice per line, E33), replace, repair or close: a move
	 * into the action's role (its first status, or the one staff name) with a history entry and a message to the shopper.
	 * @param {'approve' | 'reject' | 'receive' | 'replace' | 'repair' | 'close'} action
	 */
	const move = (action) => async (/** @type {any} */ ctx) => {
		const s = await service.site(ctx);
		const data = await s.data();
		const claim = await claimOf(data, ctx.params.id);
		const body = bodyOf(ctx);
		const note = checkNote(body.note, action === 'reject');
		if (!note.ok) throw service.invalid('note', note.message);
		const role = /** @type {ClaimRole} */ (CLAIM_ACTIONS[action].to);
		if (!allows(action, claim))
			throw problem('move_not_allowed', `A ${claim.role} ${claim.kind} claim cannot be moved to ${role}.`);
		const status = (await targetOf(s, claim, role, body.status)).key;
		const restock = action === 'receive' ? checkRestockChoices(body.lines, claim) : null;
		if (restock && !restock.ok) throw service.invalid(restock.field, restock.message);
		const choices = restock?.ok ? restock.choices : new Map();
		const entry = { at: new Date(service.now()), status, role, ...byActor(service.actor(ctx)), note: note.note };
		const moved = /** @type {StoredClaim | null} */ (
			await claims(data).findOneAndUpdate(
				{ websiteId: data.websiteId, id: claim.id, status: claim.status },
				{
					$set: {
						status,
						role,
						...(choices.size > 0
							? {
									lines: claim.lines.map((line) =>
										choices.has(line.lineId) ? { ...line, restock: choices.get(line.lineId) } : line,
									),
								}
							: {}),
					},
					$push: { history: entry },
				},
				{ returnDocument: 'after', ...NO_ID },
			)
		);
		if (!moved) throw problem('move_not_allowed', 'The claim changed meanwhile; reload it.');
		await service.log(ctx, `return.${role}`, claim.id, {
			label: claimLabel(claim),
			detail: `${claim.status} → ${status}`,
		});
		const restockNow = [...choices].filter(([, yes]) => yes).map(([lineId]) => lineId);
		if (restockNow.length > 0) await restockLines(s, ctx, data, moved, restockNow);
		await service.emit('return.status_changed', s, { claim: moved, from: claim.status, to: status });
		await tell(s, await findOrder(data, { id: claim.orderId }), moved);
		return detailOf(s, restockNow.length > 0 ? await claimOf(data, claim.id) : moved);
	};

	/**
	 * Refund a claim (a top-up refunds more) as an order refund (OR-3): through Payments for what Payments took when the
	 * method is `online` or none is given, else recorded with its method and reference (E33), never more than was paid
	 * and not refunded yet; the order's refund entries carry the claim's id, and with the flow's `refundsCover` trigger an
	 * order whose refunds reach what was paid moves to its refunded status (its message, events and points as that move
	 * does; staff need that move's permission). The units count as returned on the first refund; loyalty points go back
	 * as the `pointsBack` setting says, never more than the order earned and was not taken back yet (OR-10). A refund
	 * through Payments that Payments then refuses, or that is not sent, gives the claim its refund back
	 * (`server/transitions.js` `claimBack`): refunded again, its units and points are counted once.
	 * @param {any} ctx
	 */
	const refund = async (ctx) => {
		const s = await service.site(ctx);
		const data = await s.data();
		const claim = await claimOf(data, ctx.params.id);
		const body = bodyOf(ctx);
		const note = checkNote(body.note);
		if (!note.ok) throw service.invalid('note', note.message);
		if (!allows('refund', claim)) throw problem('move_not_allowed', `A ${claim.role} claim cannot be refunded.`);
		const status = (await targetOf(s, claim, 'refunded', body.status)).key;
		const order = await findOrder(data, { id: claim.orderId });
		if (!order) throw problem('not_found', 'The order of this claim is gone.');
		const how = checkRefundMethod(
			body,
			paidOnline(order),
			/** @type {Array<{ key: string }>} */ (await s.list('payment_methods')).map((method) => method.key),
		);
		if (!how.ok) throw service.invalid(how.field, how.message);
		const cap = await capOf(s, data, order, claim);
		if (cap <= 0 && refundable(order) <= 0)
			throw service.invalid('amount', 'Nothing paid is left to refund on this order; record the payment first.');
		const amount = body.amount;
		if (!Number.isSafeInteger(amount) || amount < 1 || amount > cap)
			throw service.invalid('amount', `The refund is a whole amount in minor units from 1 to ${cap}.`);
		// the claim's first money back (one Payments refused after all gave the claim its refund back, its units counted)
		const first = firstMoney(claim);
		const total = claim.refundAmount + amount;
		const money = (await s.format()).money(amount, order.totals.currency);
		const at = new Date(service.now());
		const entry = { at, status, role: 'refunded', ...byActor(service.actor(ctx)), note: note.note || money };
		// reserve the refund on the claim first, so two refunds at once cannot both pass the cap
		const reserved = await claims(data).updateOne(
			{ websiteId: data.websiteId, id: claim.id, status: claim.status, refundAmount: claim.refundAmount },
			{
				$set: {
					status,
					role: 'refunded',
					refundAmount: total,
					refundMethod: how.method,
					refundReference: how.reference,
				},
				$push: { history: entry },
			},
		);
		if (reserved.modifiedCount !== 1) throw problem('move_not_allowed', 'The claim changed meanwhile; reload it.');
		// without a method the order's refund rule splits it: Payments' share through Payments, the rest recorded
		const method = body.method === undefined || body.method === null ? null : how.method;
		/** @type {Awaited<ReturnType<typeof moves.refund>>} */
		let done;
		try {
			done = await moves.refund(s, ctx, order, {
				amount,
				reason: note.note,
				claimReference: referenceOf(claim),
				method,
				reference: how.reference,
				claimId: claim.id,
				claim: {
					id: claim.id,
					refundAmount: total,
					status,
					before: {
						status: claim.status,
						role: claim.role,
						refundAmount: claim.refundAmount,
						refundId: claim.refundId ?? null,
						refundMethod: claim.refundMethod ?? null,
						refundReference: claim.refundReference ?? null,
					},
				},
			});
		} catch (error) {
			await claims(data).updateOne(
				{ websiteId: data.websiteId, id: claim.id, refundAmount: total },
				{
					$set: {
						status: claim.status,
						role: claim.role,
						refundAmount: claim.refundAmount,
						...(claim.refundMethod === undefined ? {} : { refundMethod: claim.refundMethod }),
						...(claim.refundReference === undefined ? {} : { refundReference: claim.refundReference }),
					},
					...(claim.refundMethod === undefined ? { $unset: { refundMethod: '', refundReference: '' } } : {}),
					$pop: { history: 1 },
				},
			);
			throw error;
		}
		// the claim keeps how its money went back: the first entry written for it (Payments' share first)
		await claims(data).updateOne(
			{ websiteId: data.websiteId, id: claim.id },
			{
				$set: {
					refundId: done.refund.refundId || claim.refundId,
					refundMethod: done.entries[0]?.method ?? how.method,
				},
			},
		);
		await moneyBack(s, data, order, claim, first, true);
		await service.log(ctx, 'return.refunded', claim.id, { label: claimLabel(claim), detail: `Refunded ${money}` });
		const refunded = await claimOf(data, claim.id);
		if (refunded.status !== claim.status)
			await service.emit('return.status_changed', s, { claim: refunded, from: claim.status, to: refunded.status });
		await tell(s, order, refunded);
		return { ...(await detailOf(s, refunded)), ...warningsOf(done.warnings) };
	};

	/**
	 * Whether a claim has given no money back yet (a refund Payments refused after all gave the claim its refund back,
	 * its units counted: its history keeps that refund).
	 * @param {ReturnRecord} claim
	 */
	const firstMoney = (claim) =>
		claim.refundAmount === 0 &&
		!((claim.creditAmount ?? 0) > 0) &&
		!claim.history.some(
			(entry) =>
				/** @type {{ role?: string }} */ (entry).role === 'refunded' ||
				/** @type {{ role?: string }} */ (entry).role === 'credited',
		);

	/**
	 * After a claim's refund or store credit: on its first money back the order's lines count the units as returned;
	 * loyalty points go back as the `pointsBack` setting says (a store credit never completes the order's refund).
	 * @param {Site} s @param {WebsiteData} data @param {OrderRecord} order the order before the money went back
	 * @param {ReturnRecord} claim the claim before it @param {boolean} first @param {boolean} refunded
	 */
	const moneyBack = async (s, data, order, claim, first, refunded) => {
		if (first) {
			const returned = claim.lines.map((line, index) => [`lines.$[l${index}].returnedQuantity`, line.quantity]);
			const filters = claim.lines.map((line, index) => ({ [`l${index}.id`]: line.lineId }));
			await data
				.collection(COLLECTIONS.orders)
				.updateOne(
					{ websiteId: data.websiteId, id: order.id },
					{ $inc: Object.fromEntries(returned) },
					{ arrayFilters: filters },
				);
		}
		if (s.has('loyalty')) {
			const { pointsBack } = await s.values('returns');
			// a guest's points are theirs by customer id (E20, K-6)
			const owner = pointsOwner(order);
			for (let attempt = 1; owner && attempt <= POINTS_TRIES; attempt += 1) {
				const after = /** @type {OrderRecord} */ (await findOrder(data, { id: order.id }));
				// proportional: the claimed part's points on the claim's first refund; full_refund_only: every point the order
				// earned, once, when this refund completes the order's refund; never more than is left (a move may have taken
				// them already)
				const wanted =
					pointsBack === 'full_refund_only'
						? refunded && after.payment.refunded >= after.payment.paid && order.payment.refunded < order.payment.paid
							? order.promotions.pointsEarned
							: 0
						: first
							? pointsToReverse(order, claim)
							: 0;
				const points = Math.min(wanted, earnedLeft(after));
				if (points <= 0) break;
				// taken back with the order's count in one transaction, only while what it took back is as read: a return or
				// a refund moving the order at the same time takes them once
				try {
					const done = await applyTransition(
						data,
						{
							orderId: order.id,
							guard: { 'promotions.pointsReversed': after.promotions.pointsReversed ?? null },
							update: { $inc: { 'promotions.pointsReversed': points } },
							effects: [{ kind: 'take_points', owner, points, note: order.number }],
						},
						{ now: service.now() },
					);
					if (done) break;
				} catch (error) {
					if (!isPointsChanged(error)) throw error;
				}
			}
		}
	};

	/**
	 * Give store credit on a claim whose kind allows it (E18 outcome `store_credit`; more may be given later): a one-use
	 * code of the amount (a fixed coupon the shopper uses at checkout, so the Coupons feature must be on), never more
	 * than what the claim's lines were paid less what it refunded or credited, nor more than the order was paid less its
	 * refunds. The claim moves to its credited status (or the one staff name), the units count as returned and the points
	 * go back as on a first refund; the shopper's message carries the code.
	 * @param {any} ctx
	 */
	const credit = async (ctx) => {
		const s = await service.site(ctx);
		const data = await s.data();
		const claim = await claimOf(data, ctx.params.id);
		const body = bodyOf(ctx);
		const note = checkNote(body.note);
		if (!note.ok) throw service.invalid('note', note.message);
		if (!allows('credit', claim)) throw problem('move_not_allowed', `A ${claim.role} ${claim.kind} claim cannot be credited.`);
		if (!s.has('coupons'))
			throw problem('feature_off', 'Store credit is given as a one-use code: turn on the Coupons feature first.');
		const status = (await targetOf(s, claim, 'credited', body.status)).key;
		const order = await findOrder(data, { id: claim.orderId });
		if (!order) throw problem('not_found', 'The order of this claim is gone.');
		const cap = creditCap(order, claim);
		const amount = body.amount;
		if (!Number.isSafeInteger(amount) || amount < 1 || amount > cap)
			throw service.invalid('amount', `The store credit is a whole amount in minor units from 1 to ${cap}.`);
		const first = firstMoney(claim);
		const given = (claim.creditAmount ?? 0) + amount;
		const money = (await s.format()).money(amount, order.totals.currency);
		const code = drawCode(CREDIT_PREFIX, byteSource());
		const entry = {
			at: new Date(service.now()),
			status,
			role: 'credited',
			...byActor(service.actor(ctx)),
			note: note.note || money,
		};
		// reserve the credit on the claim first, so two credits at once cannot both pass the cap
		const reserved = await claims(data).updateOne(
			{
				websiteId: data.websiteId,
				id: claim.id,
				status: claim.status,
				creditAmount: claim.creditAmount ?? { $in: [null, 0] },
			},
			{
				$set: { status, role: 'credited', creditAmount: given },
				$push: { history: entry, creditCodes: code },
			},
		);
		if (reserved.modifiedCount !== 1) throw problem('move_not_allowed', 'The claim changed meanwhile; reload it.');
		const coupon = checkCouponInput({ code, type: 'fixed', value: amount, limit: 1, perCustomer: 1 });
		if (!coupon.ok) throw new Error(`store credit code: ${coupon.message}`);
		await insertOffers(data, 'coupons', [{ id: createId(ID_PREFIX.coupon), ...coupon.value, used: 0 }]);
		await moneyBack(s, data, order, claim, first, false);
		await service.log(ctx, 'return.credited', claim.id, { label: claimLabel(claim), detail: `Store credit ${money}` });
		const credited = await claimOf(data, claim.id);
		if (credited.status !== claim.status)
			await service.emit('return.status_changed', s, { claim: credited, from: claim.status, to: credited.status });
		await tell(s, order, credited);
		return detailOf(s, credited);
	};

	/**
	 * Move a claim to another status of its role (E18: approved → "label sent", received → "inspecting" …), with a
	 * history entry and a message to the shopper.
	 * @param {any} ctx
	 */
	const restatus = async (ctx) => {
		const s = await service.site(ctx);
		const data = await s.data();
		const claim = await claimOf(data, ctx.params.id);
		const body = bodyOf(ctx);
		const note = checkNote(body.note);
		if (!note.ok) throw service.invalid('note', note.message);
		const { statuses } = await listsOf(s);
		const target = statusIn(statuses, claim.role, typeof body.status === 'string' && body.status ? body.status : null);
		if (!target || target.key === claim.status || typeof body.status !== 'string')
			throw service.invalid('status', `status is another key of the claim_statuses list with the role ${claim.role}.`);
		const moved = /** @type {StoredClaim | null} */ (
			await claims(data).findOneAndUpdate(
				{ websiteId: data.websiteId, id: claim.id, status: claim.status },
				{
					$set: { status: target.key },
					$push: {
						history: {
							at: new Date(service.now()),
							status: target.key,
							role: claim.role,
							...byActor(service.actor(ctx)),
							note: note.note,
						},
					},
				},
				{ returnDocument: 'after', ...NO_ID },
			)
		);
		if (!moved) throw problem('move_not_allowed', 'The claim changed meanwhile; reload it.');
		await service.log(ctx, 'return.status', claim.id, { label: claimLabel(claim), detail: `${claim.status} → ${target.key}` });
		await service.emit('return.status_changed', s, { claim: moved, from: claim.status, to: target.key });
		await tell(s, await findOrder(data, { id: claim.orderId }), moved);
		return detailOf(s, moved);
	};

	/**
	 * Put back in stock every claimed line not restocked yet and not kept out when received.
	 * @param {any} ctx
	 */
	const restock = async (ctx) => {
		const s = await service.site(ctx);
		const data = await s.data();
		const claim = await claimOf(data, ctx.params.id);
		if (!allows('restock', claim)) throw problem('move_not_allowed', `A ${claim.role} claim cannot be restocked.`);
		const left = linesToRestock(claim).map((line) => line.lineId);
		if (left.length === 0 || (await restockLines(s, ctx, data, claim, left)) === 0)
			throw problem('conflict', 'This claim was already restocked.');
		return detailOf(s, await claimOf(data, claim.id));
	};

	/**
	 * Add a staff note to a claim (E33; never shown to the shopper).
	 * @param {any} ctx
	 */
	const addNote = async (ctx) => {
		const s = await service.site(ctx);
		const data = await s.data();
		const claim = await claimOf(data, ctx.params.id);
		const text = checkNote(bodyOf(ctx).text);
		if (!text.ok) throw service.invalid('text', text.message);
		if (text.note === '') throw service.invalid('text', 'Write the note.');
		const note = { at: new Date(service.now()), by: service.actor(ctx).name, text: text.note };
		await claims(data).updateOne({ websiteId: data.websiteId, id: claim.id }, { $push: { notes: note } });
		await service.log(ctx, 'return.noted', claim.id, { label: claimLabel(claim) });
		return created(await detailOf(s, await claimOf(data, claim.id)));
	};

	// ---------------------------------------------------------------------------------------------- data rights

	/**
	 * @param {Site} s
	 * @param {{ id?: string, email?: string, phone?: string }} person
	 */
	const exportUser = async (s, person) => {
		const data = await s.data();
		const users = await userIdsOf(data, person);
		if (users.length === 0) return { returnClaims: [] };
		const rows = /** @type {StoredClaim[]} */ (
			await claims(data)
				.find({ websiteId: data.websiteId, userId: { $in: users } }, NO_ID)
				.toArray()
		);
		const lists = await listsOf(s);
		return { returnClaims: rows.map((row) => shopperView(row, lists)) };
	};

	/**
	 * Claims keep their amounts (the shop's accounts) but lose who made them, the reason and the photos.
	 * @param {Site} s
	 * @param {{ id?: string, email?: string, phone?: string }} person
	 */
	const deleteUser = async (s, person) => {
		const data = await s.data();
		const users = await userIdsOf(data, person);
		if (users.length === 0) return { deleted: 0, anonymised: 0 };
		const rows = /** @type {StoredClaim[]} */ (
			await claims(data)
				.find({ websiteId: data.websiteId, userId: { $in: users } }, NO_ID)
				.toArray()
		);
		const keys = rows.flatMap((claim) => claim.photos.map((photo) => photo.key));
		const storage = keys.length > 0 ? await product.connections.storage(s.websiteId) : null;
		for (const key of storage ? keys : []) await storage?.deleteObject({ key }).catch(() => undefined);
		const result = await claims(data).updateMany(
			{ websiteId: data.websiteId, userId: { $in: users } },
			{ $set: { userId: '', reason: '', photos: [] } },
		);
		return { deleted: 0, anonymised: result.modifiedCount };
	};

	const routes = [
		// shopper
		defineRoute({
			method: 'GET',
			path: '/v1/shop/orders/:id/returnable',
			auth: 'browser',
			feature: 'returns',
			rateLimit: VISITOR_LIMITS,
			handler: returnable,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/shop/returns/photos',
			auth: 'browser',
			feature: 'returns',
			rateLimit: VISITOR_WRITE_LIMITS,
			handler: uploadPhoto,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/shop/returns',
			auth: 'browser',
			feature: 'returns',
			idempotent: true,
			rateLimit: VISITOR_WRITE_LIMITS,
			handler: createClaim,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/shop/returns',
			auth: 'browser',
			feature: 'returns',
			rateLimit: VISITOR_LIMITS,
			handler: myClaims,
		}),

		// merchant's server
		defineRoute({
			method: 'GET',
			path: '/v1/returns',
			auth: 'server',
			feature: 'returns',
			rateLimit: SERVER_LIMITS,
			handler: listClaims,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/returns/count',
			auth: 'server',
			feature: 'returns',
			rateLimit: SERVER_LIMITS,
			handler: claimCounts.count,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/returns/counts',
			auth: 'server',
			feature: 'returns',
			rateLimit: SERVER_LIMITS,
			handler: claimCounts.counts,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/returns/lists',
			auth: 'server',
			feature: 'returns',
			rateLimit: SERVER_LIMITS,
			handler: claimLists,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/returns/:id',
			auth: 'server',
			feature: 'returns',
			rateLimit: SERVER_LIMITS,
			handler: readClaim,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/returns/:id/approve',
			auth: 'server',
			feature: 'returns',
			rateLimit: SERVER_LIMITS,
			handler: move('approve'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/returns/:id/reject',
			auth: 'server',
			feature: 'returns',
			rateLimit: SERVER_LIMITS,
			handler: move('reject'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/returns/:id/receive',
			auth: 'server',
			feature: 'returns',
			rateLimit: SERVER_LIMITS,
			handler: move('receive'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/returns/:id/refund',
			auth: 'server',
			feature: 'returns',
			idempotent: true,
			rateLimit: SERVER_LIMITS,
			handler: refund,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/returns/:id/restock',
			auth: 'server',
			feature: 'returns',
			rateLimit: SERVER_LIMITS,
			handler: restock,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/returns/:id/close',
			auth: 'server',
			feature: 'returns',
			rateLimit: SERVER_LIMITS,
			handler: move('close'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/returns/:id/replace',
			auth: 'server',
			feature: 'returns',
			rateLimit: SERVER_LIMITS,
			handler: move('replace'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/returns/:id/repair',
			auth: 'server',
			feature: 'returns',
			rateLimit: SERVER_LIMITS,
			handler: move('repair'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/returns/:id/credit',
			auth: 'server',
			feature: 'returns',
			idempotent: true,
			rateLimit: SERVER_LIMITS,
			handler: credit,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/returns/:id/status',
			auth: 'server',
			feature: 'returns',
			rateLimit: SERVER_LIMITS,
			handler: restatus,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/returns/:id/notes',
			auth: 'server',
			feature: 'returns',
			rateLimit: SERVER_LIMITS,
			handler: addNote,
		}),

		// admin widget (ticket)
		defineRoute({
			method: 'GET',
			path: '/v1/admin/returns',
			auth: 'ticket',
			feature: 'returns',
			permission: 'returns.manage',
			rateLimit: SERVER_LIMITS,
			handler: listClaims,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/returns/count',
			auth: 'ticket',
			feature: 'returns',
			permission: 'returns.manage',
			rateLimit: SERVER_LIMITS,
			handler: claimCounts.count,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/returns/counts',
			auth: 'ticket',
			feature: 'returns',
			permission: 'returns.manage',
			rateLimit: SERVER_LIMITS,
			handler: claimCounts.counts,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/returns/lists',
			auth: 'ticket',
			feature: 'returns',
			permission: 'returns.manage',
			rateLimit: SERVER_LIMITS,
			handler: claimLists,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/returns/:id',
			auth: 'ticket',
			feature: 'returns',
			permission: 'returns.manage',
			rateLimit: SERVER_LIMITS,
			handler: readClaim,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/returns/:id/approve',
			auth: 'ticket',
			feature: 'returns',
			permission: 'returns.manage',
			rateLimit: SERVER_LIMITS,
			handler: move('approve'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/returns/:id/reject',
			auth: 'ticket',
			feature: 'returns',
			permission: 'returns.manage',
			rateLimit: SERVER_LIMITS,
			handler: move('reject'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/returns/:id/receive',
			auth: 'ticket',
			feature: 'returns',
			permission: 'returns.manage',
			rateLimit: SERVER_LIMITS,
			handler: move('receive'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/returns/:id/refund',
			auth: 'ticket',
			feature: 'returns',
			permission: 'returns.manage',
			idempotent: true,
			rateLimit: SERVER_LIMITS,
			handler: refund,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/returns/:id/restock',
			auth: 'ticket',
			feature: 'returns',
			permission: 'returns.manage',
			rateLimit: SERVER_LIMITS,
			handler: restock,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/returns/:id/close',
			auth: 'ticket',
			feature: 'returns',
			permission: 'returns.manage',
			rateLimit: SERVER_LIMITS,
			handler: move('close'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/returns/:id/replace',
			auth: 'ticket',
			feature: 'returns',
			permission: 'returns.manage',
			rateLimit: SERVER_LIMITS,
			handler: move('replace'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/returns/:id/repair',
			auth: 'ticket',
			feature: 'returns',
			permission: 'returns.manage',
			rateLimit: SERVER_LIMITS,
			handler: move('repair'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/returns/:id/credit',
			auth: 'ticket',
			feature: 'returns',
			permission: 'returns.manage',
			idempotent: true,
			rateLimit: SERVER_LIMITS,
			handler: credit,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/returns/:id/status',
			auth: 'ticket',
			feature: 'returns',
			permission: 'returns.manage',
			rateLimit: SERVER_LIMITS,
			handler: restatus,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/returns/:id/notes',
			auth: 'ticket',
			feature: 'returns',
			permission: 'returns.manage',
			rateLimit: SERVER_LIMITS,
			handler: addNote,
		}),
	];

	return { routes, exportUser, deleteUser };
};
