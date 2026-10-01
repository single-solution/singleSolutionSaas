/**
 * Console URLs and Portal API paths in one place (ids are URL-encoded).
 * @module
 */

const e = encodeURIComponent;

/** Console page URLs. */
export const routes = Object.freeze({
	login: (next = '') => (next ? `/login?next=${e(next)}` : '/login'),
	signup: () => '/signup',
	forgotPassword: () => '/forgot-password',
	onboarding: (websiteId = '') => (websiteId ? `/onboarding?website=${e(websiteId)}` : '/onboarding'),
	websites: () => '/websites',
	website: (/** @type {string} */ id) => `/websites/${e(id)}`,
	products: (/** @type {string} */ id) => `/websites/${e(id)}/products`,
	subscription: (/** @type {string} */ id, /** @type {string} */ sub) => `/websites/${e(id)}/subscriptions/${e(sub)}`,
	usage: (/** @type {string} */ id) => `/websites/${e(id)}/usage`,
	keys: (/** @type {string} */ id) => `/websites/${e(id)}/keys`,
	resources: (/** @type {string} */ id) => `/websites/${e(id)}/resources`,
	deliveries: (/** @type {string} */ id) => `/websites/${e(id)}/deliveries`,
	credits: () => '/credits',
	spendPolicies: () => '/spend-policies',
	team: () => '/team',
	account: () => '/account',
});

/** The website sub-pages, in tab order. */
export const WEBSITE_TABS = Object.freeze([
	{ key: 'overview', label: 'Overview', href: routes.website },
	{ key: 'products', label: 'Products', href: routes.products },
	{ key: 'usage', label: 'Usage & spend', href: routes.usage },
	{ key: 'keys', label: 'Keys', href: routes.keys },
	{ key: 'resources', label: 'Resources', href: routes.resources },
	{ key: 'deliveries', label: 'Deliveries', href: routes.deliveries },
]);

/**
 * @param {Record<string, string | number | boolean | null | undefined>} params
 */
const query = (params) => {
	const q = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
	const s = q.toString();
	return s ? `?${s}` : '';
};

/** Portal API paths used by the consoles. */
export const api = Object.freeze({
	me: () => '/v1/me',
	merchant: (/** @type {string} */ m) => `/v1/merchants/${e(m)}`,
	websites: (/** @type {string} */ m) => `/v1/merchants/${e(m)}/websites`,
	website: (/** @type {string} */ m, /** @type {string} */ w) => `/v1/merchants/${e(m)}/websites/${e(w)}`,
	keys: (/** @type {string} */ m, /** @type {string} */ w) => `/v1/merchants/${e(m)}/websites/${e(w)}/keys`,
	key: (/** @type {string} */ m, /** @type {string} */ w, /** @type {string} */ k) =>
		`/v1/merchants/${e(m)}/websites/${e(w)}/keys/${e(k)}`,
	resources: (/** @type {string} */ m, /** @type {string} */ w) => `/v1/merchants/${e(m)}/websites/${e(w)}/resources`,
	deliveries: (
		/** @type {string} */ m,
		/** @type {string} */ w,
		/** @type {{ cursor?: string | null, status?: string | null }} */ q = {},
	) => `/v1/merchants/${e(m)}/websites/${e(w)}/deliveries${query(q)}`,
	replay: (/** @type {string} */ m, /** @type {string} */ w, /** @type {string} */ d) =>
		`/v1/merchants/${e(m)}/websites/${e(w)}/deliveries/${e(d)}/replay`,
	catalog: () => '/v1/catalog/products',
	product: (/** @type {string} */ slug) => `/v1/catalog/products/${e(slug)}`,
	subscriptions: (/** @type {string} */ m, /** @type {string | null} */ websiteId = null) =>
		`/v1/merchants/${e(m)}/subscriptions${query({ websiteId })}`,
	subscribe: (/** @type {string} */ m, /** @type {string} */ w) => `/v1/merchants/${e(m)}/websites/${e(w)}/subscriptions`,
	subscription: (/** @type {string} */ m, /** @type {string} */ s) => `/v1/merchants/${e(m)}/subscriptions/${e(s)}`,
	config: (/** @type {string} */ m, /** @type {string} */ w, /** @type {string} */ s) =>
		`/v1/merchants/${e(m)}/websites/${e(w)}/subscriptions/${e(s)}/config`,
	launch: (/** @type {string} */ m, /** @type {string} */ appId) => `/v1/merchants/${e(m)}/apps/${e(appId)}/launch`,
	demo: (/** @type {string} */ m, /** @type {string} */ appId) => `/v1/merchants/${e(m)}/apps/${e(appId)}/demo`,
	balance: (/** @type {string} */ m) => `/v1/merchants/${e(m)}/balance`,
	meter: (/** @type {string} */ m) => `/v1/merchants/${e(m)}/meter`,
	statement: (
		/** @type {string} */ m,
		/** @type {{ from?: string | null, to?: string | null, websiteId?: string | null }} */ q = {},
	) => `/v1/merchants/${e(m)}/statement${query(q)}`,
	spendPolicies: (/** @type {string} */ m) => `/v1/merchants/${e(m)}/spend-policies`,
	team: (/** @type {string} */ m) => `/v1/merchants/${e(m)}/team`,
	connectors: (
		/** @type {string} */ m,
		/** @type {{ websiteId?: string | null, kind?: string | null, cursor?: string | null }} */ q = {},
	) => `/v1/merchants/${e(m)}/connectors${query(q)}`,
	connector: (/** @type {string} */ m, /** @type {string} */ c) => `/v1/merchants/${e(m)}/connectors/${e(c)}`,
});
