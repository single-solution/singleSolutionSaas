/**
 * Admin Console URLs and the admin API paths it calls (ids are URL-encoded). Every admin route lives under `/admin`;
 * the admin session is the separate `__Host-ss_admin` cookie. Admins sign in on the one sign-in page (`/login`).
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

/** Admin Console page URLs. */
export const adminRoutes = Object.freeze({
	login: (next = '') => (next ? `/login?next=${e(next)}` : '/login'),
	overview: () => '/admin',
	merchants: (/** @type {{ status?: string | null, q?: string | null }} */ q = {}) => `/admin/merchants${query(q)}`,
	merchant: (/** @type {string} */ id, /** @type {string | null} */ tab = null) => `/admin/merchants/${e(id)}${query({ tab })}`,
	apps: (/** @type {{ status?: string | null, kind?: string | null }} */ q = {}) => `/admin/apps${query(q)}`,
	app: (/** @type {string} */ id) => `/admin/apps/${e(id)}`,
	policies: (/** @type {string} */ id) => `/admin/apps/${e(id)}/policies`,
	subscriptions: (/** @type {{ id?: string | null }} */ q = {}) => `/admin/subscriptions${query(q)}`,
	subscription: (/** @type {string} */ id) => `/admin/subscriptions/${e(id)}`,
	finance: () => '/admin/finance',
	ledger: (/** @type {string} */ merchantId) => `/admin/finance/${e(merchantId)}`,
	connectors: (/** @type {{ merchantId?: string | null, kind?: string | null, status?: string | null }} */ q = {}) =>
		`/admin/connectors${query(q)}`,
	activity: (
		/** @type {{ merchantId?: string | null, adminId?: string | null, from?: string | null, to?: string | null }} */ q = {},
	) => `/admin/activity${query(q)}`,
	admins: () => '/admin/admins',
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
	websites: (/** @type {string} */ m) => `/v1/merchants/${e(m)}/websites`,
	website: (/** @type {string} */ m, /** @type {string} */ w) => `/v1/merchants/${e(m)}/websites/${e(w)}`,
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

	// catalog
	apps: (/** @type {{ status?: string | null, kind?: string | null, cursor?: string | null, limit?: number }} */ q = {}) =>
		`/v1/admin/apps${query(q)}`,
	app: (/** @type {string} */ a) => `/v1/admin/apps/${e(a)}`,
	/** `POST { url, secret }` → `{ appId, slug, baseUrl, kid, reconnected, priceChanges? }` (connect a service product) */
	connect: () => '/v1/admin/apps/connect',
	/** `POST { descriptor }` → `{ appId, slug, kind, version, status, missing, uploadPath, changed }`; then `PUT ${uploadPath}<path>` */
	packs: () => '/v1/admin/packs',
	/** one stored manifest version `{ version, manifest, … }` (subscriptions pin one) */
	version: (/** @type {string} */ a, /** @type {number | string} */ v) => `/v1/admin/apps/${e(a)}/versions/${e(String(v))}`,
	/** Staff "Retry now" for a product's queued event deliveries */
	retryDeliveries: (/** @type {string} */ a) => `/v1/admin/apps/${e(a)}/deliveries/retry`,
	/** `POST { status: 'active' | 'inactive' }` */
	status: (/** @type {string} */ a) => `/v1/admin/apps/${e(a)}/status`,
	launch: (/** @type {string} */ a) => `/v1/admin/apps/${e(a)}/launch`,

	// commerce
	/** active products with plans, elements and prices (public) */
	catalog: () => '/v1/catalog/products',
	subscriptions: (/** @type {string} */ m) => `/v1/merchants/${e(m)}/subscriptions`,
	subscription: (/** @type {string} */ m, /** @type {string} */ s) => `/v1/merchants/${e(m)}/subscriptions/${e(s)}`,
	balance: (/** @type {string} */ m) => `/v1/merchants/${e(m)}/balance`,
	meter: (/** @type {string} */ m) => `/v1/merchants/${e(m)}/meter`,
	credit: (/** @type {string} */ m, /** @type {'credits' | 'adjustments' | 'refunds'} */ kind) =>
		`/v1/admin/merchants/${e(m)}/${kind}`,
	ledger: (/** @type {string} */ m, /** @type {{ cursor?: string | null, limit?: number }} */ q = {}) =>
		`/v1/admin/merchants/${e(m)}/ledger${query(q)}`,
	ledgerVerification: (/** @type {string} */ m) => `/v1/admin/merchants/${e(m)}/ledger/verification`,
	alerts: (/** @type {{ merchantId?: string | null }} */ q = {}) => `/v1/admin/commerce/alerts${query(q)}`,

	// config
	adminConfig: (/** @type {string} */ s) => `/v1/admin/subscriptions/${e(s)}/config`,
	adminLocks: (/** @type {string} */ s) => `/v1/admin/subscriptions/${e(s)}/config/locks`,
	adminHistory: (/** @type {string} */ s, /** @type {{ level?: string | null, cursor?: string | null }} */ q = {}) =>
		`/v1/admin/subscriptions/${e(s)}/config/history${query(q)}`,
	adminRollback: (/** @type {string} */ s) => `/v1/admin/subscriptions/${e(s)}/config/rollback`,
	preview: (/** @type {string} */ m, /** @type {string} */ w, /** @type {string} */ s) =>
		`/v1/merchants/${e(m)}/websites/${e(w)}/subscriptions/${e(s)}/config/preview`,
	platformPolicy: (/** @type {string} */ a) => `/v1/admin/config/platform/${e(a)}`,
	platformHistory: (/** @type {string} */ a, /** @type {{ cursor?: string | null }} */ q = {}) =>
		`/v1/admin/config/platform/${e(a)}/history${query(q)}`,
	platformRollback: (/** @type {string} */ a) => `/v1/admin/config/platform/${e(a)}/rollback`,

	// connectors
	connectors: (
		/** @type {{ merchantId?: string | null, kind?: string | null, status?: string | null, cursor?: string | null }} */ q = {},
	) => `/v1/admin/connectors${query(q)}`,

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
	website: /^web_[0-9a-z]{10,64}$/,
	app: /^app_[0-9a-z]{10,64}$/,
	subscription: /^sub_[0-9a-z]{10,64}$/,
});
