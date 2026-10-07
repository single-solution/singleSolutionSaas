/**
 * Admin Console page loaders: the data each page needs, read through the in-process {@link ConsoleApi} with the
 * admin session cookie (public admin API only — "every UI action is an API call"). A loader resolves to
 * `{ ok: true, ... }` or `{ ok: false, status, problem }` (the first required call that failed); optional reads
 * degrade to empty values (`section(...)` keeps the problem so the page can say why a section is empty). Loaders never
 * throw for API failures. Query-string inputs are validated here; anything malformed is ignored.
 * @module
 */
import { ID, adminApi as paths } from './paths.js';

/** @typedef {import('../api.js').ConsoleApi} ConsoleApi */
/** @typedef {import('@ss/ui/problems').Problem} Problem */
/** @typedef {{ ok: false, status: number, problem: Problem }} LoadFailure */
/**
 * @template T
 * @typedef {import('../api.js').ApiResult<T>} ApiResult
 */

/**
 * @template T
 * @param {ApiResult<T>} result
 * @param {T} fallback
 * @returns {T}
 */
const orElse = (result, fallback) => (result.ok ? result.data : fallback);

/**
 * @param {...ApiResult<any>} results
 * @returns {LoadFailure | null}
 */
const firstFailure = (...results) => {
	for (const r of results) if (!r.ok) return { ok: false, status: r.status, problem: r.problem };
	return null;
};

/** @param {ApiResult<any>} r */
const itemsOf = (r) => /** @type {any[]} */ (orElse(r, { items: [] })?.items ?? []);

/** @param {ApiResult<any>} r */
const pageOf = (r) => {
	const data = /** @type {any} */ (orElse(r, null));
	return {
		items: /** @type {any[]} */ (data?.items ?? []),
		nextCursor: /** @type {string | null} */ (data?.nextCursor ?? null),
	};
};

/**
 * @param {unknown} value
 * @param {RegExp} pattern
 * @returns {string | null}
 */
export const pick = (value, pattern) => (typeof value === 'string' && pattern.test(value) ? value : null);

/** @param {unknown} value @param {readonly string[]} allowed */
const oneOf = (value, allowed) => (typeof value === 'string' && allowed.includes(value) ? value : null);

const CURSOR = /^[A-Za-z0-9_=-]{1,512}$/;
const FREE_TEXT = /^[^<>]{1,120}$/;

/**
 * The signed-in admin (console frame). A signed-in merchant gets `{ ok: false, status: 403, merchant: true }` (the page
 * sends them to the merchant console).
 * @param {ConsoleApi} api
 */
export const loadAdminSession = async (api) => {
	const me = await api.get(paths.me());
	if (!me.ok) return /** @type {LoadFailure & { merchant?: boolean }} */ ({ ok: false, status: me.status, problem: me.problem });
	if (me.data?.kind !== 'admin')
		return /** @type {LoadFailure & { merchant?: boolean }} */ ({
			ok: false,
			status: 403,
			merchant: me.data?.kind === 'merchant',
			problem: { status: 403, title: 'Forbidden', detail: 'The admin console needs an admin login.' },
		});
	return {
		ok: /** @type {const} */ (true),
		me: me.data,
		admin: /** @type {any} */ (me.data.admin),
		twoStepRequired: me.data.twoStepRequired === true,
	};
};

/**
 * Merchants page: search by business name, owner e-mail or website domain (prefixes), filter by status, paged at 50.
 * @param {ConsoleApi} api
 * @param {{ status?: string, q?: string, cursor?: string }} [filter]
 */
export const loadMerchants = async (api, filter = {}) => {
	const status = oneOf(filter.status, ['active', 'suspended']);
	const q = pick(filter.q?.trim(), FREE_TEXT);
	const list = await api.get(paths.merchants({ status, q, cursor: pick(filter.cursor, CURSOR), limit: 50 }));
	const failed = firstFailure(list);
	if (failed) return failed;
	return { ok: /** @type {const} */ (true), filter: { status, q }, page: pageOf(list) };
};

/**
 * Merchant page: the merchant, its websites with their products, balance, receipts and activity.
 * @param {ConsoleApi} api
 * @param {string} merchantId
 */
export const loadMerchant = async (api, merchantId) => {
	const [merchant, websites, subscriptions, balance, activity, catalog] = await Promise.all([
		api.get(paths.merchant(merchantId)),
		api.get(paths.websites(merchantId)),
		api.get(paths.subscriptions(merchantId)),
		api.get(paths.balance(merchantId)),
		api.get(paths.merchantActivity(merchantId)),
		api.get(paths.catalog()),
	]);
	const failed = firstFailure(merchant);
	if (failed) return failed;
	return {
		ok: /** @type {const} */ (true),
		merchant: /** @type {any} */ (merchant.ok ? merchant.data : {}),
		websites: itemsOf(websites).filter((w) => w.env === 'live'),
		subscriptions: itemsOf(subscriptions),
		balance: orElse(balance, null),
		activity: pageOf(activity),
		catalog: itemsOf(catalog),
	};
};

