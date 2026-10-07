/**
 * Other modules commerce depends on, reached only through `ctx.service(name)` (INTERFACES.md): `identity` (merchants,
 * websites, admins, tokens) and `catalog` (connected products, notices). Notices never fail a money operation: a
 * failure to queue one is logged.
 * @module
 */

/** @typedef {import('../../../infra/modules.js').ModuleContext} ModuleContext */

/**
 * @param {ModuleContext} ctx
 */
export const createDeps = (ctx) => {
	const identity = () => ctx.service('identity');
	const catalog = () => ctx.service('catalog');

	return Object.freeze({
		/** @param {string} merchantId */
		getMerchant: (merchantId) => identity().getMerchant(merchantId),
		/** @param {string} merchantId @returns {Promise<{ merchantId: string, name: string, status: string }>} */
		getMerchantRecord: (merchantId) => identity().getMerchantRecord(merchantId),
		/** @param {string} websiteId */
		getWebsite: (websiteId) => identity().getWebsite(websiteId),
		/** @param {readonly string[]} websiteIds @returns {Promise<Map<string, { domain: string, merchantId: string, status: string }>>} */
		websitesByIds: (websiteIds) => identity().websitesByIds(websiteIds),
		/**
		 * Names of merchants (deleted ones included) by id.
		 * @param {readonly string[]} ids
		 * @returns {Promise<Map<string, { name: string, deleted: boolean }>>}
		 */
		merchantNames: (ids) => identity().merchantNames(ids),
		/**
		 * Recipients of a merchant's billing e-mails.
		 * @param {string} merchantId
		 * @returns {Promise<{ merchantName: string, merchantEmail: string | null, adminEmails: string[] }>}
		 */
		billingContacts: (merchantId) => identity().billingContacts(merchantId),
		/**
		 * A current Owner or Support admin (feature reports).
		 * @param {unknown} adminId
		 * @returns {Promise<{ adminId: string, name: string, role: 'owner' | 'support' }>}
		 */
		dashboardAdmin: (adminId) => identity().dashboardAdmin(adminId),
		/** @param {{ merchantId: string, websiteId: string, productId: string }} input */
		ensureTokens: (input) => identity().ensureTokens(input),
		/**
		 * The product's name (its id when it cannot be read).
		 * @param {string} productId
		 * @returns {Promise<string>}
		 */
		productName: async (productId) => {
			try {
				return String((await catalog().getProduct(productId)).name);
			} catch {
				return productId;
			}
		},
		/** @param {string} productId @returns {Promise<boolean>} */
		productActive: (productId) => catalog().isActive(productId),
		/**
		 * `status.changed` to a product for a website (queued and retried by catalog).
		 * @param {string} productId @param {string} websiteId
		 */
		statusChanged: async (productId, websiteId) => {
			try {
				await catalog().notify(productId, { type: 'status.changed', websiteId });
			} catch (error) {
				ctx.logger.warn('status.changed not queued', { productId, websiteId, error });
			}
		},
	});
};
/** @typedef {ReturnType<typeof createDeps>} Deps */
