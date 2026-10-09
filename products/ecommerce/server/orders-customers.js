/**
 * Customers for the merchant (PLAN 0.8.8: Ecommerce keeps only shop records linked to the Accounts user id): the list
 * and search with what each customer paid, one customer with their latest orders, and the blocklist (a blocked
 * shopper cannot order; checkout reads `blocked`), the staff note and the return-to-origin count.
 * @module
 */
import { paginate, problem } from '@ss/app-kit';
import { createFulfilmentStore } from '../adapters/fulfilment-store.js';
import { MAX_SEARCH, checkCustomerEdit, customerView, orderSummary } from '../core/orders.js';

/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */

/** A customer shows this many of their latest orders. */
const RECENT_ORDERS = 10;

const USER_ID = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * @param {Service} service
 */
export const createCustomers = (service) => {
	/** @param {Site} s */
	const storeOf = async (s) => createFulfilmentStore(await s.data());

	/** @param {any} ctx */
	const userIdOf = (ctx) => {
		const userId = String(ctx.params.userId ?? '');
		if (!USER_ID.test(userId)) throw problem('not_found', 'There is no such customer.');
		return userId;
	};

	/** @param {any} ctx */
	const list = async (ctx) => {
		const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url }, { defaultLimit: 25 });
		const s = await service.site(ctx);
		const q = typeof ctx.query.q === 'string' ? ctx.query.q.trim() : '';
		if (q.length > MAX_SEARCH) throw service.invalid('q', `Search for at most ${MAX_SEARCH} characters.`);
		const blocked = ctx.query.blocked === 'true' ? true : ctx.query.blocked === 'false' ? false : null;
		const store = await storeOf(s);
		const rows = await store.customers.list({ q, blocked, after: page.after, limit: page.fetchLimit });
		const spent = await store.orders.spent(rows.map((row) => row.userId));
		return page.respond(
			rows.map((row) => customerView(row, spent.get(row.userId) ?? { total: 0, count: 0 }, s.currency)),
			(view) => [view.name, view.userId],
		);
	};

	/**
	 * A customer record, else one made from their latest order, else 404.
	 * @param {Site} s @param {string} userId
	 */
	const find = async (s, userId) => {
		const store = await storeOf(s);
		const [record, recent] = await Promise.all([store.customers.get(userId), store.orders.ofCustomer(userId, RECENT_ORDERS)]);
		const latest = recent[0];
		if (!record && !latest) throw problem('not_found', 'There is no such customer.');
		const details = latest
			? { name: latest.customer.name, email: latest.customer.email, phone: latest.customer.phone }
			: { name: '', email: '', phone: '' };
		return { store, record, recent, details };
	};

	/**
	 * @param {Site} s @param {string} userId
	 */
	const view = async (s, userId) => {
		const { store, record, recent, details } = await find(s, userId);
		const spent = (await store.orders.spent([userId])).get(userId) ?? { total: 0, count: 0 };
		const flow = /** @type {import('../core/model.js').OrderFlow} */ (/** @type {unknown} */ (await s.list('order_flow')));
		return {
			...customerView(record ?? { userId, ...details }, spent, s.currency),
			recentOrders: recent.map((order) => orderSummary(order, flow)),
		};
	};

	/** @param {any} ctx */
	const read = async (ctx) => view(await service.site(ctx), userIdOf(ctx));

	/** @param {any} ctx */
	const edit = async (ctx) => {
		const userId = userIdOf(ctx);
		const checked = checkCustomerEdit(ctx.body);
		if (!checked.ok) throw service.invalid(checked.field, checked.message);
		const s = await service.site(ctx);
		const { store, record, details } = await find(s, userId);
		const { blocked, blockedReason, note, resetRto } = checked.value;
		await store.customers.update(
			userId,
			{
				...(blocked === undefined ? {} : { blocked, blockedReason }),
				...(note === undefined ? {} : { note }),
				...(resetRto ? { rtoCount: 0 } : {}),
			},
			record ? { name: record.name, email: record.email, phone: record.phone } : details,
		);
		const action =
			blocked === true && record?.blocked !== true
				? 'customer.blocked'
				: blocked === false && record?.blocked === true
					? 'customer.unblocked'
					: 'customer.edited';
		await service.log(ctx, action, userId);
		return view(s, userId);
	};

	return Object.freeze({ list, read, edit });
};