/**
 * Admin Overview.
 * @param {ConsoleApi} api
 */
export const loadOverview = async (api) => {
	const overview = await api.get(paths.overview());
	const failed = firstFailure(overview);
	if (failed) return failed;
	return { ok: /** @type {const} */ (true), overview: /** @type {any} */ (overview.ok ? overview.data : null) };
};

/**
 * @param {ConsoleApi} api
 * @param {{ status?: string, kind?: string, cursor?: string }} [filter]
 */
export const loadApps = async (api, filter = {}) => {
	const status = oneOf(filter.status, ['active', 'inactive']);
	const kind = oneOf(filter.kind, ['service', 'pack']);
	const list = await api.get(paths.apps({ status, kind, cursor: pick(filter.cursor, CURSOR), limit: 50 }));
	const failed = firstFailure(list);
	if (failed) return failed;
	return { ok: /** @type {const} */ (true), filter: { status, kind }, page: pageOf(list) };
};

/**
 * The current manifest of an app (null when it has none yet).
 * @param {ConsoleApi} api
 * @param {any} app
 */
const currentManifest = async (api, app) => {
	if (!app?.currentVersion) return null;
	const version = await api.get(paths.version(app.appId, app.currentVersion));
	return version.ok ? /** @type {any} */ (version.data.manifest ?? null) : null;
};

/**
 * App detail: the app and its current manifest (which elements take widgets).
 * @param {ConsoleApi} api
 * @param {string} appId
 */
export const loadApp = async (api, appId) => {
	const app = await api.get(paths.app(appId));
	const failed = firstFailure(app);
	if (failed) return failed;
	const data = /** @type {any} */ (app.ok ? app.data : null);
	return { ok: /** @type {const} */ (true), app: data, manifest: await currentManifest(api, data) };
};

/**
 * Platform policy of an app (applies to every subscription): the layer, its history, and the manifest schemas.
 * @param {ConsoleApi} api
 * @param {string} appId
 */
export const loadPolicies = async (api, appId) => {
	const [app, layer, history] = await Promise.all([
		api.get(paths.app(appId)),
		api.get(paths.platformPolicy(appId)),
		api.get(paths.platformHistory(appId)),
	]);
	const failed = firstFailure(app, layer);
	if (failed) return failed;
	const appData = /** @type {any} */ (app.ok ? app.data : null);
	return {
		ok: /** @type {const} */ (true),
		app: appData,
		layer: /** @type {any} */ (layer.ok ? layer.data : null),
		history: orElse(history, { items: [], nextCursor: null }),
		manifest: await currentManifest(api, appData),
	};
};

/**
 * A subscription seen by staff: the configuration overview (merchant, website, layers), the subscription, its
 * manifest (pinned version, feature schemas), the effective document (preview of an empty change) and the admin
 * and website histories.
 * @param {ConsoleApi} api
 * @param {string} subscriptionId
 */
export const loadSubscription = async (api, subscriptionId) => {
	const overview = await api.get(paths.adminConfig(subscriptionId));
	const failed = firstFailure(overview);
	if (failed) return failed;
	const o = /** @type {any} */ (overview.ok ? overview.data : {});
	const [subscription, app, adminHistory, websiteHistory, preview] = await Promise.all([
		api.get(paths.subscription(o.merchantId, subscriptionId)),
		api.get(paths.app(o.appId)),
		api.get(paths.adminHistory(subscriptionId, { level: 'admin' })),
		api.get(paths.adminHistory(subscriptionId, { level: 'website' })),
		api.post(paths.preview(o.merchantId, o.websiteId, subscriptionId), { change: {} }),
	]);
	const failedSub = firstFailure(subscription);
	if (failedSub) return failedSub;
	const sub = /** @type {any} */ (subscription.ok ? subscription.data.subscription : null);
	const pinned = await api.get(paths.version(o.appId, sub.manifestVersion));
	return {
		ok: /** @type {const} */ (true),
		overview: o,
		subscription: sub,
		app: orElse(app, null),
		manifest: /** @type {any} */ (pinned.ok ? (pinned.data.manifest ?? null) : null),
		effective: /** @type {any} */ (orElse(preview, { preview: null })?.preview ?? null),
		adminHistory: orElse(adminHistory, { items: [], nextCursor: null }),
		websiteHistory: orElse(websiteHistory, { items: [], nextCursor: null }),
	};
};

