/**
 * Admin Console URLs and the admin API paths it calls (ids are URL-encoded). Every admin route lives under `/admin`;
 * the admin session is the separate `__Host-ss_admin` cookie. Admins sign in on the one sign-in page (`/login`).
 * @module
 */

import { api, query } from '../paths.js';

const e = encodeURIComponent;

export { query };

/** Admin Console page URLs. */
export const adminRoutes = Object.freeze({
	login: (next = '') => (next ? `/login?next=${e(next)}` : '/login'),
	overview: () => '/admin',
	/** the Merchants screen with nothing selected; `q` and `status` filter its list */
	merchants: (/** @type {{ status?: string | null, q?: string | null }} */ q = {}) => `/admin/merchants${query(q)}`,
	/** the Merchants screen with a merchant selected (the list keeps its filter) */
	merchant: (/** @type {string} */ id, /** @type {{ status?: string | null, q?: string | null }} */ q = {}) =>
		`/admin/merchants/${e(id)}${query(q)}`,
	/** a website card on its merchant's page */
	website: (/** @type {string} */ m, /** @type {string} */ w) => `/admin/merchants/${e(m)}#website-${e(w)}`,
	products: (/** @type {{ status?: string | null }} */ q = {}) => `/admin/products${query(q)}`,
	product: (/** @type {string} */ id, /** @type {{ status?: string | null }} */ q = {}) => `/admin/products/${e(id)}${query(q)}`,
	finance: (
		/** @type {{ merchantId?: string | null, from?: string | null, to?: string | null, method?: string | null, by?: string | null }} */ q = {},
	) => `/admin/finance${query(q)}`,
	activity: (
		/** @type {{ merchantId?: string | null, adminId?: string | null, from?: string | null, to?: string | null }} */ q = {},
	) => `/admin/activity${query(q)}`,
	admins: () => '/admin/admins',
	admin: (/** @type {string} */ id) => `/admin/admins/${e(id)}`,
	settings: () => '/admin/settings',
	account: () => '/admin/account',
});

/** Admin API paths. */
export const adminApi = Object.freeze({
	me: () => '/v1/me',
	signOut: () => '/v1/auth/sign-out',
	myActivity: () => '/v1/me/activity',
	overview: () => '/v1/admin/overview',

	// identity
	merchants: (/** @type {{ status?: string | null, q?: string | null, cursor?: string | null, limit?: number }} */ q = {}) =>
		`/v1/admin/merchants${query(q)}`,
	merchant: (/** @type {string} */ m) => `/v1/admin/merchants/${e(m)}`,
	/** `POST { name, ownerName, email, phone?, address?, country? }` → `{ merchant, setup: { link, expiresAt, mailed } }` */
	createMerchant: () => '/v1/admin/merchants',
	bulk: () => '/v1/admin/merchants/bulk',
	suspend: (/** @type {string} */ m) => `/v1/admin/merchants/${e(m)}/suspend`,
	resume: (/** @type {string} */ m) => `/v1/admin/merchants/${e(m)}/resume`,
	/** `POST { copy? }` → `{ link (copy only), expiresAt, mailed }` */
	setupLink: (/** @type {string} */ m) => `/v1/admin/merchants/${e(m)}/setup-link`,
	merchantTwoStepOff: (/** @type {string} */ m) => `/v1/admin/merchants/${e(m)}/two-step/off`,
	merchantActivity: (/** @type {string} */ m) => `/v1/merchants/${e(m)}/activity`,
	admins: () => '/v1/admin/admins',
	admin: (/** @type {string} */ a) => `/v1/admin/admins/${e(a)}`,
	adminInvite: (/** @type {string} */ a) => `/v1/admin/admins/${e(a)}/invite`,
	adminTwoStepOff: (/** @type {string} */ a) => `/v1/admin/admins/${e(a)}/two-step/off`,
	// settings (kept in the database; never environment variables)
	settings: () => '/v1/admin/settings',
	settingsMail: () => '/v1/admin/settings/mail',
	settingsMailTest: () => '/v1/admin/settings/mail/test',
	settingsBranding: () => '/v1/admin/settings/branding',
	settingsLogo: () => '/v1/admin/settings/branding/logo',
	settingsSupport: () => '/v1/admin/settings/support',
	settingsSecurity: () => '/v1/admin/settings/security',
	settingsBilling: () => '/v1/admin/settings/billing',

	// catalog: connected products (PLAN 0.8.2 Products)
	products: (/** @type {{ status?: string | null }} */ q = {}) => api.products(q),
	product: (/** @type {string} */ p) => `/v1/admin/products/${e(p)}`,
	/** `GET ?cursor=` → `{ items, cursor }` (merchant, domain, features on, daily cost) */
	productWebsites: (/** @type {string} */ p, /** @type {string | null} */ cursor = null) =>
		`/v1/admin/products/${e(p)}/websites${query({ cursor })}`,
	/** `POST { url, secret }` → 201 `{ product }` (Add product; new products are inactive) */
	connect: () => '/v1/admin/products',
	/** `POST { url?, secret }` → `{ product }` */
	reconnect: (/** @type {string} */ p) => `/v1/admin/products/${e(p)}/reconnect`,
	/** `POST { status: 'active' | 'inactive' }` → `{ product }` */
	productStatus: (/** @type {string} */ p) => `/v1/admin/products/${e(p)}/status`,
	launch: (/** @type {string} */ p) => api.adminLaunch(p),

	// commerce
	billing: (/** @type {string} */ m) => `/v1/merchants/${e(m)}/billing`,
	receipts: (/** @type {string} */ m) => `/v1/merchants/${e(m)}/receipts`,
	addReceipt: (/** @type {string} */ m) => `/v1/admin/merchants/${e(m)}/receipts`,
	dayCharges: (/** @type {string} */ m) => `/v1/admin/merchants/${e(m)}/day-charges`,
	billingMerchants: (/** @type {readonly string[]} */ ids) => `/v1/admin/billing/merchants${query({ ids: ids.join(',') })}`,
	attention: () => '/v1/admin/billing/attention',
	allReceipts: (
		/** @type {{ merchantId?: string | null, from?: string | null, to?: string | null, method?: string | null }} */ q = {},
	) => `/v1/admin/billing/receipts${query(q)}`,
	charges: (/** @type {{ by?: string | null, from?: string | null, to?: string | null }} */ q = {}) =>
		`/v1/admin/billing/charges${query(q)}`,

	// system
	/** newest-first Activity entries `{ items, nextCursor }` */
	activity: (
		/** @type {{ merchantId?: string | null, adminId?: string | null, from?: string | null, to?: string | null, cursor?: string | null }} */ q = {},
	) => `/v1/admin/activity${query(q)}`,
});

/** Id shapes accepted from query strings (anything else is ignored). */
export const ID = Object.freeze({
	merchant: /^mer_[0-9a-z]{10,64}$/,
	admin: /^adm_[0-9a-z]{10,64}$/,
});
