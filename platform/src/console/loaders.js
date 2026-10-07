/**
 * Page loaders: the data each console page needs, read through the in-process {@link ConsoleApi} (public API
 * only). A loader resolves to `{ ok: true, ... }` or `{ ok: false, status, problem }` (the first required call that
 * failed); optional reads degrade to empty values. Loaders never throw for API failures.
 * @module
 */
import { api as paths } from './paths.js';

/** @typedef {import('./api.js').ConsoleApi} ConsoleApi */
/** @typedef {import('@ss/ui/problems').Problem} Problem */
/** @typedef {{ ok: false, status: number, problem: Problem }} LoadFailure */

/**
 * @template T
 * @param {import('./api.js').ApiResult<T>} result
 * @param {T} fallback
 * @returns {T}
 */
const orElse = (result, fallback) => (result.ok ? result.data : fallback);

/**
 * First failure among required results.
 * @param {...import('./api.js').ApiResult} results
 * @returns {LoadFailure | null}
 */
const firstFailure = (...results) => {
	for (const r of results) if (!r.ok) return { ok: false, status: r.status, problem: r.problem };
	return null;
};

/**
 * @param {string | undefined} value
 */
const isoDay = (value) => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null);

/**
 * Session of the signed-in merchant (the console frame). A signed-in admin gets `{ ok: false, status: 403, admin: true }`
 * (the page sends them to the admin console).
 * @param {ConsoleApi} api
 */
export const loadSession = async (api) => {
	const me = await api.get(paths.me());
	if (!me.ok) return /** @type {LoadFailure & { admin?: boolean }} */ ({ ok: false, status: me.status, problem: me.problem });
	if (me.data?.kind !== 'merchant')
		return /** @type {LoadFailure & { admin?: boolean }} */ ({
			ok: false,
			status: 403,
			admin: me.data?.kind === 'admin',
			problem: { status: 403, title: 'Forbidden', detail: 'The merchant console needs a merchant login.' },
		});
	return {
		ok: /** @type {const} */ (true),
		me: me.data,
		merchantId: /** @type {string} */ (me.data.merchant?.merchantId),
	};
};

/**
 * Frame data: websites (switcher) and the meter (low-balance banner).
 * @param {ConsoleApi} api
 * @param {string} merchantId
 */
export const loadFrame = async (api, merchantId) => {
	const [websites, meter, notifications] = await Promise.all([
		api.get(paths.websites(merchantId)),
		api.get(paths.meter(merchantId)),
		api.get(paths.notifications(merchantId)),
	]);
	return {
		websites: /** @type {any[]} */ (orElse(websites, { items: [] }).items ?? []),
		meter: orElse(meter, null),
		// F.16: pending actions such as a product asking to become a website's identity issuer
		notifications: /** @type {any[]} */ (orElse(notifications, { items: [] }).items ?? []),
	};
};

/**
 * @param {ConsoleApi} api
 * @param {string} merchantId
 */
export const loadWebsites = async (api, merchantId) => {
	const [websites, subscriptions] = await Promise.all([
		api.get(paths.websites(merchantId)),
		api.get(paths.subscriptions(merchantId)),
	]);
	const failed = firstFailure(websites);
	if (failed) return failed;
	return {
		ok: /** @type {const} */ (true),
		merchantId,
		websites: /** @type {any[]} */ (websites.ok ? websites.data.items : []),
		subscriptions: /** @type {any[]} */ (orElse(subscriptions, { items: [] }).items ?? []),
	};
};

/**
 * Website plus the catalog (product names) — shared by every website page.
 * @param {ConsoleApi} api
 * @param {string} merchantId
 * @param {string} websiteId
 */
const websiteBase = async (api, merchantId, websiteId) => {
	const [website, catalog] = await Promise.all([api.get(paths.website(merchantId, websiteId)), api.get(paths.catalog())]);
	return { website, catalog: /** @type {any[]} */ (orElse(catalog, { items: [] }).items ?? []) };
};

/**
 * @param {ConsoleApi} api
 * @param {string} merchantId
 * @param {string} websiteId
 */
export const loadWebsiteOverview = async (api, merchantId, websiteId) => {
	const [{ website, catalog }, subscriptions, resources, meter, identity, snippet] = await Promise.all([
		websiteBase(api, merchantId, websiteId),
		api.get(paths.subscriptions(merchantId, websiteId)),
		api.get(paths.resources(merchantId, websiteId)),
		api.get(paths.meter(merchantId)),
		api.get(paths.identity(merchantId, websiteId)),
		api.get(paths.snippet(merchantId, websiteId)),
	]);
	const failed = firstFailure(website);
	if (failed) return failed;
	return {
		ok: /** @type {const} */ (true),
		merchantId,
		website: website.ok ? website.data : null,
		catalog,
		subscriptions: /** @type {any[]} */ (orElse(subscriptions, { items: [] }).items ?? []),
		resources: /** @type {any[]} */ (orElse(resources, { resources: [] }).resources ?? []),
		meter: orElse(meter, null),
		// F.16: a product's pending request to become the identity issuer (shown as a notice)
		issuerRequest: /** @type {any} */ (identity.ok ? (identity.data?.request ?? null) : null),
		// the install code (404 until the website has a compiled bundle)
		snippet: /** @type {any} */ (orElse(snippet, null)),
	};
};

