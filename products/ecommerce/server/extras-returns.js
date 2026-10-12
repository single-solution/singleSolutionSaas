/**
 * Return and warranty claims (feature `returns`, PLAN 0.8.8): a signed-in shopper claims items of their own delivered
 * order within each item's window, with photos uploaded straight to the merchant's storage; the merchant's staff (or
 * server) approve or reject, mark the parcel received, refund (through Payments when the order was paid online, else
 * recorded), restock exactly once (the ledger's `restockClaim`) and close. Loyalty points earned on the returned part
 * are taken back on the first refund. The shopper gets a message (`ecommerce.return_status`) at each step. Each step's
 * history entry names who did it (a ticket's user, the staff member a server-token call names in its `SS-Actor-*`
 * headers, else `Server`), and its activity entry the claim (order number and reference) and the move.
 *
 * E33: exchange claims and fixed reasons as the `returns` settings say; `replaced` and `repaired` outcomes; staff choose
 * per line when receiving whether it goes back in stock (those lines are restocked at once, each exactly once); a
 * refund names its method and reference and is also written on the order's `refunds` (with the claim's id), the
 * delivery fee inside the cap when `refundDelivery` is on, and points taken back as `pointsBack` says; staff notes; a
 * new claim raises the `return.requested` hook.
 * @module
 */
import { createId } from '@ss/contracts';
import { countHandlers, created, defineRoute, paginate, problem } from '@ss/app-kit';
import { restockClaimLines, takePoints } from '../adapters/ledger.js';
import { userIdsOf } from '../adapters/extras-store.js';
import { afterFilter, keyOf, sortOf } from '../core/extras-pages.js';
import { COLLECTIONS, ID_PREFIX } from '../core/model.js';
import {
	CLAIM_ACTIONS,
	CLAIM_KINDS,
	CLAIM_STATUSES,
	PHOTO_SECONDS,
	actionsOf,
	allows,
	checkClaimInput,
	checkNote,
	checkPhotoInput,
	checkRefundMethod,
	checkRestockChoices,
	claimReference,
	claimedByLine,
	deliveryLeft,
	isPhotoKey,
	linesToRestock,
	paidOnline,
	photoFolder,
	planClaim,
	pointsToReverse,
	referenceOf,
	refundCap,
	refundedState,
	returnableLines,
} from '../core/returns.js';
import { createMedia } from './catalog-media.js';
import { SERVER_LIMITS, VISITOR_LIMITS, VISITOR_WRITE_LIMITS } from './service.js';

/** Rate limits (mutable copies of the shared constants, as route definitions take them). */
const SERVER = [...SERVER_LIMITS];
const VISITOR = [...VISITOR_LIMITS];
const VISITOR_WRITE = [...VISITOR_WRITE_LIMITS];

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */
/** @typedef {import('../core/model.js').ReturnRecord} ReturnRecord */
/** @typedef {import('../core/model.js').OrderRecord} OrderRecord */
/** @typedef {import('../core/model.js').OrderRefundEntry} OrderRefundEntry */
/** @typedef {import('../core/returns.js').ClaimAction} ClaimAction */
/** @typedef {ReturnRecord & { createdAt: Date, updatedAt: Date }} StoredClaim */

/** Newest claims first. @type {import('../core/extras-pages.js').SortField[]} */
const NEWEST = [
	{ field: 'createdAt', direction: -1, date: true },
	{ field: 'id', direction: -1 },
];
const NO_ID = { projection: { _id: 0 } };

/** Why a line cannot be claimed, for the shopper. */
const NOT_RETURNABLE = Object.freeze({
	unknown: 'This item is not part of the order or cannot be returned.',
	window_closed: 'The time to claim this item has passed.',
	quantity: 'More units than can still be claimed.',
});

/** @param {any} ctx */
const bodyOf = (ctx) => (typeof ctx.body === 'object' && ctx.body !== null ? ctx.body : {});

/** @param {Date | null | undefined} at */
const iso = (at) => (at ? new Date(at).toISOString() : null);

/** A claim as the activity log names it: its order number and reference. @param {ReturnRecord} claim */
const claimLabel = (claim) => `${claim.orderNumber} ${referenceOf(claim)}`;

