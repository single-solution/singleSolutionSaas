/**
 * Console URLs and Portal API paths in one place (ids are URL-encoded).
 * @module
 */

const e = encodeURIComponent;

/** Console page URLs. */
export const routes = Object.freeze({
	login: (next = '') => (next ? `/login?next=${e(next)}` : '/login'),
	forgotPassword: () => '/forgot-password',
	websites: () => '/websites',
	website: (/** @type {string} */ id) => `/websites/${e(id)}`,
	products: (/** @type {string} */ id) => `/websites/${e(id)}/products`,
	subscription: (/** @type {string} */ id, /** @type {string} */ sub) => `/websites/${e(id)}/subscriptions/${e(sub)}`,
	usage: (/** @type {string} */ id) => `/websites/${e(id)}/usage`,
	keys: (/** @type {string} */ id) => `/websites/${e(id)}/keys`,
	resources: (/** @type {string} */ id) => `/websites/${e(id)}/resources`,
	identity: (/** @type {string} */ id) => `/websites/${e(id)}/identity`,
	credits: () => '/credits',
	account: () => '/account',
});

/** The website sub-pages, in tab order. */
export const WEBSITE_TABS = Object.freeze([
	{ key: 'overview', label: 'Overview', href: routes.website },
	{ key: 'products', label: 'Products', href: routes.products },
	{ key: 'usage', label: 'Usage', href: routes.usage },
	{ key: 'keys', label: 'Keys', href: routes.keys },
	{ key: 'resources', label: 'Resources', href: routes.resources },
	{ key: 'identity', label: 'Identity', href: routes.identity },
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
	identity: (/** @type {string} */ m, /** @type {string} */ w) => `/v1/merchants/${e(m)}/websites/${e(w)}/identity`,
	keyScopes: (/** @type {string} */ m, /** @type {string} */ w) => `/v1/merchants/${e(m)}/websites/${e(w)}/keys/scopes`,
	notifications: (/** @type {string} */ m) => `/v1/merchants/${e(m)}/notifications`,
	snippet: (/** @type {string} */ m, /** @type {string} */ w) => `/v1/merchants/${e(m)}/websites/${e(w)}/delivery/snippet`,
	deliveryStrings: (/** @type {string} */ m, /** @type {string} */ w) =>
		`/v1/merchants/${e(m)}/websites/${e(w)}/delivery/strings`,
	deliveryString: (
		/** @type {string} */ m,
		/** @type {string} */ w,
		/** @type {string} */ appId,
		/** @type {string} */ element,
		/** @type {string} */ language,
	) => `/v1/merchants/${e(m)}/websites/${e(w)}/delivery/strings/${e(appId)}/${e(element)}/${e(language)}`,
	catalog: () => '/v1/catalog/products',
	product: (/** @type {string} */ slug) => `/v1/catalog/products/${e(slug)}`,
	subscriptions: (/** @type {string} */ m, /** @type {string | null} */ websiteId = null) =>
		`/v1/merchants/${e(m)}/subscriptions${query({ websiteId })}`,
	subscribe: (/** @type {string} */ m, /** @type {string} */ w) => `/v1/merchants/${e(m)}/websites/${e(w)}/subscriptions`,
	subscription: (/** @type {string} */ m, /** @type {string} */ s) => `/v1/merchants/${e(m)}/subscriptions/${e(s)}`,
	config: (/** @type {string} */ m, /** @type {string} */ w, /** @type {string} */ s) =>
		`/v1/merchants/${e(m)}/websites/${e(w)}/subscriptions/${e(s)}/config`,
	launch: (/** @type {string} */ m, /** @type {string} */ appId) => `/v1/merchants/${e(m)}/apps/${e(appId)}/launch`,
	billing: (/** @type {string} */ m) => `/v1/merchants/${e(m)}/billing`,
	usage: (
		/** @type {string} */ m,
		/** @type {{ from?: string | null, to?: string | null, websiteId?: string | null }} */ q = {},
	) => `/v1/merchants/${e(m)}/usage${query(q)}`,
	receipts: (/** @type {string} */ m) => `/v1/merchants/${e(m)}/receipts`,
	activity: (/** @type {string} */ m) => `/v1/merchants/${e(m)}/activity`,
	connectors: (
		/** @type {string} */ m,
		/** @type {{ websiteId?: string | null, kind?: string | null, cursor?: string | null }} */ q = {},
	) => `/v1/merchants/${e(m)}/connectors${query(q)}`,
	connector: (/** @type {string} */ m, /** @type {string} */ c) => `/v1/merchants/${e(m)}/connectors/${e(c)}`,
});
