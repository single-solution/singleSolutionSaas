/**
 * Customers for the merchant (PLAN 0.8.8: Ecommerce keeps only shop records linked to the Accounts user id): the list
 * and search with what each customer paid, one customer with their latest orders, and the blocklist (a blocked
 * shopper cannot order; checkout reads `blocked`), the staff note and the return-to-origin count. The list has counts
 * (`count`, and `counts` by `blocked`; PLAN 0.8.10 K4) with the same filters.
 * @module
 */
import { countHandlers, paginate, problem } from '@ss/app-kit';
import { createFulfilmentStore, customerFilter } from '../adapters/fulfilment-store.js';
import { COLLECTIONS } from '../core/model.js';
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

	/**
	 * The list's search and blocked filter (an over-long search is refused, as the list refuses it).
	 * @param {any} ctx
	 */
	const queryOf = (ctx) => {
		const q = typeof ctx.query.q === 'string' ? ctx.query.q.trim() : '';
		if (q.length > MAX_SEARCH) throw service.invalid('q', `Search for at most ${MAX_SEARCH} characters.`);
		const blocked = ctx.query.blocked === 'true' ? true : ctx.query.blocked === 'false' ? false : null;
		return { q, blocked };
	};

	const counts = countHandlers({
		source: async (ctx) => {
			const query = queryOf(ctx);
			const s = await service.site(ctx);
			return { collection: (await s.data()).collection(COLLECTIONS.customers), filter: customerFilter(s.websiteId, query) };
		},
		by: { blocked: 'blocked' },
	});

	/** @param {any} ctx */
	const list = async (ctx) => {
		const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url }, { defaultLimit: 25 });
		const query = queryOf(ctx);
		const s = await service.site(ctx);
		const store = await storeOf(s);
		const rows = await store.customers.list({ ...query, after: page.after, limit: page.fetchLimit });
		const spent = await store.orders.spent(rows.map((row) => row.userId));
		const { money } = await s.format();
		return page.respond(
			rows.map((row) => customerView(row, spent.get(row.userId) ?? { total: 0, count: 0 }, s.currency, money)),
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
		const { money } = await s.format();
		return {
			...customerView(record ?? { userId, ...details }, spent, s.currency, money),
			recentOrders: recent.map((order) => orderSummary(order, flow, money)),
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
		const changes = [
			...(action === 'customer.blocked' ? ['blocked'] : action === 'customer.unblocked' ? ['unblocked'] : []),
			...(note === undefined ? [] : ['note changed']),
			...(resetRto ? ['returned parcels reset'] : []),
		];
		await service.log(ctx, action, userId, {
			label: (record?.name || details.name || userId).slice(0, 200),
			...(changes.length > 0 ? { detail: changes.join(', ') } : {}),
		});
		return view(s, userId);
	};

	return Object.freeze({ list, read, edit, count: counts.count, counts: counts.counts });
};
