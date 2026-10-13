/**
 * Customers for the merchant (PLAN 0.8.8: Ecommerce keeps only shop records linked to the Accounts user id; E21:
 * guests too): the list and search with what each customer paid, one customer with their latest orders, and the
 * blocklist (a blocked shopper cannot order; checkout reads `blocked`), the staff note and the return-to-origin count.
 * One customer is named by their customer id (`cus_…`, members and guests alike) or a member's Accounts user id (K-6);
 * a guest's orders and spend are theirs by customer id. The list has counts (`count`, and `counts` by `blocked`; PLAN
 * 0.8.10 K4) with the same filters.
 * @module
 */
import { countHandlers, paginate, problem } from '@ss/app-kit';
import { createFulfilmentStore, customerFilter, markSeenBy } from '../adapters/fulfilment-store.js';
import { createOrdersStore } from '../adapters/orders-store.js';
import { COLLECTIONS } from '../core/model.js';
import {
	MAX_SEARCH,
	checkCustomerEdit,
	customerOwner,
	customerView,
	isCustomerId,
	orderSummary,
	spentKey,
} from '../core/orders.js';

/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */

/** A customer shows this many of their latest orders. */
const RECENT_ORDERS = 10;

/** A customer id (`cus_…`) or an Accounts user id. */
const CUSTOMER_REF = /^[A-Za-z0-9_-]{1,100}$/;
/** Customer list segments (E31). */
const SEGMENTS = Object.freeze(['loyalty', 'active', 'guest']);
/** Most Accounts users one `userIds` filter names. */
const MAX_USER_IDS = 100;

/**
 * @param {Service} service
 */
