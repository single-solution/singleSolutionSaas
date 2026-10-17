/**
 * Staff sign-ins for tests (`@ss/product-accounts/testing`): a staff member of a website is a user of Accounts with a role and
 * an open session, and a staff route of the server token (the kit's `staff.js`) wants their sign-in next to the token.
 * `staffSignIns(product, site)` makes the user on first use and signs them in the way a person would be, so a test never
 * has a sign-in Accounts itself would not issue.
 * @module
 */
import { createFlows } from './server/flows.js';
import { createService } from './server/service.js';

/**
 * @param {import('./adapters/product.js').Product} product
 * @param {{ websiteId: string, merchantId: string, domain: string, base: string }} site
 */
export const staffSignIns = (product, { websiteId, merchantId, domain, base }) => {
	const service = createService(product);
	const flows = createFlows(product, service);
	/** Staff members made for tests by the id the test used. @type {Map<string, string>} */
	const made = new Map();
	/**
	 * The sign-in of a staff member: an existing user by id, else a new one with the role (a key such as `owner`).
	 * @param {{ id?: string, name?: string, role?: string, email?: string }} [who]
	 * @returns {Promise<string>}
	 */
	return async ({ id = 'usr_test_staff', name = 'Test Staff', role = 'owner', email } = {}) => {
		const address =
			email ?? (id === 'usr_test_staff' ? 'staff@shop.example.com' : `${id.replace(/\W/g, '_')}@staff.example.com`);
		const data = await product.data.forWebsite(websiteId, { merchantId });
		const s = await service.siteOf({ websiteId, merchantId, domain, base, data });
		let user = await s.store.users.get(made.get(id) ?? id);
		if (!user) {
			user =
				(await s.store.users.create({
					...flows.blankUser(role),
					name,
					email: address,
					emailVerified: true,
					identity: 'email',
				})) ?? (await s.store.users.byEmail(address));
			if (!user) throw new Error('the test staff member could not be made');
			made.set(id, user.id);
		}
		const device = { browser: 'Tests', system: 'Tests' };
		return /** @type {string} */ ((await service.issue(s, user, { method: 'email_password', remember: false, device })).signIn);
	};
};
