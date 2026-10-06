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
	dashboard: () => '/admin',
	merchants: (/** @type {{ status?: string | null, q?: string | null }} */ q = {}) => `/admin/merchants${query(q)}`,
	merchant: (/** @type {string} */ id) => `/admin/merchants/${e(id)}`,
	websites: (/** @type {{ domain?: string | null, env?: string | null }} */ q = {}) => `/admin/websites${query(q)}`,
	apps: (/** @type {{ status?: string | null, kind?: string | null }} */ q = {}) => `/admin/apps${query(q)}`,
	app: (/** @type {string} */ id) => `/admin/apps/${e(id)}`,
	version: (/** @type {string} */ id, /** @type {number | string} */ v) => `/admin/apps/${e(id)}/versions/${e(String(v))}`,
	policies: (/** @type {string} */ id) => `/admin/apps/${e(id)}/policies`,
	subscriptions: (/** @type {{ id?: string | null }} */ q = {}) => `/admin/subscriptions${query(q)}`,
	subscription: (/** @type {string} */ id) => `/admin/subscriptions/${e(id)}`,
	finance: () => '/admin/finance',
	ledger: (/** @type {string} */ merchantId) => `/admin/finance/${e(merchantId)}`,
	integration: (/** @type {{ websiteId?: string | null, appId?: string | null, status?: string | null }} */ q = {}) =>
		`/admin/integration${query(q)}`,
	connectors: (/** @type {{ merchantId?: string | null, kind?: string | null, status?: string | null }} */ q = {}) =>
		`/admin/connectors${query(q)}`,
	audit: (
		/** @type {{ scope?: string | null, actorId?: string | null, targetId?: string | null, action?: string | null }} */ q = {},
	) => `/admin/audit${query(q)}`,
	staff: () => '/admin/staff',
	settings: () => '/admin/settings',
});

