/**
 * Guests becoming members (PLAN 0.8.10 E21): when a signed-in shopper's phone, verified by Accounts, is a guest's
 * phone, the guest's orders, loyalty points and alerts move to the member on that request, and the guest's customer
 * record is folded into the member's (order and RTO counts added, a block kept). Also the check of `unless_password`:
 * whether a phone belongs to an Accounts user with a password (through the pasted Accounts token).
 * @module
 */
import { mergeLoyalty } from '../adapters/ledger.js';
import { createOrdersStore } from '../adapters/orders-store.js';
import { COLLECTIONS } from '../core/model.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./service.js').Shopper} Shopper */

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
			if (!guest?.id) return 0;
			const member = await store.ensureCustomer({
				userId: shopper.id,
				name: shopper.name,
				email: shopper.email,
				phone: shopper.phone,
			});
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
				await mergeLoyalty(data, { customerId: /** @type {string} */ (guest.id), userId: shopper.id }, session);
				await data
					.collection(COLLECTIONS.alerts)
					.updateMany(
						{ websiteId: data.websiteId, customerId: guest.id },
						{ $set: { userId: shopper.id, customerId: member.id } },
						{ session },
					);
				await data.collection(COLLECTIONS.customers).updateOne(
					{ websiteId: data.websiteId, id: member.id },
					{
						$inc: { orderCount: guest.orderCount ?? 0, rtoCount: guest.rtoCount ?? 0 },
						...(guest.blocked && !member.blocked
							? { $set: { blocked: true, blockedReason: guest.blockedReason ?? '' } }
							: {}),
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