/**
 * @param {Product} product
 * @param {Service} service
 */
export const createReturns = (product, service) => {
	const media = createMedia(product);

	/** @param {WebsiteData} data */
	const claims = (data) => data.collection(COLLECTIONS.returns);

	/**
	 * @param {Site} s
	 * @returns {Promise<NonNullable<Awaited<ReturnType<Product['connections']['storage']>>>>}
	 */
	const storageOf = async (s) => {
		const storage = await product.connections.storage(s.websiteId);
		if (!storage) throw problem('storage_not_connected', 'Storage not connected: connect it in the product dashboard.');
		return storage;
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
		const products = /** @type {Array<{ id: string, returnDays: number | null, warrantyDays: number | null }>} */ (
			await data
				.collection(COLLECTIONS.products)
				.find(
					{ websiteId: data.websiteId, id: { $in: ids } },
					{ projection: { _id: 0, id: 1, returnDays: 1, warrantyDays: 1 } },
				)
				.toArray()
		);
		const grades = order.lines.some((line) => line.grade) ? await s.list('grades') : [];
		const settings = await s.values('returns');
		return returnableLines({
			order,
			claims: existing,
			products: new Map(
				products.map((p) => [p.id, { returnDays: p.returnDays ?? null, warrantyDays: p.warrantyDays ?? null }]),
			),
			grades: Array.isArray(grades) ? grades : [],
			defaults: { returnDays: Number(settings.returnDays ?? 0), warrantyDays: Number(settings.warrantyDays ?? 0) },
			now: service.now(),
		});
	};

	/**
	 * Tell the shopper where their claim is (on the `checkout` setting `messageChannels`).
	 * @param {Site} s
	 * @param {OrderRecord | null} order
	 * @param {ReturnRecord} claim
	 */
	const tell = async (s, order, claim) => {
		if (!order) return;
		const { messageChannels } = await s.values('checkout');
		await service.notify(
			s,
			'ecommerce.return_status',
			{ email: order.customer.email, phone: order.customer.phone },
			{
				number: order.number,
				claim: referenceOf(claim),
				kind: claim.kind,
				status: claim.status,
				amount: claim.refundAmount > 0 ? (await s.format()).money(claim.refundAmount, order.totals.currency) : '',
				name: order.customer.name,
			},
			Array.isArray(messageChannels) ? messageChannels : ['email'],
		);
	};

	/** @param {StoredClaim} claim */
	const shopperView = (claim) => ({
		id: claim.id,
		reference: referenceOf(claim),
		orderId: claim.orderId,
		orderNumber: claim.orderNumber,
		kind: claim.kind,
		lines: claim.lines.map((line) => ({ lineId: line.lineId, quantity: line.quantity })),
		reason: claim.reason,
		status: claim.status,
		refundAmount: claim.refundAmount,
		history: claim.history.map((entry) => ({ at: iso(entry.at), status: entry.status, note: entry.note })),
		createdAt: iso(claim.createdAt),
	});

	/** @param {StoredClaim} claim */
	const staffView = (claim) => ({
		id: claim.id,
		reference: referenceOf(claim),
		orderId: claim.orderId,
		orderNumber: claim.orderNumber,
		userId: claim.userId,
		kind: claim.kind,
		lines: claim.lines.map((line) => ({ ...line, restockedAt: iso(line.restockedAt) })),
		reason: claim.reason,
		photos: claim.photos.map((photo) => ({ key: photo.key, type: photo.type, size: photo.size })),
		status: claim.status,
		refundAmount: claim.refundAmount,
		refundId: claim.refundId,
		refundMethod: claim.refundMethod ?? null,
		refundReference: claim.refundReference ?? '',
		restockedAt: iso(claim.restockedAt),
		history: claim.history.map((entry) => ({ ...entry, at: iso(entry.at) })),
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
		return {
			orderId: order.id,
			number: order.number,
			deliveredAt: iso(order.deliveredAt),
			lines: await Promise.all(
				lines.map(async (entry) => ({
					lineId: entry.line.id,
					productId: entry.line.productId,
					name: entry.line.name,
					variantName: entry.line.variantName,
					image: await media.mediaUrl(s, entry.line.image),
					quantity: entry.line.quantity,
					claimable: entry.claimable,
					return: { days: entry.return.days, until: iso(entry.return.until), open: entry.return.open },
					warranty: { days: entry.warranty.days, until: iso(entry.warranty.until), open: entry.warranty.open },
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
		const storage = await storageOf(s);
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
		const checked = checkClaimInput(bodyOf(ctx), {
			maxPhotos: Number(settings.maxPhotos),
			kinds: Array.isArray(settings.kinds) ? settings.kinds : undefined,
			reasons: Array.isArray(settings.reasons) ? settings.reasons : [],
		});
		if (!checked.ok) throw service.invalid(checked.field, checked.message);
		const input = checked.value;
		const data = await s.data();
		const order = await findOrder(data, { id: input.orderId, 'customer.userId': shopper.id });
		if (!order) throw problem('not_found', 'No such order.');
		if (!order.deliveredAt) throw problem('not_returnable', 'Items can be claimed once the order is delivered.');
		const planned = planClaim(input.kind, input.lines, await returnableOf(s, data, order));
		if (!planned.ok)
			throw problem('not_returnable', NOT_RETURNABLE[planned.reason], {
				errors: [{ path: '/lines', message: NOT_RETURNABLE[planned.reason], code: planned.reason }],
			});
		/** @type {ReturnRecord['photos']} */
		const photos = [];
		if (input.photos.length > 0) {
			const storage = await storageOf(s);
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
			kind: input.kind,
			lines: planned.lines,
			reason: input.reason,
			photos,
			status: 'requested',
			refundAmount: 0,
			refundId: null,
			restockedAt: null,
			history: [{ at, status: 'requested', by: 'shopper', note: '' }],
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
		return created(shopperView(mine));
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
		return page.respond(rows.map(shopperView), (view) => [/** @type {string} */ (view.createdAt), view.id]);
	};

	// --------------------------------------------------------------------------------------------------- staff

	/**
	 * The staff claim list's collection and filter (`status`, `kind`, `orderId`, `userId`), shared by the list and its
	 * counts (PLAN 0.8.10 K4).
	 * @param {any} ctx
	 */
	const claimSource = async (ctx) => {
		const data = await (await service.site(ctx)).data();
		const { status, kind, orderId, userId } = ctx.query;
		return {
			collection: claims(data),
			filter: {
				websiteId: data.websiteId,
				...(CLAIM_STATUSES.includes(status) ? { status } : {}),
				...(CLAIM_KINDS.includes(kind) ? { kind } : {}),
				...(typeof orderId === 'string' && orderId ? { orderId } : {}),
				...(typeof userId === 'string' && userId ? { userId } : {}),
			},
		};
	};
	const claimCounts = countHandlers({ source: claimSource, by: { status: 'status' } });

	/** @param {any} ctx */
	const listClaims = async (ctx) => {
		const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url }, { defaultLimit: 25 });
		const { collection, filter } = await claimSource(ctx);
		const rows = /** @type {StoredClaim[]} */ (
			await collection
				.find({ ...filter, ...afterFilter(NEWEST, page.after) }, { ...NO_ID, sort: sortOf(NEWEST), limit: page.fetchLimit })
				.toArray()
		);
		return page.respond(rows.map(staffView), (view) => keyOf(NEWEST, view));
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
			...staffView(claim),
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
			refundsOnline: order ? paidOnline(order) : false,
		};
	};

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
				};
			});
		const productIds = [...new Set(lines.filter((line) => line.quantity > 0).map((line) => line.productId))];
		const before = /** @type {Array<{ id: string, price: number, inStock: boolean }>} */ (
			await data
				.collection(COLLECTIONS.products)
				.find({ websiteId: data.websiteId, id: { $in: productIds } }, { projection: { _id: 0, id: 1, price: 1, inStock: 1 } })
				.toArray()
		);
		const done = await restockClaimLines(data, { claimId: claim.id, lines, now: service.now() });
		if (done.length === 0) return 0;
		await claims(data).updateOne(
			{ websiteId: data.websiteId, id: claim.id },
			{
				$push: {
					history: { at: new Date(service.now()), status: claim.status, by: service.actor(ctx).name, note: 'restocked' },
				},
			},
		);
		const units = lines.filter((line) => done.includes(line.lineId)).reduce((sum, line) => sum + line.quantity, 0);
		await service.log(ctx, 'return.restocked', claim.id, {
			label: claimLabel(claim),
			detail: `${units} unit(s) back in stock`,
		});
		await service.emit('products.changed', s, {
			productIds,
			before: new Map(before.map((p) => [p.id, { price: p.price, inStock: p.inStock }])),
		});
		return done.length;
	};

	/**
	 * Approve, reject, mark received (with the staff's restock choice per line, E33), replace, repair or close: a status
	 * move with a history entry and a message to the shopper.
	 * @param {'approve' | 'reject' | 'receive' | 'replace' | 'repair' | 'close'} action
	 */
	const move = (action) => async (/** @type {any} */ ctx) => {
		const s = await service.site(ctx);
		const data = await s.data();
		const claim = await claimOf(data, ctx.params.id);
		const body = bodyOf(ctx);
		const note = checkNote(body.note, action === 'reject');
		if (!note.ok) throw service.invalid('note', note.message);
		const status = /** @type {ReturnRecord['status']} */ (CLAIM_ACTIONS[action].to);
		if (!allows(action, claim))
			throw problem('move_not_allowed', `A ${claim.status} ${claim.kind} claim cannot be moved to ${status}.`);
		const restock = action === 'receive' ? checkRestockChoices(body.lines, claim) : null;
		if (restock && !restock.ok) throw service.invalid(restock.field, restock.message);
		const choices = restock?.ok ? restock.choices : new Map();
		const entry = { at: new Date(service.now()), status, by: service.actor(ctx).name, note: note.note };
		const moved = /** @type {StoredClaim | null} */ (
			await claims(data).findOneAndUpdate(
				{ websiteId: data.websiteId, id: claim.id, status: claim.status },
				{
					$set: {
						status,
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
		await service.log(ctx, `return.${status}`, claim.id, {
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
	 * Refund a claim (a top-up refunds more): through Payments when the method is `online`, else recorded with its
	 * method and reference (E33). The refund is also an entry of the order's `refunds` with the claim's id; the units
	 * count as returned on the first refund; loyalty points go back as the `pointsBack` setting says.
	 * @param {any} ctx
	 */
	const refund = async (ctx) => {
		const s = await service.site(ctx);
		const data = await s.data();
		const claim = await claimOf(data, ctx.params.id);
		const body = bodyOf(ctx);
		const note = checkNote(body.note);
		if (!note.ok) throw service.invalid('note', note.message);
		if (!allows('refund', claim)) throw problem('move_not_allowed', `A ${claim.status} claim cannot be refunded.`);
		const order = await findOrder(data, { id: claim.orderId });
		if (!order) throw problem('not_found', 'The order of this claim is gone.');
		const how = checkRefundMethod(body, paidOnline(order));
		if (!how.ok) throw service.invalid(how.field, how.message);
		const cap = await capOf(s, data, order, claim);
		const amount = body.amount;
		if (!Number.isSafeInteger(amount) || amount < 1 || amount > cap)
			throw service.invalid('amount', `The refund is a whole amount in minor units from 1 to ${cap}.`);
		const first = claim.refundAmount === 0;
		const total = claim.refundAmount + amount;
		const money = (await s.format()).money(amount, order.totals.currency);
		const actor = service.actor(ctx);
		const at = new Date(service.now());
		const entry = { at, status: 'refunded', by: actor.name, note: note.note || money };
		// reserve the refund on the claim first, so two refunds at once cannot both pass the cap
		const reserved = await claims(data).updateOne(
			{ websiteId: data.websiteId, id: claim.id, status: claim.status, refundAmount: claim.refundAmount },
			{
				$set: { status: 'refunded', refundAmount: total, refundMethod: how.method, refundReference: how.reference },
				$push: { history: entry },
			},
		);
		if (reserved.modifiedCount !== 1) throw problem('move_not_allowed', 'The claim changed meanwhile; reload it.');
		/** @type {string | null} */
		let refundId = claim.refundId;
		/** @type {string | null} */
		let paymentsRefundId = null;
		if (how.method === 'online')
			try {
				const done = await service.payments.refund(s, /** @type {string} */ (order.payment.paymentId), {
					amount,
					reason: `${order.number} ${referenceOf(claim)}`,
					idempotencyKey: `${claim.id}-${claim.refundAmount}`,
					by: actor,
				});
				refundId = done.refundId || null;
				paymentsRefundId = refundId;
			} catch (error) {
				await claims(data).updateOne(
					{ websiteId: data.websiteId, id: claim.id, refundAmount: total },
					{
						$set: {
							status: claim.status,
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
		await claims(data).updateOne({ websiteId: data.websiteId, id: claim.id }, { $set: { refundId } });
		/** @type {OrderRefundEntry} */
		const refundEntry = {
			id: createId(ID_PREFIX.orderRefund),
			method: how.method,
			amount,
			reference: how.reference,
			claimId: claim.id,
			note: note.note,
			by: { kind: actor.kind, id: actor.id, name: actor.name, ...(actor.role ? { role: actor.role } : {}) },
			at,
			refundId: paymentsRefundId,
		};
		// the order: money given back (also as an entry of its refunds) and, on the first refund, the units returned
		const lines = first ? claim.lines : [];
		const after = /** @type {OrderRecord} */ (
			await data.collection(COLLECTIONS.orders).findOneAndUpdate(
				{ websiteId: data.websiteId, id: order.id },
				{
					$inc: {
						'payment.refunded': amount,
						...Object.fromEntries(lines.map((line, index) => [`lines.$[l${index}].returnedQuantity`, line.quantity])),
					},
					$push: { refunds: refundEntry },
				},
				{
					returnDocument: 'after',
					...NO_ID,
					...(lines.length > 0 ? { arrayFilters: lines.map((line, index) => ({ [`l${index}.id`]: line.lineId })) } : {}),
				},
			)
		);
		const state = refundedState(after, after.payment.refunded);
		await data
			.collection(COLLECTIONS.orders)
			.updateOne({ websiteId: data.websiteId, id: order.id }, { $set: { 'payment.state': state } });
		if (s.has('loyalty')) {
			const { pointsBack } = await s.values('returns');
			// proportional: the claimed part's points on the claim's first refund; full_refund_only: every point the order
			// earned, once, when this refund completes the order's refund
			const points =
				pointsBack === 'full_refund_only'
					? state === 'refunded' && refundedState(order, order.payment.refunded) !== 'refunded'
						? order.promotions.pointsEarned
						: 0
					: first
						? pointsToReverse(order, claim)
						: 0;
			if (points > 0)
				await takePoints(
					data,
					{ userId: order.customer.userId, points, orderId: order.id, kind: 'reverse', note: order.number },
					{ now: service.now() },
				);
		}
		await service.log(ctx, 'return.refunded', claim.id, { label: claimLabel(claim), detail: `Refunded ${money}` });
		const done = await claimOf(data, claim.id);
		if (done.status !== claim.status)
			await service.emit('return.status_changed', s, { claim: done, from: claim.status, to: done.status });
		await tell(s, order, done);
		return detailOf(s, done);
	};

	/**
	 * Put back in stock every claimed line not restocked yet and not kept out when received.
	 * @param {any} ctx
	 */
	const restock = async (ctx) => {
		const s = await service.site(ctx);
		const data = await s.data();
		const claim = await claimOf(data, ctx.params.id);
		if (!allows('restock', claim)) throw problem('move_not_allowed', `A ${claim.status} claim cannot be restocked.`);
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
		return { returnClaims: rows.map(shopperView) };
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
			rateLimit: VISITOR,
			handler: returnable,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/shop/returns/photos',
			auth: 'browser',
			feature: 'returns',
			rateLimit: VISITOR_WRITE,
			handler: uploadPhoto,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/shop/returns',
			auth: 'browser',
			feature: 'returns',
			idempotent: true,
			rateLimit: VISITOR_WRITE,
			handler: createClaim,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/shop/returns',
			auth: 'browser',
			feature: 'returns',
			rateLimit: VISITOR,
			handler: myClaims,
		}),

		// merchant's server
		defineRoute({
			method: 'GET',
			path: '/v1/returns',
			auth: 'server',
			feature: 'returns',
			rateLimit: SERVER,
			handler: listClaims,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/returns/count',
			auth: 'server',
			feature: 'returns',
			rateLimit: SERVER,
			handler: claimCounts.count,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/returns/counts',
			auth: 'server',
			feature: 'returns',
			rateLimit: SERVER,
			handler: claimCounts.counts,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/returns/:id',
			auth: 'server',
			feature: 'returns',
			rateLimit: SERVER,
			handler: readClaim,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/returns/:id/approve',
			auth: 'server',
			feature: 'returns',
			rateLimit: SERVER,
			handler: move('approve'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/returns/:id/reject',
			auth: 'server',
			feature: 'returns',
			rateLimit: SERVER,
			handler: move('reject'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/returns/:id/receive',
			auth: 'server',
			feature: 'returns',
			rateLimit: SERVER,
			handler: move('receive'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/returns/:id/refund',
			auth: 'server',
			feature: 'returns',
			idempotent: true,
			rateLimit: SERVER,
			handler: refund,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/returns/:id/restock',
			auth: 'server',
			feature: 'returns',
			rateLimit: SERVER,
			handler: restock,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/returns/:id/close',
			auth: 'server',
			feature: 'returns',
			rateLimit: SERVER,
			handler: move('close'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/returns/:id/replace',
			auth: 'server',
			feature: 'returns',
			rateLimit: SERVER,
			handler: move('replace'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/returns/:id/repair',
			auth: 'server',
			feature: 'returns',
			rateLimit: SERVER,
			handler: move('repair'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/returns/:id/notes',
			auth: 'server',
			feature: 'returns',
			rateLimit: SERVER,
			handler: addNote,
		}),

		// admin widget (ticket)
		defineRoute({
			method: 'GET',
			path: '/v1/admin/returns',
			auth: 'ticket',
			feature: 'returns',
			permission: 'returns.manage',
			rateLimit: SERVER,
			handler: listClaims,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/returns/count',
			auth: 'ticket',
			feature: 'returns',
			permission: 'returns.manage',
			rateLimit: SERVER,
			handler: claimCounts.count,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/returns/counts',
			auth: 'ticket',
			feature: 'returns',
			permission: 'returns.manage',
			rateLimit: SERVER,
			handler: claimCounts.counts,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/returns/:id',
			auth: 'ticket',
			feature: 'returns',
			permission: 'returns.manage',
			rateLimit: SERVER,
			handler: readClaim,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/returns/:id/approve',
			auth: 'ticket',
			feature: 'returns',
			permission: 'returns.manage',
			rateLimit: SERVER,
			handler: move('approve'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/returns/:id/reject',
			auth: 'ticket',
			feature: 'returns',
			permission: 'returns.manage',
			rateLimit: SERVER,
			handler: move('reject'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/returns/:id/receive',
			auth: 'ticket',
			feature: 'returns',
			permission: 'returns.manage',
			rateLimit: SERVER,
			handler: move('receive'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/returns/:id/refund',
			auth: 'ticket',
			feature: 'returns',
			permission: 'returns.manage',
			idempotent: true,
			rateLimit: SERVER,
			handler: refund,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/returns/:id/restock',
			auth: 'ticket',
			feature: 'returns',
			permission: 'returns.manage',
			rateLimit: SERVER,
			handler: restock,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/returns/:id/close',
			auth: 'ticket',
			feature: 'returns',
			permission: 'returns.manage',
			rateLimit: SERVER,
			handler: move('close'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/returns/:id/replace',
			auth: 'ticket',
			feature: 'returns',
			permission: 'returns.manage',
			rateLimit: SERVER,
			handler: move('replace'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/returns/:id/repair',
			auth: 'ticket',
			feature: 'returns',
			permission: 'returns.manage',
			rateLimit: SERVER,
			handler: move('repair'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/returns/:id/notes',
			auth: 'ticket',
			feature: 'returns',
			permission: 'returns.manage',
			rateLimit: SERVER,
			handler: addNote,
		}),
	];

	return { routes, exportUser, deleteUser };
};
