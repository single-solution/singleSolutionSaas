/**
 * Guests becoming members (PLAN 0.8.10 E21; dynamic model §5): when a signed-in shopper's phone or email address,
 * verified by Accounts (`phone_verified`, `email_verified` in the sign-in), is a guest's key, the guest's orders,
 * loyalty points and alerts move to the member on that request, and the guest's customer record is folded into the
 * member's (order and RTO counts added, a block kept, the staff note and the customer field values the member's record
 * lacks taken over). Guest orders placed on a member's phone or email address are linked to the member's record but
 * stay out of their account until such a sign-in (owner, 2026-10-14 (2)): then they move in too. Also the check of
 * `unless_password`: whether a guest's phone or email address belongs to an Accounts user with a password (through the
 * Portal link to Accounts), and the website's phone and address rules (K12).
 * @module
 */
import { addressRequiredOf } from '@ss/contracts/website-settings';
import { mergeLoyalty } from '../adapters/ledger.js';
import { createOrdersStore } from '../adapters/orders-store.js';
import { phoneRules, savedAddresses } from '../core/guests.js';
import { COLLECTIONS } from '../core/model.js';
import { MAX_STAFF_NOTE } from '../core/orders.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./service.js').Shopper} Shopper */

/**
 * How the website reads the phones shoppers type (K12): the `checkout` settings and its business country.
 * @param {Site} s
 */
export const phoneRulesOf = async (s) => phoneRules((await s.website()).region);

/**
 * What a delivery address must hold on the website (`core/checkout.js` `checkAddress`): the `checkout` settings
 * `phoneRequired`, the address parts the Portal requires, its phone rules, the region names and its country (all from the
 * Portal's Region and format).
 * @param {Site} s
 * @returns {Promise<import('../core/checkout.js').AddressRules>}
 */
export const addressRulesOf = async (s) => {
	const [checkout, website] = await Promise.all([s.values('checkout'), s.website()]);
	return {
		required: addressRequiredOf(website),
		phoneRequired: checkout.phoneRequired !== false,
		phoneRules: phoneRules(website.region),
		regions: website.region.address.regions,
		homeCountry: website.region.country,
	};
};

/**
 * @param {Product} product
 */
export const createGuests = (product) => {
	/**
	 * Move the records of the guest a verified contact names to the signed-in shopper. Never throws.
	 * @param {Site} s
	 * @param {Shopper} shopper
	 * @param {{ guestKey: string, field: 'customer.phone' | 'customer.email', value: string }} proven the guest key the
	 *   contact makes, and the order field that holds it
	 * @returns {Promise<number>} the guest orders moved
	 */
	const claimKey = async (s, shopper, proven) => {
		try {
			const data = await s.data();
			const store = createOrdersStore(data);
			const guest = await store.guestCustomer(proven.guestKey);
			const own = await store.customer(shopper.id);
			// the guest orders placed on this phone or email address that are linked to the member's own record
			const linked = own?.id
				? {
						websiteId: data.websiteId,
						'customer.customerId': own.id,
						'customer.userId': '',
						[proven.field]: proven.value,
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
				// what staff kept on the guest's record: its block, its note, the field values the member's lacks, its
				// addresses (the guest's first, then the member's, at most 6) and the loyalty member flag
				/** @type {Record<string, unknown>} */
				const set = {
					...(guest.blocked && !member.blocked ? { blocked: true, blockedReason: guest.blockedReason ?? '' } : {}),
					...(guest.note
						? { note: member.note ? `${member.note}\n${guest.note}`.slice(0, MAX_STAFF_NOTE) : guest.note }
						: {}),
					...((guest.addresses ?? []).length > 0
						? {
								addresses: [...(guest.addresses ?? [])]
									.reverse()
									.reduce((kept, address) => savedAddresses(kept, address), member.addresses ?? []),
							}
						: {}),
					...(guest.loyaltyMember && !member.loyaltyMember ? { loyaltyMember: true } : {}),
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
	 * Move a guest's records to the signed-in shopper whose verified phone or email address is the guest's (both, when
	 * both are verified). Never throws.
	 * @param {Site} s
	 * @param {Shopper | null} shopper
	 * @returns {Promise<number>} the guest orders moved
	 */
	const claim = async (s, shopper) => {
		if (!shopper) return 0;
		const email = shopper.email.trim().toLowerCase();
		/** @type {Array<{ guestKey: string, field: 'customer.phone' | 'customer.email', value: string }>} */
		const proven = [
			...(shopper.phoneVerified && shopper.phone
				? [{ guestKey: `p:${shopper.phone}`, field: /** @type {const} */ ('customer.phone'), value: shopper.phone }]
				: []),
			...(shopper.emailVerified && email
				? [{ guestKey: `e:${email}`, field: /** @type {const} */ ('customer.email'), value: email }]
				: []),
		];
		let moved = 0;
		for (const contact of proven) moved += await claimKey(s, shopper, contact);
		return moved;
	};

	/**
	 * Whether a guest's phone or email address belongs to an Accounts user with a password (`unless_password`): which of
	 * them does, or null. Null when Accounts cannot say: the guest orders and the order moves to the member when they
	 * sign in.
	 * @param {Site} s
	 * @param {{ phone: string, email: string }} guest the phone as E.164, the email address in lower case ('' = none)
	 * @returns {Promise<'phone' | 'email' | null>}
	 */
	const memberWithPassword = async (s, { phone, email }) => {
		/** @param {'phone' | 'email'} field @param {string} value */
		const has = async (field, value) => {
			// a phone is looked up exactly; an email address through the search (name, email or phone), then compared whole
			const query =
				field === 'phone' ? `phone=${encodeURIComponent(value)}&limit=1` : `q=${encodeURIComponent(value)}&limit=10`;
			const answer = await product
				.callProduct(s.websiteId, 'accounts', `/v1/users?${query}`, { method: 'GET' })
				.catch(() => /** @type {const} */ ({ ok: false }));
			if (!answer.ok || answer.status !== 200) return false;
			const items = /** @type {any} */ (answer.body)?.items;
			return (
				Array.isArray(items) &&
				items.some((user) => String(user?.[field] ?? '').toLowerCase() === value.toLowerCase() && user?.hasPassword === true)
			);
		};
		if (phone && (await has('phone', phone))) return 'phone';
		if (email && (await has('email', email))) return 'email';
		return null;
	};

	return Object.freeze({ claim, memberWithPassword });
};

/** @typedef {ReturnType<typeof createGuests>} Guests */
