/**
 * Console URLs and Portal API paths in one place (ids are URL-encoded). The API paths of a merchant's records are the
 * same for the merchant console and the admin console.
 * @module
 */

const e = encodeURIComponent;

/**
 * @param {Record<string, string | number | boolean | null | undefined>} params
 */
export const query = (params) => {
	const q = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
	const s = q.toString();
	return s ? `?${s}` : '';
};

/** The tabs of the website page (PLAN 0.6, 0.8.2), in order. */
export const WEBSITE_TABS = Object.freeze(/** @type {const} */ (['products', 'install', 'usage']));

/** @typedef {(typeof WEBSITE_TABS)[number]} WebsiteTab */

/**
 * A website tab from a query string value (anything else is the first tab).
 * @param {unknown} value
 * @returns {WebsiteTab}
 */
export const websiteTab = (value) =>
	WEBSITE_TABS.includes(/** @type {WebsiteTab} */ (value)) ? /** @type {WebsiteTab} */ (value) : 'products';

/** Merchant console page URLs. */
export const routes = Object.freeze({
	login: (next = '') => (next ? `/login?next=${e(next)}` : '/login'),
	forgotPassword: () => '/forgot-password',
	overview: () => '/overview',
	websites: () => '/websites',
	website: (/** @type {string} */ id, /** @type {WebsiteTab | null} */ tab = null) =>
		`/websites/${e(id)}${query({ tab: tab === 'products' ? null : tab })}`,
	credits: () => '/credits',
	account: () => '/account',
});

/** Portal API paths used by the consoles. */
export const api = Object.freeze({
	me: () => '/v1/me',
	signOut: () => '/v1/auth/sign-out',
	merchant: (/** @type {string} */ m) => `/v1/merchants/${e(m)}`,
	websites: (/** @type {string} */ m) => `/v1/merchants/${e(m)}/websites`,
	website: (/** @type {string} */ m, /** @type {string} */ w) => `/v1/merchants/${e(m)}/websites/${e(w)}`,
	/** products on a website (cards); `POST { productId }` adds one (Owner, Support) */
	websiteProducts: (/** @type {string} */ m, /** @type {string} */ w) => `/v1/merchants/${e(m)}/websites/${e(w)}/products`,
	/** `DELETE` removes a product from a website (Owner, Support) */
	websiteProduct: (/** @type {string} */ m, /** @type {string} */ w, /** @type {string} */ p) =>
		`/v1/merchants/${e(m)}/websites/${e(w)}/products/${e(p)}`,
	/** the merchant's Open (`POST` → `{ url, expiresAt }`) */
	launch: (/** @type {string} */ m, /** @type {string} */ w, /** @type {string} */ p) =>
		`/v1/merchants/${e(m)}/websites/${e(w)}/products/${e(p)}/launch`,
	tokens: (/** @type {string} */ m, /** @type {string} */ w) => `/v1/merchants/${e(m)}/websites/${e(w)}/tokens`,
	reveal: (/** @type {string} */ m, /** @type {string} */ w, /** @type {string} */ p) =>
		`/v1/merchants/${e(m)}/websites/${e(w)}/tokens/${e(p)}/reveal`,
	regenerate: (/** @type {string} */ m, /** @type {string} */ w, /** @type {string} */ p) =>
		`/v1/merchants/${e(m)}/websites/${e(w)}/tokens/${e(p)}/regenerate`,
	billing: (/** @type {string} */ m) => `/v1/merchants/${e(m)}/billing`,
	usage: (
		/** @type {string} */ m,
		/** @type {{ from?: string | null, to?: string | null, websiteId?: string | null }} */ q = {},
	) => `/v1/merchants/${e(m)}/usage${query(q)}`,
	receipts: (/** @type {string} */ m) => `/v1/merchants/${e(m)}/receipts`,
	activity: (/** @type {string} */ m) => `/v1/merchants/${e(m)}/activity`,
	/** the admin's Open (`POST { websiteId | null }` → `{ url, expiresAt }`; null opens Defaults, Owner only) */
	adminLaunch: (/** @type {string} */ p) => `/v1/admin/products/${e(p)}/launch`,
	/** connected products (Owner, Support); `status=active` lists what Add product offers */
	products: (/** @type {{ status?: string | null }} */ q = {}) => `/v1/admin/products${query(q)}`,
});
