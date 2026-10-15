/**
 * Guests becoming members (PLAN 0.8.10 E21): when a signed-in shopper's phone, verified by Accounts, is a guest's
 * phone, the guest's orders, loyalty points and alerts move to the member on that request, and the guest's customer
 * record is folded into the member's (order and RTO counts added, a block kept, the staff note and the customer field
 * values the member's record lacks taken over). Guest orders placed on a member's phone are linked to the member's
 * record but stay out of their account until such a sign-in (owner, 2026-10-14 (2)): then they move in too. Also the
 * check of `unless_password`:
 * whether a phone belongs to an Accounts user with a password (through the pasted Accounts token), and the website's
 * phone rules (K12).
 * @module
 */
import { mergeLoyalty } from '../adapters/ledger.js';
import { createOrdersStore } from '../adapters/orders-store.js';
import { phoneRules } from '../core/guests.js';
import { COLLECTIONS } from '../core/model.js';
import { MAX_STAFF_NOTE } from '../core/orders.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./service.js').Shopper} Shopper */

/**
 * How the website reads the phones shoppers type (K12): the `checkout` settings and its business.json country.
 * @param {Site} s
 */
export const phoneRulesOf = async (s) => phoneRules(await s.values('checkout'), (await s.business()).country);

/**
 * @param {Product} product
 */
export const createGuests = (product) => {
	/**
	 * Move a guest's records to the signed-in shopper whose verified phone is the guest's. Never throws.
	 * @param {Site} s
	 * @param {Shopper | null} shopper
	 * @returns {Promise<number>} the guest orders moved
	 */
	const claim = async (s, shopper) => {
		if (!shopper?.phoneVerified || !shopper.phone) return 0;
		try {
			const data = await s.data();
			const store = createOrdersStore(data);
			const guest = await store.guestCustomer(shopper.phone);
			const own = await store.customer(shopper.id);
			// the guest orders placed on this phone that are linked to the member's own record
			const linked = own?.id
				? {
						websiteId: data.websiteId,
						'customer.customerId': own.id,
						'customer.userId': '',
						'customer.phone': shopper.phone,
					}
				: null;
			if (!guest?.id) {
				if (!linked) return 0;
				const orders = await data
					.collection(COLLECTIONS.orders)
					.updateMany(linked, { $set: { 'customer.userId': shopper.id } });
				return orders.modifiedCount;
			}
			const member = await store.ensureCustomer(
				{ userId: shopper.id, name: shopper.name, email: shopper.email, phone: shopper.phone },
				{ at: new Date(product.now()) },
			);
			let moved = 0;
			await data.transaction(async (session) => {
				const orders = await data
					.collection(COLLECTIONS.orders)
					.updateMany(
						{ websiteId: data.websiteId, 'customer.customerId': guest.id, 'customer.userId': '' },
						{ $set: { 'customer.userId': shopper.id, 'customer.customerId': member.id } },
						{ session },
					);
				moved = orders.modifiedCount;
				if (linked)
					moved += (
						await data
							.collection(COLLECTIONS.orders)
							.updateMany(linked, { $set: { 'customer.userId': shopper.id } }, { session })
					).modifiedCount;
				await mergeLoyalty(data, { customerId: /** @type {string} */ (guest.id), userId: shopper.id }, session);
				await data
					.collection(COLLECTIONS.alerts)
					.updateMany(
						{ websiteId: data.websiteId, customerId: guest.id },
						{ $set: { userId: shopper.id, customerId: member.id } },
						{ session },
					);
				// what staff kept on the guest's record: its block, its note and the field values the member's lacks
				/** @type {Record<string, unknown>} */
				const set = {
					...(guest.blocked && !member.blocked ? { blocked: true, blockedReason: guest.blockedReason ?? '' } : {}),
					...(guest.note
						? { note: member.note ? `${member.note}\n${guest.note}`.slice(0, MAX_STAFF_NOTE) : guest.note }
						: {}),
				};
				for (const [id, value] of Object.entries(guest.fields ?? {}))
					if (member.fields?.[id] === undefined) set[`fields.${id}`] = value;
				await data.collection(COLLECTIONS.customers).updateOne(
					{ websiteId: data.websiteId, id: member.id },
					{
						$inc: { orderCount: guest.orderCount ?? 0, rtoCount: guest.rtoCount ?? 0 },
						...(Object.keys(set).length > 0 ? { $set: set } : {}),
					},
					{ session },
				);
				await data.collection(COLLECTIONS.customers).deleteOne({ websiteId: data.websiteId, id: guest.id }, { session });
			});
			return moved;
		} catch (error) {
			s.ctx.log?.warn?.('guest records not moved', { code: /** @type {any} */ (error)?.code ?? 'error' });
			return 0;
		}
	};

	/**
	 * Whether a phone belongs to an Accounts user with a password (`unless_password`). False when Accounts cannot say:
	 * the guest orders and the order moves to the member when they sign in.
	 * @param {Site} s
	 * @param {string} phone E.164
	 */
	const memberWithPassword = async (s, phone) => {
		const answer = await product
			.callProduct(s.websiteId, 'accounts', `/v1/users?phone=${encodeURIComponent(phone)}&limit=1`, { method: 'GET' })
			.catch(() => /** @type {const} */ ({ ok: false }));
		if (!answer.ok || answer.status !== 200) return false;
		const items = /** @type {any} */ (answer.body)?.items;
		return Array.isArray(items) && items.some((user) => user?.phone === phone && user?.hasPassword === true);
	};

	return Object.freeze({ claim, memberWithPassword });
};

/** @typedef {ReturnType<typeof createGuests>} Guests */