/**
 * Finance overview: alerts.
 * @param {ConsoleApi} api
 */
export const loadFinance = async (api) => {
	const alerts = await api.get(paths.alerts());
	const failed = firstFailure(alerts);
	if (failed) return failed;
	return { ok: /** @type {const} */ (true), alerts: itemsOf(alerts) };
};

/**
 * Ledger of one merchant (first page, ascending `seq`), balance and profile.
 * @param {ConsoleApi} api
 * @param {string} merchantId
 */
export const loadLedger = async (api, merchantId) => {
	const [merchant, balance, ledger] = await Promise.all([
		api.get(paths.merchant(merchantId)),
		api.get(paths.balance(merchantId)),
		api.get(paths.ledger(merchantId, { limit: 100 })),
	]);
	const failed = firstFailure(merchant, ledger);
	if (failed) return failed;
	return {
		ok: /** @type {const} */ (true),
		merchant: /** @type {any} */ (merchant.ok ? merchant.data : null),
		balance: orElse(balance, null),
		ledger: pageOf(ledger),
	};
};

export const CONNECTOR_KINDS = Object.freeze(['database', 'storage', 'ai', 'messaging', 'payments']);
export const CONNECTOR_STATUSES = Object.freeze(['connected', 'missing', 'failing']);

/**
 * Connector status list (never secrets: the staff view carries status and check reports only).
 * @param {ConsoleApi} api
 * @param {{ merchantId?: string, kind?: string, status?: string }} [filter]
 */
export const loadConnectors = async (api, filter = {}) => {
	const merchantId = pick(filter.merchantId, ID.merchant);
	const kind = oneOf(filter.kind, CONNECTOR_KINDS);
	const status = oneOf(filter.status, CONNECTOR_STATUSES);
	const list = await api.get(paths.connectors({ merchantId, kind, status }));
	const failed = firstFailure(list);
	if (failed) return failed;
	return { ok: /** @type {const} */ (true), filter: { merchantId, kind, status }, page: pageOf(list) };
};

/**
 * Activity: newest-first entries filtered by merchant, admin and UTC days.
 * @param {ConsoleApi} api
 * @param {{ merchantId?: string, adminId?: string, from?: string, to?: string }} [filter]
 */
export const loadActivity = async (api, filter = {}) => {
	const day = /^\d{4}-\d{2}-\d{2}$/;
	const f = {
		merchantId: pick(filter.merchantId, ID.merchant),
		adminId: pick(filter.adminId, ID.admin),
		from: pick(filter.from, day),
		to: pick(filter.to, day),
	};
	const list = await api.get(paths.activity(f));
	const failed = firstFailure(list);
	if (failed) return failed;
	return { ok: /** @type {const} */ (true), filter: f, page: pageOf(list) };
};

/**
 * Settings (Owner): e-mail sending, branding, support contact, security.
 * @param {ConsoleApi} api
 */
export const loadSettings = async (api) => {
	const settings = await api.get(paths.settings());
	const failed = firstFailure(settings);
	if (failed) return failed;
	return { ok: /** @type {const} */ (true), settings: /** @type {any} */ (settings.ok ? settings.data : null) };
};

/**
 * Admins (Owner).
 * @param {ConsoleApi} api
 * @param {any} admin the signed-in admin
 */
export const loadAdmins = async (api, admin) => {
	const list = await api.get(paths.admins());
	const failed = firstFailure(list);
	if (failed) return failed;
	return { ok: /** @type {const} */ (true), me: admin, items: itemsOf(list) };
};

/**
 * My account: the admin and their own activity.
 * @param {ConsoleApi} api
 */
export const loadMyAccount = async (api) => {
	const [me, activity] = await Promise.all([api.get(paths.me()), api.get(paths.myActivity())]);
	const failed = firstFailure(me);
	if (failed) return failed;
	return { ok: /** @type {const} */ (true), me: /** @type {any} */ (me.ok ? me.data : null), activity: pageOf(activity) };
};

/**
 * Subscription lookup by id (the configuration overview resolves its merchant and website).
 * @param {ConsoleApi} api
 * @param {{ id?: string }} [filter]
 */
export const loadSubscriptionLookup = async (api, filter = {}) => {
	const id = pick(filter.id?.trim(), ID.subscription);
	if (!id) return { ok: /** @type {const} */ (true), id: null, invalid: Boolean(filter.id), found: null };
	const overview = await api.get(paths.adminConfig(id));
	if (!overview.ok && overview.status !== 404) return /** @type {LoadFailure} */ (firstFailure(overview));
	return { ok: /** @type {const} */ (true), id, invalid: false, found: overview.ok ? overview.data : null };
};
