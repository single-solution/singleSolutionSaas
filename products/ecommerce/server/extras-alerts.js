/**
 * Back-in-stock and price-drop alerts (feature `alerts`, PLAN 0.8.8: via Notifications). A signed-in shopper sets an
 * alert on a product (or one variant); the contact is the e-mail and phone of their sign-in, and a price-drop alert
 * stores the price at that moment, with an optional target price (E34). While the `guests` setting allows, a guest
 * sets one with a phone, read as checkout reads it (E21, K12), and the alert keeps the guest's customer id so it moves
 * to them at sign-in. When the catalog changes (`products.changed`: catalog writes, an import, a return's restock, and
 * stock an order gives back on a cancel, an ended window or a return to origin) the alerts that became due are marked
 * and sent at once, at most {@link SEND_BATCH} per change; the rest go out on later uses of the website
 * (`service.whenUsed`). Each alert is sent once (`ecommerce.back_in_stock` / `ecommerce.price_drop`) on each of the
 * `channels` it has an address for; when its message reached no one (Notifications could not be reached or refused
 * it) it waits again and is tried on a later use, 1, 5, 15 and 60 minutes after each try, then ends `failed` (E63).
 * Each message has `{stopUrl}`: the website's stop page (the `alerts` setting `stopUrl`, else
 * `/alerts/unsubscribe/<token>`) holding the `alerts_stop` widget, which calls `POST /v1/shop/alerts/unsubscribe/:token`
 * to remove every alert of that phone or e-mail (EN-1); only the token's hash is kept. The link is not named
 * `unsubscribeUrl`: Notifications reserves that name for its own opt-out link and refuses a send that passes it (MS-2).
 * @module
 */