/**
 * @param {ConsoleApi} api
 * @param {string} merchantId
 * @param {string} websiteId
 */
export const loadProducts = async (api, merchantId, websiteId) => {
	const [{ website, catalog }, subscriptions, balance, resources, catalogResult] = await Promise.all([
		websiteBase(api, merchantId, websiteId),
		api.get(paths.subscriptions(merchantId, websiteId)),
		api.get(paths.balance(merchantId)),
		api.get(paths.resources(merchantId, websiteId)),
		api.get(paths.catalog()),
	]);
	const failed = firstFailure(website, catalogResult);
	if (failed) return failed;
	return {
		ok: /** @type {const} */ (true),
		merchantId,
		website: website.ok ? website.data : null,
		catalog,
		subscriptions: /** @type {any[]} */ (orElse(subscriptions, { items: [] }).items ?? []),
		balanceMillicredits: /** @type {number | null} */ (orElse(balance, { balanceMillicredits: null }).balanceMillicredits),
		resources: /** @type {any[]} */ (orElse(resources, { resources: [] }).resources ?? []),
	};
};

/**
 * Everything the subscription detail needs. The effective configuration (values, sources, locks, clamping) is the
 * entitlement-document preview of an empty change.
 * @param {ConsoleApi} api
 * @param {string} merchantId
 * @param {string} websiteId
 * @param {string} subscriptionId
 */
export const loadSubscription = async (api, merchantId, websiteId, subscriptionId) => {
	const config = paths.config(merchantId, websiteId, subscriptionId);
	const [website, subscription, overview, preview, history, meter, resources, balance] = await Promise.all([
		api.get(paths.website(merchantId, websiteId)),
		api.get(paths.subscription(merchantId, subscriptionId)),
		api.get(config),
		api.post(`${config}/preview`, { change: {} }),
		api.get(`${config}/history`),
		api.get(paths.meter(merchantId)),
		api.get(paths.resources(merchantId, websiteId)),
		api.get(paths.balance(merchantId)),
	]);
	const failed = firstFailure(website, subscription);
	if (failed) return failed;
	const sub = /** @type {any} */ (subscription.ok ? subscription.data.subscription : null);
	if (sub && sub.websiteId !== websiteId)
		return /** @type {LoadFailure} */ ({
			ok: false,
			status: 404,
			problem: { status: 404, title: 'Not found', detail: 'This subscription belongs to another website.' },
		});
	const product = await api.get(paths.product(sub.productSlug));
	return {
		ok: /** @type {const} */ (true),
		merchantId,
		website: website.ok ? website.data : null,
		subscription: sub,
		product: orElse(product, null),
		overview: orElse(overview, null),
		effective: /** @type {any} */ (orElse(preview, { preview: null }).preview ?? null),
		history: orElse(history, { items: [], nextCursor: null }),
		meterLine: /** @type {any} */ (
			(orElse(meter, { subscriptions: [] }).subscriptions ?? []).find(
				(/** @type {any} */ l) => l.subscriptionId === subscriptionId,
			) ?? null
		),
		resources: /** @type {any[]} */ (orElse(resources, { resources: [] }).resources ?? []),
		balanceMillicredits: /** @type {number | null} */ (orElse(balance, { balanceMillicredits: null }).balanceMillicredits),
		configProblem: overview.ok ? null : overview.problem,
	};
};

/**
 * @param {ConsoleApi} api
 * @param {string} merchantId
 * @param {string} websiteId
 * @param {{ from?: string, to?: string }} [range] `YYYY-MM-DD` (UTC days; `to` inclusive)
 */
export const loadUsage = async (api, merchantId, websiteId, range = {}) => {
	const from = isoDay(range.from);
	const to = isoDay(range.to);
	const [{ website, catalog }, meter, statement, subscriptions] = await Promise.all([
		websiteBase(api, merchantId, websiteId),
		api.get(paths.meter(merchantId)),
		api.get(paths.statement(merchantId, { websiteId, from, to: to ? nextDay(to) : null })),
		api.get(paths.subscriptions(merchantId, websiteId)),
	]);
	const failed = firstFailure(website);
	if (failed) return failed;
	return {
		ok: /** @type {const} */ (true),
		merchantId,
		website: website.ok ? website.data : null,
		catalog,
		meter: orElse(meter, null),
		statement: orElse(statement, null),
		statementProblem: statement.ok ? null : statement.problem,
		subscriptions: /** @type {any[]} */ (orElse(subscriptions, { items: [] }).items ?? []),
		range: { from, to },
	};
};

/** @param {string} day */
const nextDay = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/**
 * @param {ConsoleApi} api
 * @param {string} merchantId
 * @param {string} websiteId
 */
