/**
 * Back-in-stock and price-drop alerts (feature `alerts`, PLAN 0.8.8: via Notifications). A signed-in shopper sets an
 * alert on a product (or one variant); the contact is the e-mail and phone of their sign-in, and a price-drop alert
 * stores the price at that moment. When the catalog changes (`products.changed`) the alerts that became due are marked
 * and sent at once, at most {@link SEND_BATCH} per change; the rest go out on later uses of the website
 * (`service.whenUsed`). Each alert is sent once (`ecommerce.back_in_stock` / `ecommerce.price_drop`).
 * @module
 */
import { createId } from '@ss/contracts';
import { created, defineRoute, noContent, ok, problem } from '@ss/app-kit';
import { isDuplicate, userIdsOf } from '../adapters/extras-store.js';
import { MAX_ALERTS, SEND_BATCH, checkAlertInput, dueConditions, isDue, priceOf } from '../core/alerts.js';
import { COLLECTIONS, ID_PREFIX } from '../core/model.js';
import { VISITOR_LIMITS, VISITOR_WRITE_LIMITS } from './service.js';

/** Rate limits (mutable copies of the shared constants, as route definitions take them). */
const VISITOR = [...VISITOR_LIMITS];
const VISITOR_WRITE = [...VISITOR_WRITE_LIMITS];

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./extras-cards.js').Cards} Cards */
/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */
/** @typedef {import('../core/model.js').ProductRecord} ProductRecord */
/**
 * An alert as stored: `dueAt` is set when a catalog change made it due (it is then sent on this or a later use).
 * @typedef {import('../core/model.js').AlertRecord & { dueAt: Date | null, createdAt: Date }} StoredAlert
 */

const NO_ID = { projection: { _id: 0 } };
/** Alerts listed to a shopper, at most (newest first). */
const LISTED = 100;

/**
 * @param {Product} _product
 * @param {Service} service
 * @param {Cards} cards
 */