import { createId } from '@ss/contracts';
import { normalisePhone } from '@ss/contracts/phone';
import { created, defineRoute, noContent, ok, problem } from '@ss/app-kit';
import { newOrderKey, orderKeyHash } from '../adapters/crypto.js';
import { isDuplicate, userIdsOf } from '../adapters/extras-store.js';
import { createOrdersStore } from '../adapters/orders-store.js';
import {
	MAX_ALERTS,
	SEND_BATCH,
	alertRetryAt,
	checkAlertInput,
	checkTargetPrice,
	dueConditions,
	isDue,
	priceOf,
	stopLink,
} from '../core/alerts.js';
import { COUNTRY_REFUSED, ORDER_KEY_LENGTH, phoneAllowed } from '../core/guests.js';
import { COLLECTIONS, ID_PREFIX } from '../core/model.js';
import { phoneRulesOf } from './guests.js';
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
			targetPrice: alert.targetPrice ?? null,
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
	 * Send the alerts that are due (oldest first, at most {@link SEND_BATCH}); an alert no longer due waits again, and
	 * one whose message reached no one is tried again later (`alertRetryAt`, five tries in all).
	 * @param {Site} s
	 */
	const sendDue = async (s) => {
		const data = await s.data();
		const due = /** @type {StoredAlert[]} */ (
			await alerts(data)
				.find(
					{ websiteId: data.websiteId, status: 'waiting', dueAt: { $ne: null, $lte: new Date(service.now()) } },
					{ ...NO_ID, sort: { dueAt: 1 }, limit: SEND_BATCH },
				)
				.toArray()
		);
		if (due.length === 0) return;
		const products = await productsById(
			s,
			due.map((alert) => alert.productId),
		);
		const { channels, stopUrl } = await s.values('alerts');
		const rules = await phoneRulesOf(s);
		for (const alert of due) {
			const item = products.get(alert.productId) ?? null;
			if (!item || !isDue(alert, item)) {
				await alerts(data).updateOne(
					{ websiteId: data.websiteId, id: alert.id, status: 'waiting' },
					{ $set: { dueAt: null } },
				);
				continue;
			}
			// each alert is sent once, even when two requests send at the same time; its unsubscribe token is kept as a hash
			const token = newOrderKey();
			const taken = await alerts(data).updateOne(
				{ websiteId: data.websiteId, id: alert.id, status: 'waiting', dueAt: alert.dueAt },
				{ $set: { status: 'sent', dueAt: null, tokenHash: orderKeyHash(token) } },
			);
			if (taken.modifiedCount !== 1) continue;
			const price = priceOf(item, alert.variantId) ?? item.price;
			const values = {
				name: item.name,
				price: (await s.format()).money(price, s.currency),
				url: (await cards.card(s, item)).url,
				stopUrl: stopLink(stopUrl, token, s.domain),
			};
			// one send per channel, so a channel that got through is never sent again when another is tried later (E63)
			/** @type {string[]} */
			const results = [];
			for (const channel of Array.isArray(channels) ? channels : ['email']) {
				const result = await service.notify(
					s,
					alert.kind === 'back_in_stock' ? 'ecommerce.back_in_stock' : 'ecommerce.price_drop',
					// never to a phone of a country the website does not serve (SE-5)
					{ email: alert.email, phone: alert.phone && phoneAllowed(alert.phone, rules) ? alert.phone : '' },
					values,
					[channel],
				);
				results.push(result);
				if (result === 'not_connected') break;
			}
			if (results.includes('sent')) continue;
			const tries = (alert.tries ?? 0) + 1;
			// nothing to send it to ends it at once; else it waits for a later try, until the last
			const next = results.every((result) => result === 'skipped') ? null : alertRetryAt(tries, service.now());
			const filter = { websiteId: data.websiteId, id: alert.id, status: 'sent' };
			try {
				await alerts(data).updateOne(
					filter,
					next
						? { $set: { status: 'waiting', dueAt: next, tries }, $unset: { tokenHash: '' } }
						: { $set: { status: 'failed', tries } },
				);
			} catch (error) {
				// the shopper set the same alert again meanwhile: that one waits instead
				if (!isDuplicate(error)) throw error;
				await alerts(data).updateOne(filter, { $set: { status: 'failed', tries } });
			}
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

	/**
	 * Who an alert is for: the signed-in shopper (the e-mail and phone of their sign-in), else a guest's normalised
	 * phone while the `guests` setting allows (E34); with their customer record's id when they have one (E21). A phone
	 * of a country the website does not serve (`checkout.countries`, SE-5) is refused for a guest and left out for a
	 * member.
	 * @param {Site} s @param {WebsiteData} data @param {Record<string, unknown>} body
	 * @returns {Promise<{ userId: string, email: string, phone: string, customerId: string | null }>}
	 */
	const contactOf = async (s, data, body) => {
		const store = createOrdersStore(data);
		const rules = await phoneRulesOf(s);
		const shopper = await service.shopper(s);
		if (shopper) {
			const phone = shopper.phone && phoneAllowed(shopper.phone, rules) ? shopper.phone : '';
			if (!shopper.email && !phone)
				throw service.invalid(
					'kind',
					'Add an e-mail or a phone of a country this shop serves to your account to get alerts.',
				);
			const customer = await store.customer(shopper.id);
			return { userId: shopper.id, email: shopper.email, phone, customerId: customer?.id ?? null };
		}
		if ((await s.values('alerts')).guests !== true) throw problem('sign_in_required', 'Sign in to continue.');
		const phone = normalisePhone(body.phone, rules);
		if (!phone) throw service.invalid('phone', 'Give your phone number with its country code.');
		if (!phoneAllowed(phone, rules)) throw service.invalid('phone', COUNTRY_REFUSED.message, COUNTRY_REFUSED.code);
		const customer = await store.guestCustomer(phone);
		return { userId: '', email: '', phone, customerId: customer?.id ?? null };
	};

	/** @param {any} ctx */
	const subscribe = async (ctx) => {
		const s = await service.site(ctx);
		const body = typeof ctx.body === 'object' && ctx.body !== null ? /** @type {Record<string, unknown>} */ (ctx.body) : {};
		const data = await s.data();
		const contact = await contactOf(s, data, body);
		const checked = checkAlertInput(body);
		if (!checked.ok) throw service.invalid(checked.field, checked.message);
		const { kind, productId, variantId } = checked.value;
		const [item] = await cards.activeProducts(s, [productId]);
		if (!item) throw problem('not_found', 'No such product.');
		const price = priceOf(item, variantId);
		if (price === null) throw service.invalid('variantId', 'No such variant.');
		if (kind === 'back_in_stock' && isDue({ kind, variantId, price: null }, item))
			throw service.invalid('kind', 'This product is in stock now.');
		const target = checkTargetPrice(body.targetPrice, kind, price);
		if (!target.ok) throw service.invalid('targetPrice', target.message);
		const record = {
			id: createId(ID_PREFIX.alert),
			kind,
			productId,
			variantId,
			...contact,
			price: kind === 'price_drop' ? price : null,
			targetPrice: target.targetPrice,
			status: /** @type {const} */ ('waiting'),
			dueAt: null,
		};
		// a member's alerts are theirs; a guest's are their phone's
		const owner = contact.userId ? { userId: contact.userId } : { userId: '', phone: contact.phone };
		const filter = { websiteId: data.websiteId, ...owner, kind, productId, variantId, status: 'waiting' };
		const existing = /** @type {StoredAlert | null} */ (await alerts(data).findOne(filter, NO_ID));
		if (existing) return ok(await view(s, existing, new Map([[item.id, item]])));
		if ((await alerts(data).countDocuments({ websiteId: data.websiteId, ...owner, status: 'waiting' })) >= MAX_ALERTS)
			throw service.invalid('productId', `You can keep at most ${MAX_ALERTS} alerts.`);
		try {
			await alerts(data).insertOne({ ...record });
		} catch (error) {
			if (!isDuplicate(error)) throw error;
		}
		const saved = /** @type {StoredAlert} */ (await alerts(data).findOne(filter, NO_ID));
		return created(await view(s, saved, new Map([[item.id, item]])));
	};

	/**
	 * POST /v1/shop/alerts/unsubscribe/:token (E34): every alert of the phone or e-mail the token's message went to is
	 * removed. A token no longer known removes nothing.
	 * @param {any} ctx
	 */
	const unsubscribe = async (ctx) => {
		const s = await service.site(ctx);
		const token = String(ctx.params.token);
		if (token.length !== ORDER_KEY_LENGTH) return { removed: 0 };
		const data = await s.data();
		const found = /** @type {StoredAlert | null} */ (
			await alerts(data).findOne({ websiteId: data.websiteId, tokenHash: orderKeyHash(token) }, NO_ID)
		);
		if (!found) return { removed: 0 };
		const or = [...(found.email ? [{ email: found.email }] : []), ...(found.phone ? [{ phone: found.phone }] : [])];
		const result = await alerts(data).deleteMany({
			websiteId: data.websiteId,
			...(or.length > 0 ? { $or: or } : { id: found.id }),
		});
		return { removed: result.deletedCount };
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
				targetPrice: alert.targetPrice ?? null,
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
			method: 'POST',
			path: '/v1/shop/alerts/unsubscribe/:token',
			auth: 'browser',
			feature: 'alerts',
			rateLimit: VISITOR_WRITE,
			handler: unsubscribe,
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