export const loadKeys = async (api, merchantId, websiteId) => {
	const [website, keys, scopes] = await Promise.all([
		api.get(paths.website(merchantId, websiteId)),
		api.get(paths.keys(merchantId, websiteId)),
		api.get(paths.keyScopes(merchantId, websiteId)),
	]);
	const failed = firstFailure(website, keys);
	if (failed) return failed;
	return {
		ok: /** @type {const} */ (true),
		merchantId,
		website: website.ok ? website.data : null,
		keys: /** @type {any[]} */ (keys.ok ? keys.data.items : []),
		// F.16: the scope vocabulary (platform scopes + per listed service product)
		scopes: /** @type {any[]} */ (orElse(scopes, { items: [] }).items ?? []),
	};
};

/**
 * Website settings → Identity: the website's own customer identity issuer (bring-your-own identity).
 * @param {ConsoleApi} api
 * @param {string} merchantId
 * @param {string} websiteId
 */
export const loadIdentity = async (api, merchantId, websiteId) => {
	const [website, identity] = await Promise.all([
		api.get(paths.website(merchantId, websiteId)),
		api.get(paths.identity(merchantId, websiteId)),
	]);
	const failed = firstFailure(website, identity);
	if (failed) return failed;
	return {
		ok: /** @type {const} */ (true),
		merchantId,
		website: website.ok ? website.data : null,
		issuer: /** @type {any} */ (identity.ok ? (identity.data?.issuer ?? null) : null),
		request: /** @type {any} */ (identity.ok ? (identity.data?.request ?? null) : null),
	};
};

/**
 * @param {ConsoleApi} api
 * @param {string} merchantId
 * @param {string} websiteId
 */
export const loadResources = async (api, merchantId, websiteId) => {
	const [{ website, catalog }, resources, connectors, websites, subscriptions] = await Promise.all([
		websiteBase(api, merchantId, websiteId),
		api.get(paths.resources(merchantId, websiteId)),
		api.get(paths.connectors(merchantId)),
		api.get(paths.websites(merchantId)),
		api.get(paths.subscriptions(merchantId, websiteId)),
	]);
	const failed = firstFailure(website, connectors);
	if (failed) return failed;
	return {
		ok: /** @type {const} */ (true),
		merchantId,
		website: website.ok ? website.data : null,
		catalog,
		resources: /** @type {any[]} */ (orElse(resources, { resources: [] }).resources ?? []),
		needs: /** @type {any[] | null} */ (orElse(resources, { needs: null }).needs ?? null),
		connectors: /** @type {any[]} */ (connectors.ok ? connectors.data.items : []),
		connectorsCursor: /** @type {string | null} */ (connectors.ok ? (connectors.data.nextCursor ?? null) : null),
		websites: /** @type {any[]} */ (orElse(websites, { items: [] }).items ?? []),
		subscriptions: /** @type {any[]} */ (orElse(subscriptions, { items: [] }).items ?? []),
	};
};

/**
 * @param {ConsoleApi} api
 * @param {string} merchantId
 * @param {{ from?: string, to?: string, websiteId?: string }} [filter]
 */
export const loadCredits = async (api, merchantId, filter = {}) => {
	const from = isoDay(filter.from);
	const to = isoDay(filter.to);
	const websiteId =
		typeof filter.websiteId === 'string' && /^web_[0-9a-z]{10,64}$/.test(filter.websiteId) ? filter.websiteId : null;
	const [balance, meter, statement, websites, catalog] = await Promise.all([
		api.get(paths.balance(merchantId)),
		api.get(paths.meter(merchantId)),
		api.get(paths.statement(merchantId, { from, to: to ? nextDay(to) : null, websiteId })),
		api.get(paths.websites(merchantId)),
		api.get(paths.catalog()),
	]);
	const failed = firstFailure(balance);
	if (failed) return failed;
	return {
		ok: /** @type {const} */ (true),
		merchantId,
		balance: balance.ok ? balance.data : null,
		meter: orElse(meter, null),
		statement: orElse(statement, null),
		statementProblem: statement.ok ? null : statement.problem,
		websites: /** @type {any[]} */ (orElse(websites, { items: [] }).items ?? []),
		catalog: /** @type {any[]} */ (orElse(catalog, { items: [] }).items ?? []),
		filter: { from, to, websiteId },
	};
};

/**
 * @param {ConsoleApi} api
 * @param {string} merchantId
 */
export const loadSpendCap = async (api, merchantId) => {
	const [cap, meter] = await Promise.all([api.get(paths.spendCap(merchantId)), api.get(paths.meter(merchantId))]);
	const failed = firstFailure(cap);
	if (failed) return failed;
	return {
		ok: /** @type {const} */ (true),
		merchantId,
		cap: /** @type {any} */ (cap.ok ? cap.data : null),
		meter: orElse(meter, null),
	};
};

/**
 * Account: business details, sign-in e-mail, two-step and own activity.
 * @param {ConsoleApi} api
 * @param {string} merchantId
 */
export const loadAccount = async (api, merchantId) => {
	const [me, activity] = await Promise.all([api.get(paths.me()), api.get(paths.activity(merchantId))]);
	const failed = firstFailure(me);
	if (failed) return failed;
	return {
		ok: /** @type {const} */ (true),
		merchantId,
		me: me.ok ? me.data : null,
		activity: orElse(activity, { items: [], nextCursor: null }),
	};
};
