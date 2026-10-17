/**
 * What a product knows of its website's business (`product.business(websiteId)`, `ctx.business`): the Business and
 * Region sections of the website's settings in the Portal (`website-settings.js`, `businessInfoOf`), with defaults for
 * what is not set. There is no second source: nothing is fetched from the merchant's website, and while the Portal
 * holds nothing for the website (`settingsVersion` 0: "not set yet") the answer is the defaults with `found: false`,
 * which the Overview shows as "Needs setup: set your website settings in the Portal".
 * @module
 */
import { businessInfoOf } from '@ss/contracts/website-settings';

/** @typedef {import('@ss/contracts').BusinessInfo} BusinessInfo */

/**
 * The defaults for what is not set: name = the domain, time zone UTC, no currencies, other fields empty.
 * @param {string} domain
 * @returns {BusinessInfo}
 */
const businessDefaults = (domain) => ({
	name: domain,
	logo: null,
	email: null,
	phone: null,
	address: null,
	country: null,
	timeZone: 'UTC',
	currency: null,
	currencies: [],
	language: null,
});

/**
 * @param {BusinessInfo | null} copy
 * @param {string} domain
 * @returns {BusinessInfo}
 */
const withDefaults = (copy, domain) => {
	const defaults = businessDefaults(domain);
	if (!copy) return defaults;
	return { ...defaults, ...copy, name: copy.name || defaults.name, timeZone: copy.timeZone ?? defaults.timeZone };
};

/**
 * @param {{ website: import('./website-settings.js').WebsiteSettingsCache }} options
 */
export const createBusiness = ({ website }) =>
	Object.freeze({
		/**
		 * Fetch the Portal's settings of the website again (the Overview's "Check again").
		 * @param {string} websiteId
		 */
		refresh: async (websiteId) => {
			await website.refresh(websiteId);
		},
		/**
		 * The business facts with defaults, and whether the Portal holds the website's settings (`found`).
		 * @param {string} websiteId
		 * @param {string} domain
		 * @param {{ after?: import('./website-settings.js').After }} [options] the request's `after`, for a fetch it does not wait for
		 * @returns {Promise<{ found: boolean, fetchedAt: string | null, business: BusinessInfo }>}
		 */
		get: async (websiteId, domain, options) => {
			const settings = await website.get(websiteId, options);
			return settings === null
				? { found: false, fetchedAt: null, business: withDefaults(null, domain) }
				: { found: true, fetchedAt: settings.updatedAt, business: withDefaults(businessInfoOf(settings), domain) };
		},
	});

/** @typedef {ReturnType<typeof createBusiness>} Business */
