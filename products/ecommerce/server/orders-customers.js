/**
 * Customers for the merchant (PLAN 0.8.8: Ecommerce keeps only shop records linked to the Accounts user id; E21:
 * guests too): the list and search with what each customer paid, one customer with their latest orders, and the
 * blocklist (a blocked shopper cannot order; checkout reads `blocked`), the staff note and the return-to-origin count.
 * One customer is named by their customer id (`cus_…`, members and guests alike) or a member's Accounts user id (K-6);
 * a guest's orders and spend are theirs by customer id. The list has counts (`count`, and `counts` by `blocked`; PLAN
 * 0.8.10 K4) with the same filters.
 * @module
 */
import { countHandlers, created, paginate, problem } from '@ss/app-kit';
import { createId } from '@ss/contracts';
import { fieldsOn } from '../adapters/catalog-store.js';
import { createFulfillmentStore, customerFilter, markSeenBy } from '../adapters/fulfillment-store.js';
import { givePoints } from '../adapters/ledger.js';
import { createOrdersStore } from '../adapters/orders-store.js';
import { checkAddress } from '../core/checkout.js';
import { checkFieldValues } from '../core/fields.js';
import { MAX_ADDRESSES, checkNewCustomer, guestRules, phoneDigitsOf, phoneSearchOf } from '../core/guests.js';
import { expiryFor, loyaltyRules } from '../core/loyalty.js';
import { COLLECTIONS, ID_PREFIX } from '../core/model.js';
import { segmentFilter, segmentNeeds } from '../core/customer-segments.js';
import { addressRulesOf, phoneRulesOf } from './guests.js';
import {
	MAX_SEARCH,
	checkCustomerEdit,
	fieldDefinition,
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
/** Most customers a loyalty or spend rule of a segment names (E11). */
const MAX_OWNERS = 5000;
/** Most customers' spend a spend rule reads. */
const MAX_SPENDERS = 20_000;
/** Most Accounts users one `userIds` filter names. */
const MAX_USER_IDS = 100;

/**
 * @param {Service} service
 */
export const createCustomers = (service) => {
	/** @param {Site} s */
	const storeOf = async (s) => createFulfillmentStore(await s.data());

	/** @param {any} ctx */
	const refOf = (ctx) => {
		const ref = String(ctx.params.userId ?? '');
		if (!CUSTOMER_REF.test(ref)) throw problem('not_found', 'There is no such customer.');
		return ref;
	};

	/**
	 * The merchant's saved segments (`customer_segments`, E11).
	 * @param {Site} s
	 * @returns {Promise<import('../core/customer-segments.js').Segment[]>}
	 */
	const segmentsOf = async (s) => /** @type {any} */ (await s.list('customer_segments'));

	/**
	 * A saved segment's filter, with what its loyalty and spend rules need read first (E11).
	 * @param {Site} s @param {import('../core/customer-segments.js').Segment} segment
	 */
	const filterOf = async (s, segment) => {
		const needs = segmentNeeds(segment);
		/** @type {Map<number, { userIds: string[], customerIds: string[] }>} */
		const spent = new Map();
		for (const rule of needs.spent) spent.set(rule.index, await spenders(s, rule.op === 'gte' ? rule.value : rule.value + 1));
		return segmentFilter(segment, {
			now: service.now(),
			...(needs.loyalty ? { loyalty: await loyaltyOwners(s) } : {}),
			spent,
		});
	};

	/**
	 * The list's search and filters (an over-long search is refused, as the list refuses it): blocked, a saved segment
	 * (E11; left out with `bySegment`: the counts of every segment), tags, not opened, created after and given Accounts
	 * users.
	 * @param {any} ctx @param {{ bySegment?: boolean }} [options]
	 */
	const queryOf = async (ctx, { bySegment = false } = {}) => {
		const q = typeof ctx.query.q === 'string' ? ctx.query.q.trim() : '';
		if (q.length > MAX_SEARCH) throw service.invalid('q', `Search for at most ${MAX_SEARCH} characters.`);
		const blocked = ctx.query.blocked === 'true' ? true : ctx.query.blocked === 'false' ? false : null;
		const s = await service.site(ctx);
		/** @type {Record<string, unknown> | null} */
		let segment = null;
		if (!bySegment && ctx.query.segment !== undefined && ctx.query.segment !== '') {
			const found = (await segmentsOf(s)).find((entry) => entry.key === ctx.query.segment);
			if (!found) throw service.invalid('segment', 'segment is the key of a saved segment.');
			segment = await filterOf(s, found);
		}
		/** @type {string[] | null} */
		let tags = null;
		if (typeof ctx.query.tag === 'string' && ctx.query.tag !== '') {
			tags = [...new Set(ctx.query.tag.split(',').map((/** @type {string} */ tag) => tag.trim()))].filter(Boolean);
			if (tags.length > 30 || tags.some((tag) => tag.length > 40))
				throw service.invalid('tag', 'Name at most 30 tags of up to 40 characters.');
		}
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
		return {
			q,
			blocked,
			segment,
			tags,
			seenBy: service.actor(ctx).id,
			unseen: ctx.query.unseen === '1' || ctx.query.unseen === 'true',
			createdAfter,
			userIds,
			// a phone typed as shoppers type it (national, with its trunk prefix) is found by its whole number
			...(q ? { phoneDigits: phoneSearchOf(q, await phoneRulesOf(await service.site(ctx))) } : {}),
		};
	};

	/**
	 * The list's order (E46): A to Z by name (the default) or the newest first.
	 * @param {any} ctx
	 * @returns {'name' | 'newest'}
	 */
	const sortOf = (ctx) => {
		const sort = ctx.query.sort === undefined || ctx.query.sort === '' ? 'name' : ctx.query.sort;
		if (sort !== 'name' && sort !== 'newest') throw service.invalid('sort', 'sort is name or newest.');
		return sort;
	};

	/**
	 * Who a `loyalty` rule holds (E11, E47): the customers flagged as members while the loyalty setting `memberFlag` is
	 * on, else who has a loyalty account with points earned or left, at most {@link MAX_OWNERS}.
	 * @param {Site} s
	 * @returns {Promise<{ userIds: string[], customerIds: string[] } | 'flag'>}
	 */
	const loyaltyOwners = async (s) => {
		if (s.has('loyalty') && loyaltyRules(await s.values('loyalty')).memberFlag !== 'off') return 'flag';
		const rows = await (
			await s.data()
		)
			.collection(COLLECTIONS.loyalty)
			.find(
				{ websiteId: s.websiteId, $or: [{ balance: { $gt: 0 } }, { lifetimeEarned: { $gt: 0 } }] },
				{ projection: { _id: 0, userId: 1, customerId: 1 }, limit: MAX_OWNERS },
			)
			.toArray();
		return {
			userIds: rows.map((row) => row.userId).filter((id) => typeof id === 'string' && id !== ''),
			customerIds: rows.map((row) => row.customerId).filter((id) => typeof id === 'string' && id !== ''),
		};
	};

	/**
	 * The customers who spent at least `least` (paid − refunded, minor units; E11): a member's guest orders count as
	 * theirs, as the list shows them. At most {@link MAX_OWNERS}.
	 * @param {Site} s @param {number} least
	 * @returns {Promise<{ userIds: string[], customerIds: string[] }>}
	 */
	const spenders = async (s, least) => {
		const data = await s.data();
		const rows = await data
			.collection(COLLECTIONS.orders)
			.aggregate(
				[
					{ $match: { websiteId: s.websiteId } },
					{
						$group: {
							_id: { u: '$customer.userId', c: '$customer.customerId' },
							total: { $sum: { $subtract: [{ $ifNull: ['$payment.paid', 0] }, { $ifNull: ['$payment.refunded', 0] }] } },
						},
					},
					{ $limit: MAX_SPENDERS },
				],
				{ maxTimeMS: 5000 },
			)
			.toArray();
		/** @type {Map<string, number>} spend by `u:<user id>` or `c:<customer id>` */
		const totals = new Map();
		/** @type {Set<string>} customer ids of guest orders */
		const guestIds = new Set();
		for (const row of rows) {
			const userId = typeof row._id?.u === 'string' ? row._id.u : '';
			const customerId = typeof row._id?.c === 'string' ? row._id.c : '';
			const key = userId ? `u:${userId}` : customerId ? `c:${customerId}` : '';
			if (!key) continue;
			if (!userId) guestIds.add(customerId);
			totals.set(key, (totals.get(key) ?? 0) + Number(row.total ?? 0));
		}
		// the guest orders of a member's record are theirs
		const members = /** @type {Array<{ id: string, userId: string }>} */ (
			guestIds.size === 0
				? []
				: await data
						.collection(COLLECTIONS.customers)
						.find(
							{ websiteId: s.websiteId, id: { $in: [...guestIds] }, userId: { $type: 'string', $ne: '' } },
							{ projection: { _id: 0, id: 1, userId: 1 } },
						)
						.toArray()
		);
		for (const member of members) {
			const guest = totals.get(`c:${member.id}`) ?? 0;
			totals.delete(`c:${member.id}`);
			totals.set(`u:${member.userId}`, (totals.get(`u:${member.userId}`) ?? 0) + guest);
		}
		const keys = [...totals]
			.filter(([, total]) => total >= least)
			.map(([key]) => key)
			.slice(0, MAX_OWNERS);
		return {
			userIds: keys.filter((key) => key.startsWith('u:')).map((key) => key.slice(2)),
			customerIds: keys.filter((key) => key.startsWith('c:')).map((key) => key.slice(2)),
		};
	};

	const kitCounts = countHandlers({
		source: async (ctx) => {
			const query = await queryOf(ctx);
			const s = await service.site(ctx);
			return { collection: (await s.data()).collection(COLLECTIONS.customers), filter: customerFilter(s.websiteId, query) };
		},
		by: { blocked: 'blocked' },
	});

	/**
	 * The list's counts: the kit's (`count`, `counts?by=blocked`), and `counts?by=segment`, how many customers each saved
	 * segment holds with the list's other filters (E11; a customer counts in each segment they are in, the total once).
	 */
	const counts = {
		count: kitCounts.count,
		/** @param {any} ctx */
		counts: async (ctx) => {
			if (ctx.query.by !== 'segment') return kitCounts.counts(ctx);
			const query = await queryOf(ctx, { bySegment: true });
			const s = await service.site(ctx);
			const customers = (await s.data()).collection(COLLECTIONS.customers);
			const base = customerFilter(s.websiteId, query);
			/** @type {Record<string, number>} */
			const groups = {};
			for (const segment of await segmentsOf(s)) {
				const n = await customers.countDocuments(
					{ ...base, $and: [.../** @type {any[]} */ (base.$and ?? []), await filterOf(s, segment)] },
					{ maxTimeMS: 3000 },
				);
				if (n > 0) groups[segment.key] = n;
			}
			return { total: await customers.countDocuments(base, { maxTimeMS: 3000 }), groups };
		},
	};

	/** GET …/customers/segments: the saved segments, for the admin widget (E11). @param {any} ctx */
	const segments = async (ctx) => ({
		items: (await segmentsOf(await service.site(ctx))).map((segment) => ({
			key: segment.key,
			name: segment.name,
			match: segment.match,
			rules: segment.rules,
		})),
	});

	/**
	 * The loyalty points of a page of customers, read in one query for all of them (a member's account is keyed by their
	 * user id, a guest's by their customer id; no account: 0). Null while the loyalty feature is off. The balance is the
	 * one the account holds; lots that expired are written off the next time the account is read.
	 * @param {Site} s @param {Array<{ id?: string, userId?: string | null }>} rows
	 * @returns {Promise<(row: { id?: string, userId?: string | null }) => number | null>}
	 */
	const pointsOf = async (s, rows) => {
		if (!s.has('loyalty')) return () => null;
		const userIds = rows.map((row) => row.userId).filter((id) => typeof id === 'string' && id !== '');
		const customerIds = rows
			.filter((row) => !row.userId)
			.map((row) => row.id)
			.filter((id) => typeof id === 'string' && id !== '');
		const owners = [
			...(userIds.length > 0 ? [{ userId: { $in: userIds } }] : []),
			...(customerIds.length > 0 ? [{ customerId: { $in: customerIds } }] : []),
		];
		/** @type {Map<string, number>} */
		const balances = new Map();
		if (owners.length > 0) {
			const accounts = await (
				await s.data()
			)
				.collection(COLLECTIONS.loyalty)
				.find(
					{ websiteId: s.websiteId, $or: owners },
					{ projection: { _id: 0, userId: 1, customerId: 1, balance: 1 }, maxTimeMS: 3000 },
				)
				.toArray();
			for (const account of accounts)
				balances.set(account.userId ? `u:${account.userId}` : `c:${account.customerId}`, Number(account.balance) || 0);
		}
		return (row) => balances.get(row.userId ? `u:${row.userId}` : `c:${row.id}`) ?? 0;
	};

	/** @param {any} ctx */
	const list = async (ctx) => {
		const sort = sortOf(ctx);
		const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url }, { defaultLimit: 25 });
		const query = await queryOf(ctx);
		const s = await service.site(ctx);
		const store = await storeOf(s);
		const rows = await store.customers.list({ ...query, sort, after: page.after, limit: page.fetchLimit });
		const [spent, points, { money }] = await Promise.all([store.orders.spent(rows), pointsOf(s, rows), s.format()]);
		return page.respond(
			rows.map((row) => customerView(row, spent.get(spentKey(row)) ?? { total: 0, count: 0 }, s.currency, money, points(row))),
			(view) => (sort === 'newest' ? [view.createdAt ?? '', view.id] : [view.name, view.id]),
		);
	};

	/**
	 * A customer by customer id or user id (K-6): their record, else (a member) the details of their latest order, else
	 * the record of an Accounts user without orders, made now (CU-2: staff open, note and block them before their first
	 * order; joined when Accounts says), else 404. `make`: a member known only from their orders gets their record too,
	 * whole (a change is written to it).
	 * @param {Site} s @param {string} ref @param {{ make?: boolean }} [options]
	 */
	const find = async (s, ref, { make = false } = {}) => {
		const store = await storeOf(s);
		let record = await store.customers.find(ref);
		if (!record && isCustomerId(ref)) throw problem('not_found', 'There is no such customer.');
		// a member's orders, and the guest orders on their phone linked to their record (K-6)
		const owner = record ? { ...customerOwner(record), customerId: String(record.id ?? '') } : { userId: ref };
		const recent = await store.orders.ofCustomer(owner, RECENT_ORDERS);
		const latest = recent[0];
		if (!record && (make || !latest)) {
			const user = latest ? null : await service.accountsUser(s, ref);
			if (!latest && !user) throw problem('not_found', 'There is no such customer.');
			record = await createOrdersStore(await s.data()).ensureCustomer(
				latest
					? { userId: ref, name: latest.customer.name, email: latest.customer.email, phone: latest.customer.phone }
					: { userId: ref, .../** @type {NonNullable<typeof user>} */ (user) },
				{ at: latest ? new Date(service.now()) : /** @type {NonNullable<typeof user>} */ (user).createdAt, refresh: false },
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
		const flow = await s.flow();
		const { money } = await s.format();
		const values = record?.fields ?? {};
		return {
			...customerView(shown, spent, s.currency, money, (await pointsOf(s, [shown]))(shown)),
			// the addresses staff keep and a guest's orders delivered to (E46)
			addresses: record?.addresses ?? [],
			recentOrders: recent.map((order) => orderSummary(order, flow, money)),
			// its customer field values (staff see every one), and the fields staff fill (dynamic model §2)
			fields: values,
			customerFields: (await fieldsOn(await s.data(), 'customer'))
				.filter((field) => field.active || values[field.id] !== undefined)
				.map(fieldDefinition),
		};
	};

	/**
	 * A customer's record for a change, made when missing (`find` with `make`).
	 * @param {Site} s @param {string} ref
	 */
	const recordFor = async (s, ref) => {
		const { store, record } = await find(s, ref, { make: true });
		return { store, record: /** @type {import('../core/model.js').CustomerRecord} */ (record) };
	};

	/** @param {any} ctx */
	const read = async (ctx) => view(await service.site(ctx), refOf(ctx));

	/** @param {any} ctx */
	const edit = async (ctx) => {
		const ref = refOf(ctx);
		const checked = checkCustomerEdit(ctx.body);
		if (!checked.ok) throw service.invalid(checked.field, checked.message);
		const s = await service.site(ctx);
		const { store, record } = await recordFor(s, ref);
		const { blocked, blockedReason, note, resetRto, fields, loyaltyMember, tags } = checked.value;
		/** @type {Record<string, unknown> | null} the customer field values after the edit (null: not changed) */
		let nextFields = null;
		if (fields) {
			const known = (await fieldsOn(await s.data(), 'customer')).filter((field) => field.active);
			const given = checkFieldValues(fields, known);
			if (!given.ok) throw service.invalid(given.path, given.message);
			nextFields = { ...(record.fields ?? {}), ...given.value };
			for (const id of given.cleared) delete nextFields[id];
		}
		await store.customers.update(record.id, {
			...(blocked === undefined ? {} : { blocked, blockedReason }),
			...(note === undefined ? {} : { note }),
			...(resetRto ? { rtoCount: 0 } : {}),
			...(nextFields ? { fields: nextFields } : {}),
			...(loyaltyMember === undefined ? {} : { loyaltyMember }),
			...(tags === undefined ? {} : { tags }),
		});
		const action =
			blocked === true && record.blocked !== true
				? 'customer.blocked'
				: blocked === false && record.blocked === true
					? 'customer.unblocked'
					: 'customer.edited';
		const changes = [
			...(action === 'customer.blocked' ? ['blocked'] : action === 'customer.unblocked' ? ['unblocked'] : []),
			...(note === undefined ? [] : ['note changed']),
			...(resetRto ? ['returned packages reset'] : []),
			...(fields ? ['fields changed'] : []),
			...(tags === undefined ? [] : ['tags changed']),
			...(loyaltyMember === undefined || loyaltyMember === (record.loyaltyMember === true)
				? []
				: [loyaltyMember ? 'marked a loyalty member' : 'no longer a loyalty member']),
		];
		await service.log(ctx, action, ref, {
			label: (record.name || ref).slice(0, 200),
			...(changes.length > 0 ? { detail: changes.join(', ') } : {}),
		});
		return view(s, ref);
	};

	/**
	 * POST /v1/customers (E46): a customer without an account, added by staff — a guest record by the contact guests are
	 * known by (E15, `checkout.guestIdentity`; one per phone or email address: 409 conflict when a customer has it), with the opening loyalty points given (while Loyalty is on) and the loyalty
	 * member flag (E47).
	 * @param {any} ctx
	 */
	const create = async (ctx) => {
		const s = await service.site(ctx);
		// staff add a customer by the contact guests are known by (E15); a phone only as that asks
		const { identity } = guestRules(await s.values('checkout'));
		const checked = checkNewCustomer(ctx.body, await phoneRulesOf(s), { identity, phoneRequired: false });
		if (!checked.ok) throw service.invalid(checked.field, checked.message, checked.code);
		const { points, ...who } = checked.value;
		if (points > 0 && !s.has('loyalty')) throw service.invalid('points', 'Opening points need Loyalty on.');
		const now = service.now();
		const record = {
			id: createId(ID_PREFIX.customer),
			userId: null,
			guest: true,
			// the key a guest with this contact has (dynamic model §5, E15)
			guestKey: who.guestKey,
			name: who.name,
			email: who.email,
			phone: who.phone,
			phoneDigits: phoneDigitsOf(who.phone),
			city: who.city,
			blocked: false,
			blockedReason: '',
			rtoCount: 0,
			orderCount: 0,
			note: who.note,
			seenBy: [],
			addresses: [],
			...(who.loyaltyMember ? { loyaltyMember: true } : {}),
			createdAt: new Date(now),
		};
		const store = await storeOf(s);
		if (!(await store.customers.create(record)))
			throw problem('conflict', 'A customer with this phone number or email address is there already: open them instead.');
		if (points > 0)
			await givePoints(
				await s.data(),
				{
					userId: { customerId: record.id },
					points,
					orderId: null,
					kind: 'adjust',
					expiresAt: expiryFor(now, await s.values('loyalty')),
					// no words stored: the history reads the kind in the website's texts (E33)
					note: '',
				},
				{ now },
			);
		await service.log(ctx, 'customer.created', record.id, {
			label: record.name.slice(0, 200),
			...(points > 0 ? { detail: `${points} opening points` } : {}),
		});
		return created(await view(s, record.id));
	};

	/**
	 * PUT /v1/customers/:userId/addresses `{ addresses }` (E46): the addresses staff keep for a customer, at most
	 * {@link MAX_ADDRESSES}, the first the newest; each checked as checkout checks a delivery address.
	 * @param {any} ctx
	 */
	const setAddresses = async (ctx) => {
		const ref = refOf(ctx);
		const given = ctx.body?.addresses;
		if (!Array.isArray(given) || given.length > MAX_ADDRESSES)
			throw service.invalid('addresses', `addresses is a list of at most ${MAX_ADDRESSES} addresses.`);
		const s = await service.site(ctx);
		const rules = await addressRulesOf(s);
		const addresses = given.map((entry, index) => {
			const checked = checkAddress(entry, rules);
			if (!checked.ok)
				throw service.invalid(
					`addresses/${index}${checked.field.replace(/^address/, '')}`,
					checked.message.replace(/^address\./, ''),
				);
			return checked.value;
		});
		const { store, record } = await recordFor(s, ref);
		await store.customers.update(record.id, { addresses });
		await service.log(ctx, 'customer.edited', ref, { label: (record.name || ref).slice(0, 200), detail: 'addresses changed' });
		return view(s, ref);
	};

	/**
	 * DELETE /v1/customers/:userId (E46): a customer record no order names, with its loyalty account (409 conflict once
	 * one does: their orders keep it). A member's Accounts user stays.
	 * @param {any} ctx
	 */
	const remove = async (ctx) => {
		const ref = refOf(ctx);
		const s = await service.site(ctx);
		const store = await storeOf(s);
		const record = await store.customers.find(ref);
		if (!record) throw problem('not_found', 'There is no such customer.');
		const done = await store.customers.remove(record.id);
		if (done === 'missing') throw problem('not_found', 'There is no such customer.');
		if (done === 'ordered') throw problem('conflict', 'This customer has orders: a customer with orders is kept with them.');
		const data = await s.data();
		await data
			.collection(COLLECTIONS.loyalty)
			.deleteOne(
				record.userId ? { websiteId: s.websiteId, userId: record.userId } : { websiteId: s.websiteId, customerId: record.id },
			);
		await service.log(ctx, 'customer.deleted', record.id, { label: (record.name || record.id).slice(0, 200) });
		return undefined;
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

	return Object.freeze({
		list,
		read,
		edit,
		create,
		setAddresses,
		remove,
		seen,
		segments,
		count: counts.count,
		counts: counts.counts,
	});
};
