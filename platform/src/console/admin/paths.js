/**
 * Admin Console URLs and the staff API paths it calls (ids are URL-encoded). Every admin route lives under
 * `/admin`; the staff session is the separate `__Host-ss_staff` cookie (PLAN §11, infra auth).
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
	login: (next = '') => (next ? `/admin/login?next=${e(next)}` : '/admin/login'),
	forgotPassword: () => '/admin/forgot-password',
	merchants: (/** @type {{ status?: string | null, q?: string | null }} */ q = {}) => `/admin/merchants${query(q)}`,
	merchant: (/** @type {string} */ id) => `/admin/merchants/${e(id)}`,
	websites: (/** @type {{ domain?: string | null, env?: string | null }} */ q = {}) => `/admin/websites${query(q)}`,
	apps: (/** @type {{ status?: string | null, kind?: string | null }} */ q = {}) => `/admin/apps${query(q)}`,
	app: (/** @type {string} */ id) => `/admin/apps/${e(id)}`,
	policies: (/** @type {string} */ id) => `/admin/apps/${e(id)}/policies`,
	subscriptions: (/** @type {{ id?: string | null }} */ q = {}) => `/admin/subscriptions${query(q)}`,
	subscription: (/** @type {string} */ id) => `/admin/subscriptions/${e(id)}`,
	finance: () => '/admin/finance',
	ledger: (/** @type {string} */ merchantId) => `/admin/finance/${e(merchantId)}`,
	connectors: (/** @type {{ merchantId?: string | null, kind?: string | null, status?: string | null }} */ q = {}) =>
		`/admin/connectors${query(q)}`,
	audit: (/** @type {{ actorId?: string | null, targetId?: string | null, action?: string | null }} */ q = {}) =>
		`/admin/audit${query(q)}`,
	staff: () => '/admin/staff',
	settings: () => '/admin/settings',
	account: () => '/admin/account',
});

/** Staff API paths. */
export const adminApi = Object.freeze({
	me: () => '/v1/me',
	mePassword: () => '/v1/me/password',
	logout: () => '/v1/auth/staff/logout',
	login: () => '/v1/auth/staff/login',
	firstAdmin: () => '/v1/auth/staff/first-admin',
	mfaVerify: () => '/v1/auth/staff/mfa/verify',
	mfaEnrol: () => '/v1/auth/staff/mfa/enrol',
	mfaConfirm: () => '/v1/auth/staff/mfa/confirm',
	passwordReset: () => '/v1/auth/staff/password-reset',
	passwordResetConfirm: () => '/v1/auth/staff/password-reset/confirm',

	// identity
	merchants: (/** @type {{ status?: string | null, q?: string | null, cursor?: string | null, limit?: number }} */ q = {}) =>
		`/v1/admin/merchants${query(q)}`,
	merchant: (/** @type {string} */ m) => `/v1/admin/merchants/${e(m)}`,
	suspend: (/** @type {string} */ m) => `/v1/admin/merchants/${e(m)}/suspend`,
	resume: (/** @type {string} */ m) => `/v1/admin/merchants/${e(m)}/resume`,
	/** `GET` staff notes (newest first) / `POST { body }` (append-only) */
	notes: (/** @type {string} */ m) => `/v1/admin/merchants/${e(m)}/notes`,
	team: (/** @type {string} */ m) => `/v1/merchants/${e(m)}/team`,
	websiteLookup: (/** @type {{ domain: string, env?: string | null }} */ q) => `/v1/admin/websites${query(q)}`,
	transfer: (/** @type {string} */ w) => `/v1/admin/websites/${e(w)}/transfer`,
	staffList: () => '/v1/admin/staff',
	// system settings (kept in the database; never environment variables)
	settings: () => '/v1/admin/system/settings',
	settingsMail: () => '/v1/admin/system/settings/mail',
	staffMember: (/** @type {string} */ s) => `/v1/admin/staff/${e(s)}`,
	staffMfaReset: (/** @type {string} */ s) => `/v1/admin/staff/${e(s)}/mfa/reset`,

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
	/** newest-first audit entries `{ items, nextCursor }` */
	audit: (
		/** @type {{ actorId?: string | null, targetId?: string | null, action?: string | null, cursor?: string | null }} */ q = {},
	) => `/v1/admin/audit${query(q)}`,
});

/** Id shapes accepted from query strings (anything else is ignored). */
export const ID = Object.freeze({
	merchant: /^mer_[0-9a-z]{10,64}$/,
	website: /^web_[0-9a-z]{10,64}$/,
	app: /^app_[0-9a-z]{10,64}$/,
	subscription: /^sub_[0-9a-z]{10,64}$/,
});