/** Staff API paths. */
export const adminApi = Object.freeze({
	me: () => '/v1/me',
	whoami: () => '/v1/system/whoami',
	logout: () => '/v1/auth/staff/logout',
	login: () => '/v1/auth/staff/login',
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
	/** `POST { userId, minutes, reason }` → `{ exchangeToken, exchangePath, expiresAt }` (one-time, 60 s) */
	impersonate: (/** @type {string} */ m) => `/v1/admin/merchants/${e(m)}/impersonate`,
	/** `POST { token }` (the same staff session) → sets the merchant session cookie carrying `via` */
	impersonationExchange: () => '/v1/auth/impersonation/exchange',
	team: (/** @type {string} */ m) => `/v1/merchants/${e(m)}/team`,
	websiteLookup: (/** @type {{ domain: string, env?: string | null }} */ q) => `/v1/admin/websites${query(q)}`,
	transfer: (/** @type {string} */ w) => `/v1/admin/websites/${e(w)}/transfer`,
	staffList: () => '/v1/admin/staff',
	// system settings (kept in the database; never environment variables)
	settings: () => '/v1/admin/system/settings',
	settingsPortalUrl: () => '/v1/admin/system/settings/portal-url',
	settingsPreviewUrl: () => '/v1/admin/system/settings/preview-url',
	settingsMail: () => '/v1/admin/system/settings/mail',
	rotateKey: (/** @type {'signing' | 'website' | 'encryption'} */ kind) => `/v1/admin/system/keys/${e(kind)}/rotate`,
	staffMember: (/** @type {string} */ s) => `/v1/admin/staff/${e(s)}`,
	staffMfaReset: (/** @type {string} */ s) => `/v1/admin/staff/${e(s)}/mfa/reset`,

	// catalog
	apps: (/** @type {{ status?: string | null, kind?: string | null, cursor?: string | null, limit?: number }} */ q = {}) =>
		`/v1/admin/apps${query(q)}`,
	app: (/** @type {string} */ a) => `/v1/admin/apps/${e(a)}`,
	/** `POST { url, secret }` → `{ appId, slug, baseUrl, kid, reconnected }` (connect a service product) */
	connect: () => '/v1/admin/apps/connect',
	packs: () => '/v1/admin/packs',
	versions: (/** @type {string} */ a, /** @type {{ cursor?: string | null }} */ q = {}) =>
		`/v1/admin/apps/${e(a)}/versions${query(q)}`,
	version: (/** @type {string} */ a, /** @type {number | string} */ v) => `/v1/admin/apps/${e(a)}/versions/${e(String(v))}`,
	approve: (/** @type {string} */ a, /** @type {number | string} */ v) =>
		`/v1/admin/apps/${e(a)}/versions/${e(String(v))}/approve`,
	reject: (/** @type {string} */ a, /** @type {number | string} */ v) =>
		`/v1/admin/apps/${e(a)}/versions/${e(String(v))}/reject`,
	refresh: (/** @type {string} */ a) => `/v1/admin/apps/${e(a)}/refresh`,
	/** Staff "Retry now" for a product's queued event deliveries */
	retryDeliveries: (/** @type {string} */ a) => `/v1/admin/apps/${e(a)}/deliveries/retry`,
	lifecycle: (/** @type {string} */ a) => `/v1/admin/apps/${e(a)}/lifecycle`,
	environments: (/** @type {string} */ a) => `/v1/admin/apps/${e(a)}/environments`,
	revokeAppKey: (/** @type {string} */ a, /** @type {string} */ kid) => `/v1/admin/apps/${e(a)}/keys/${e(kid)}/revoke`,
	launch: (/** @type {string} */ a) => `/v1/admin/apps/${e(a)}/launch`,
	product: (/** @type {string} */ slug) => `/v1/catalog/products/${e(slug)}`,

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
	settlement: () => '/v1/admin/commerce/settlement',
	/** On-demand admin operation (`drain`, `audit_verify`, `connectors-health`, `catalog_refresh`, …); body `{ after? }` */
	operation: (/** @type {string} */ name) => `/v1/admin/operations/${e(name)}`,
	reconciliation: () => '/v1/admin/commerce/reconciliation',
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

	// integration
	deliveries: (
		/** @type {{ websiteId?: string | null, appId?: string | null, status?: string | null, cursor?: string | null }} */ q,
	) => `/v1/admin/deliveries${query(q)}`,
	replay: (/** @type {string} */ d) => `/v1/admin/deliveries/${e(d)}/replay`,
	deadLetters: (/** @type {{ websiteId?: string | null, appId?: string | null, cursor?: string | null }} */ q = {}) =>
		`/v1/admin/dead-letters${query(q)}`,
	metrics: (/** @type {{ websiteId?: string | null, appId?: string | null }} */ q = {}) =>
		`/v1/admin/integration/metrics${query(q)}`,

	// connectors
	connectors: (
		/** @type {{ merchantId?: string | null, kind?: string | null, status?: string | null, cursor?: string | null }} */ q = {},
	) => `/v1/admin/connectors${query(q)}`,

	// observability (system module)
	/** `{ operations: [{ name, status, lastRun }], jobs: { queued, leased, retrying, dead }, audit: { lastVerification } }` */
	health: () => '/v1/admin/system/health',
	/** newest-first audit entries `{ items, nextCursor }` */
	audit: (
		/** @type {{ scope?: string | null, actorId?: string | null, targetId?: string | null, action?: string | null,
		 *   cursor?: string | null }} */ q = {},
	) => `/v1/admin/audit${query(q)}`,
	/** `{ scope, ok, entries, seq, headHash, broken }` (infra `audit.verifyChain`) */
	auditVerification: (/** @type {string} */ scope) => `/v1/admin/audit/verification${query({ scope })}`,
});

/** Id shapes accepted from query strings (anything else is ignored). */
export const ID = Object.freeze({
	merchant: /^mer_[0-9a-z]{10,64}$/,
	website: /^web_[0-9a-z]{10,64}$/,
	app: /^app_[0-9a-z]{10,64}$/,
	subscription: /^sub_[0-9a-z]{10,64}$/,
});