export const createAlerts = (_product, service, cards) => {
	/** @param {WebsiteData} data */
	const alerts = (data) => data.collection(COLLECTIONS.alerts);

	/**
	 * @param {Site} s
	 * @param {StoredAlert} alert
	 * @param {Map<string, ProductRecord>} products
	 */
	const view = async (s, alert, products) => {
		const item = products.get(alert.productId);
		return {
			id: alert.id,
			kind: alert.kind,
			productId: alert.productId,
			variantId: alert.variantId,
			price: alert.price,
			status: alert.status,
			createdAt: new Date(alert.createdAt).toISOString(),
			product: item ? await cards.card(s, item) : null,
		};
	};

	/**
	 * @param {Site} s
	 * @param {string[]} ids
	 */
	const productsById = async (s, ids) =>
		new Map((await cards.activeProducts(s, [...new Set(ids)])).map((item) => [item.id, item]));

	/**
	 * Send the alerts that are due (oldest first, at most {@link SEND_BATCH}); an alert no longer due waits again.
	 * @param {Site} s
	 */
	const sendDue = async (s) => {
		const data = await s.data();
		const due = /** @type {StoredAlert[]} */ (
			await alerts(data)
				.find(
					{ websiteId: data.websiteId, status: 'waiting', dueAt: { $ne: null } },
					{ ...NO_ID, sort: { dueAt: 1 }, limit: SEND_BATCH },
				)
				.toArray()
		);
		if (due.length === 0) return;
		const products = await productsById(
			s,
			due.map((alert) => alert.productId),
		);
		const { channels } = await s.values('alerts');
		for (const alert of due) {
			const item = products.get(alert.productId) ?? null;
			if (!item || !isDue(alert, item)) {
				await alerts(data).updateOne(
					{ websiteId: data.websiteId, id: alert.id, status: 'waiting' },
					{ $set: { dueAt: null } },
				);
				continue;
			}
			// each alert is sent once, even when two requests send at the same time
			const taken = await alerts(data).updateOne(
				{ websiteId: data.websiteId, id: alert.id, status: 'waiting', dueAt: { $ne: null } },
				{ $set: { status: 'sent', dueAt: null } },
			);
			if (taken.modifiedCount !== 1) continue;
			const price = priceOf(item, alert.variantId) ?? item.price;
			const result = await service.notify(
				s,
				alert.kind === 'back_in_stock' ? 'ecommerce.back_in_stock' : 'ecommerce.price_drop',
				{ email: alert.email, phone: alert.phone },
				{ name: item.name, price: (await s.format()).money(price, s.currency), url: (await cards.card(s, item)).url },
				Array.isArray(channels) ? channels : ['email'],
			);
			if (result !== 'sent')
				await alerts(data).updateOne({ websiteId: data.websiteId, id: alert.id }, { $set: { status: 'failed' } });
		}
	};

	/**
	 * After a catalog change: mark the waiting alerts of the changed products that are due now, then send.
	 * @param {Site} s
	 * @param {{ productIds?: unknown }} payload
	 */
	const onProductsChanged = async (s, payload) => {
		if (!s.has('alerts')) return;
		const ids = Array.isArray(payload?.productIds) ? payload.productIds.filter((id) => typeof id === 'string') : [];
		if (ids.length === 0) return;
		const data = await s.data();
		const products = /** @type {ProductRecord[]} */ (
			await data
				.collection(COLLECTIONS.products)
				.find({ websiteId: data.websiteId, id: { $in: ids } }, NO_ID)
				.toArray()
		);
		let marked = 0;
		for (const item of products) {
			const conditions = dueConditions(item);
			if (conditions.length === 0) continue;
			const result = await alerts(data).updateMany(
				{ websiteId: data.websiteId, productId: item.id, status: 'waiting', dueAt: null, $or: conditions },
				{ $set: { dueAt: new Date(service.now()) } },
			);
			marked += result.modifiedCount;
		}
		if (marked > 0) await sendDue(s);
	};

	service.on('products.changed', onProductsChanged);
	service.whenUsed(async (s) => {
		if (s.has('alerts')) await sendDue(s);
	});

	/** @param {any} ctx */
	const subscribe = async (ctx) => {
		const s = await service.site(ctx);
		const shopper = await service.requireShopper(s);
		const checked = checkAlertInput(ctx.body);
		if (!checked.ok) throw service.invalid(checked.field, checked.message);
		const { kind, productId, variantId } = checked.value;
		if (!shopper.email && !shopper.phone)
			throw service.invalid('kind', 'Add an e-mail or phone to your account to get alerts.');
		const data = await s.data();
		const [item] = await cards.activeProducts(s, [productId]);
		if (!item) throw problem('not_found', 'No such product.');
		const price = priceOf(item, variantId);
		if (price === null) throw service.invalid('variantId', 'No such variant.');
		if (kind === 'back_in_stock' && isDue({ kind, variantId, price: null }, item))
			throw service.invalid('kind', 'This product is in stock now.');
		const record = {
			id: createId(ID_PREFIX.alert),
			kind,
			productId,
			variantId,
			userId: shopper.id,
			email: shopper.email,
			phone: shopper.phone,
			price: kind === 'price_drop' ? price : null,
			status: /** @type {const} */ ('waiting'),
			dueAt: null,
		};
		const filter = { websiteId: data.websiteId, userId: shopper.id, kind, productId, variantId, status: 'waiting' };
		const existing = /** @type {StoredAlert | null} */ (await alerts(data).findOne(filter, NO_ID));
		if (existing) return ok(await view(s, existing, new Map([[item.id, item]])));
		if ((await alerts(data).countDocuments({ websiteId: data.websiteId, userId: shopper.id, status: 'waiting' })) >= MAX_ALERTS)
			throw service.invalid('productId', `You can keep at most ${MAX_ALERTS} alerts.`);
		try {
			await alerts(data).insertOne({ ...record });
		} catch (error) {
			if (!isDuplicate(error)) throw error;
		}
		const saved = /** @type {StoredAlert} */ (await alerts(data).findOne(filter, NO_ID));
		return created(await view(s, saved, new Map([[item.id, item]])));
	};

	/** @param {any} ctx */
	const mine = async (ctx) => {
		const s = await service.site(ctx);
		const shopper = await service.requireShopper(s);
		const data = await s.data();
		const rows = /** @type {StoredAlert[]} */ (
			await alerts(data)
				.find({ websiteId: data.websiteId, userId: shopper.id }, { ...NO_ID, sort: { createdAt: -1, id: -1 }, limit: LISTED })
				.toArray()
		);
		const products = await productsById(
			s,
			rows.map((alert) => alert.productId),
		);
		return { items: await Promise.all(rows.map((alert) => view(s, alert, products))) };
	};

	/** @param {any} ctx */
	const remove = async (ctx) => {
		const s = await service.site(ctx);
		const shopper = await service.requireShopper(s);
		const data = await s.data();
		const result = await alerts(data).deleteOne({ websiteId: data.websiteId, id: String(ctx.params.id), userId: shopper.id });
		if (result.deletedCount !== 1) throw problem('not_found', 'No such alert.');
		return noContent();
	};

	/**
	 * A person's alerts: by their Accounts user, e-mail or phone.
	 * @param {Site} s
	 * @param {{ id?: string, email?: string, phone?: string }} person
	 */
	const personFilter = async (s, person) => {
		const data = await s.data();
		const users = await userIdsOf(data, person);
		const or = [
			...(users.length > 0 ? [{ userId: { $in: users } }] : []),
			...(person.email ? [{ email: person.email }] : []),
			...(person.phone ? [{ phone: person.phone }] : []),
		];
		return { data, filter: or.length > 0 ? { websiteId: data.websiteId, $or: or } : null };
	};

	/**
	 * @param {Site} s
	 * @param {{ id?: string, email?: string, phone?: string }} person
	 */
	const exportUser = async (s, person) => {
		const { data, filter } = await personFilter(s, person);
		const rows = /** @type {StoredAlert[]} */ (filter ? await alerts(data).find(filter, NO_ID).toArray() : []);
		return {
			alerts: rows.map((alert) => ({
				id: alert.id,
				kind: alert.kind,
				productId: alert.productId,
				variantId: alert.variantId,
				email: alert.email,
				phone: alert.phone,
				price: alert.price,
				status: alert.status,
				createdAt: new Date(alert.createdAt).toISOString(),
			})),
		};
	};

	/**
	 * @param {Site} s
	 * @param {{ id?: string, email?: string, phone?: string }} person
	 */
	const deleteUser = async (s, person) => {
		const { data, filter } = await personFilter(s, person);
		if (!filter) return { deleted: 0, anonymised: 0 };
		const result = await alerts(data).deleteMany(filter);
		return { deleted: result.deletedCount, anonymised: 0 };
	};

	const routes = [
		defineRoute({
			method: 'POST',
			path: '/v1/shop/alerts',
			auth: 'browser',
			feature: 'alerts',
			idempotent: true,
			rateLimit: VISITOR_WRITE,
			handler: subscribe,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/shop/alerts',
			auth: 'browser',
			feature: 'alerts',
			rateLimit: VISITOR,
			handler: mine,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/shop/alerts/:id',
			auth: 'browser',
			feature: 'alerts',
			rateLimit: VISITOR_WRITE,
			handler: remove,
		}),
	];

	return { routes, exportUser, deleteUser, sendDue, onProductsChanged };
};