export const createCustomers = (service) => {
	/** @param {Site} s */
	const storeOf = async (s) => createFulfilmentStore(await s.data());

	/** @param {any} ctx */
	const refOf = (ctx) => {
		const ref = String(ctx.params.userId ?? '');
		if (!CUSTOMER_REF.test(ref)) throw problem('not_found', 'There is no such customer.');
		return ref;
	};

	/**
	 * The list's search and blocked filter (an over-long search is refused, as the list refuses it).
	 * @param {any} ctx
	 */
	const queryOf = async (ctx) => {
		const q = typeof ctx.query.q === 'string' ? ctx.query.q.trim() : '';
		if (q.length > MAX_SEARCH) throw service.invalid('q', `Search for at most ${MAX_SEARCH} characters.`);
		const blocked = ctx.query.blocked === 'true' ? true : ctx.query.blocked === 'false' ? false : null;
		const segment = ctx.query.segment === undefined || ctx.query.segment === '' ? null : ctx.query.segment;
		if (segment !== null && !SEGMENTS.includes(segment))
			throw service.invalid('segment', 'segment is loyalty, active or guest.');
		let createdAfter = null;
		if (typeof ctx.query.createdAfter === 'string' && ctx.query.createdAfter !== '') {
			const time = Date.parse(ctx.query.createdAfter);
			if (Number.isNaN(time)) throw service.invalid('createdAfter', 'Use an ISO-8601 date.');
			createdAfter = new Date(time);
		}
		/** @type {string[] | null} */
		let userIds = null;
		if (typeof ctx.query.userIds === 'string' && ctx.query.userIds !== '') {
			userIds = [...new Set(ctx.query.userIds.split(','))];
			if (userIds.length > MAX_USER_IDS || !userIds.every((id) => CUSTOMER_REF.test(id)))
				throw service.invalid('userIds', `userIds lists at most ${MAX_USER_IDS} Accounts user ids, comma-separated.`);
		}
		const loyalty = segment === 'loyalty' ? await loyaltyOwners(ctx) : null;
		return {
			q,
			blocked,
			segment,
			loyalty,
			seenBy: service.actor(ctx).id,
			unseen: ctx.query.unseen === '1' || ctx.query.unseen === 'true',
			createdAfter,
			userIds,
		};
	};

	/**
	 * Who has a loyalty account with points earned or left (segment `loyalty`, E31), at most 5,000.
	 * @param {any} ctx
	 */
	const loyaltyOwners = async (ctx) => {
		const s = await service.site(ctx);
		const rows = await (
			await s.data()
		)
			.collection(COLLECTIONS.loyalty)
			.find(
				{ websiteId: s.websiteId, $or: [{ balance: { $gt: 0 } }, { lifetimeEarned: { $gt: 0 } }] },
				{ projection: { _id: 0, userId: 1, customerId: 1 }, limit: 5000 },
			)
			.toArray();
		return {
			userIds: rows.map((row) => row.userId).filter((id) => typeof id === 'string' && id !== ''),
			customerIds: rows.map((row) => row.customerId).filter((id) => typeof id === 'string' && id !== ''),
		};
	};

	const counts = countHandlers({
		source: async (ctx) => {
			const query = await queryOf(ctx);
			const s = await service.site(ctx);
			return { collection: (await s.data()).collection(COLLECTIONS.customers), filter: customerFilter(s.websiteId, query) };
		},
		by: { blocked: 'blocked', segment: { path: 'userId', map: (userId) => (userId ? 'member' : 'guest') } },
	});

	/** @param {any} ctx */
	const list = async (ctx) => {
		const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url }, { defaultLimit: 25 });
		const query = await queryOf(ctx);
		const s = await service.site(ctx);
		const store = await storeOf(s);
		const rows = await store.customers.list({ ...query, after: page.after, limit: page.fetchLimit });
		const spent = await store.orders.spent(rows);
		const { money } = await s.format();
		return page.respond(
			rows.map((row) => customerView(row, spent.get(spentKey(row)) ?? { total: 0, count: 0 }, s.currency, money)),
			(view) => [view.name, view.userId],
		);
	};

	/**
	 * A customer by customer id or user id (K-6): their record, else (a member) one made from their latest order, else
	 * the record of an Accounts user without orders, made now (CU-2: staff open, note and block them before their first
	 * order; joined when Accounts says), else 404.
	 * @param {Site} s @param {string} ref
	 */
	const find = async (s, ref) => {
		const store = await storeOf(s);
		let record = await store.customers.find(ref);
		if (!record && isCustomerId(ref)) throw problem('not_found', 'There is no such customer.');
		const owner = record ? customerOwner(record) : { userId: ref };
		const recent = await store.orders.ofCustomer(owner, RECENT_ORDERS);
		const latest = recent[0];
		if (!record && !latest) {
			const user = await service.accountsUser(s, ref);
			if (!user) throw problem('not_found', 'There is no such customer.');
			record = await createOrdersStore(await s.data()).ensureCustomer(
				{ userId: ref, name: user.name, email: user.email, phone: user.phone },
				{ at: user.createdAt, refresh: false },
			);
		}
		const details = latest
			? { name: latest.customer.name, email: latest.customer.email, phone: latest.customer.phone }
			: { name: '', email: '', phone: '' };
		return { store, record, recent, details, userId: record ? (record.userId ?? '') : ref };
	};

	/**
	 * @param {Site} s @param {string} ref
	 */
	const view = async (s, ref) => {
		const { store, record, recent, details, userId } = await find(s, ref);
		const shown = record ?? { userId, ...details };
		const spent = (await store.orders.spent([shown])).get(spentKey(shown)) ?? { total: 0, count: 0 };
		const flow = /** @type {import('../core/model.js').OrderFlow} */ (/** @type {unknown} */ (await s.list('order_flow')));
		const { money } = await s.format();
		return {
			...customerView(shown, spent, s.currency, money),
			recentOrders: recent.map((order) => orderSummary(order, flow, money)),
		};
	};

	/** @param {any} ctx */
	const read = async (ctx) => view(await service.site(ctx), refOf(ctx));

	/** @param {any} ctx */
	const edit = async (ctx) => {
		const ref = refOf(ctx);
		const checked = checkCustomerEdit(ctx.body);
		if (!checked.ok) throw service.invalid(checked.field, checked.message);
		const s = await service.site(ctx);
		const { store, record, details, userId } = await find(s, ref);
		const { blocked, blockedReason, note, resetRto } = checked.value;
		await store.customers.update(
			// a guest's record by its id; a member's by user id (made when missing)
			userId ? { userId } : { id: /** @type {string} */ (record?.id) },
			{
				...(blocked === undefined ? {} : { blocked, blockedReason }),
				...(note === undefined ? {} : { note }),
				...(resetRto ? { rtoCount: 0 } : {}),
			},
			record ? { name: record.name, email: record.email, phone: record.phone } : details,
			new Date(service.now()),
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
		await service.log(ctx, action, ref, {
			label: (record?.name || details.name || ref).slice(0, 200),
			...(changes.length > 0 ? { detail: changes.join(', ') } : {}),
		});
		return view(s, ref);
	};

	/** POST /v1/customers/:userId/seen: the acting staff member opened the customer (a user id or customer id, E31). @param {any} ctx */
	const seen = async (ctx) => {
		const ref = refOf(ctx);
		const s = await service.site(ctx);
		const data = await s.data();
		const done = await markSeenBy(data, COLLECTIONS.customers, { $or: [{ userId: ref }, { id: ref }] }, service.actor(ctx).id);
		if (done.matchedCount !== 1) throw problem('not_found', 'There is no such customer.');
		return { seen: true };
	};

	return Object.freeze({ list, read, edit, seen, count: counts.count, counts: counts.counts });
};
