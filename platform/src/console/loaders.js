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
 * Frame data: websites (switcher) and the billing summary (banners; the check runs for the merchant, PLAN 0.6).
 * @param {ConsoleApi} api
 * @param {string} merchantId
 */
export const loadFrame = async (api, merchantId) => {
	const [websites, billing, notifications] = await Promise.all([
		api.get(paths.websites(merchantId)),
		api.get(paths.billing(merchantId)),
		api.get(paths.notifications(merchantId)),
	]);
	return {
		websites: /** @type {any[]} */ (orElse(websites, { items: [] }).items ?? []),
		billing: /** @type {any} */ (orElse(billing, null)),
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
	const [{ website, catalog }, subscriptions, resources, billing, identity, snippet] = await Promise.all([
		websiteBase(api, merchantId, websiteId),
		api.get(paths.subscriptions(merchantId, websiteId)),
		api.get(paths.resources(merchantId, websiteId)),
		api.get(paths.billing(merchantId)),
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
		billing: /** @type {any} */ (orElse(billing, null)),
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
	const [{ website, catalog }, subscriptions, resources, catalogResult] = await Promise.all([
		websiteBase(api, merchantId, websiteId),
		api.get(paths.subscriptions(merchantId, websiteId)),
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
	const [website, subscription, overview, preview, history, resources] = await Promise.all([
		api.get(paths.website(merchantId, websiteId)),
		api.get(paths.subscription(merchantId, subscriptionId)),
		api.get(config),
		api.post(`${config}/preview`, { change: {} }),
		api.get(`${config}/history`),
		api.get(paths.resources(merchantId, websiteId)),
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
		resources: /** @type {any[]} */ (orElse(resources, { resources: [] }).resources ?? []),
		configProblem: overview.ok ? null : overview.problem,
	};
};

/**
 * Website → Usage (PLAN 0.5.11): the website's usage per UTC day × product × feature.
 * @param {ConsoleApi} api
 * @param {string} merchantId
 * @param {string} websiteId
 * @param {{ from?: string, to?: string }} [range] `YYYY-MM-DD` (UTC days, inclusive; default the last 30 days)
 */
export const loadUsage = async (api, merchantId, websiteId, range = {}) => {
	const from = isoDay(range.from);
	const to = isoDay(range.to);
	const [website, usage] = await Promise.all([
		api.get(paths.website(merchantId, websiteId)),
		api.get(paths.usage(merchantId, { websiteId, from, to })),
	]);
	const failed = firstFailure(website);
	if (failed) return failed;
	return {
		ok: /** @type {const} */ (true),
		merchantId,
		website: website.ok ? website.data : null,
		usage: /** @type {any} */ (orElse(usage, null)),
		usageProblem: usage.ok ? null : usage.problem,
		range: { from, to },
	};
};

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
 * Usage and credits (PLAN 0.8.2 Merchant): balance and days left, usage per product × website × day × feature, and
 * the credit receipts.
 * @param {ConsoleApi} api
 * @param {string} merchantId
 * @param {{ from?: string, to?: string, websiteId?: string }} [filter]
 */
export const loadCredits = async (api, merchantId, filter = {}) => {
	const from = isoDay(filter.from);
	const to = isoDay(filter.to);
	const websiteId =
		typeof filter.websiteId === 'string' && /^web_[0-9a-z]{10,64}$/.test(filter.websiteId) ? filter.websiteId : null;
	const [billing, usage, receipts, websites] = await Promise.all([
		api.get(paths.billing(merchantId)),
		api.get(paths.usage(merchantId, { from, to, websiteId })),
		api.get(paths.receipts(merchantId)),
		api.get(paths.websites(merchantId)),
	]);
	const failed = firstFailure(billing);
	if (failed) return failed;
	return {
		ok: /** @type {const} */ (true),
		merchantId,
		billing: /** @type {any} */ (billing.ok ? billing.data : null),
		usage: /** @type {any} */ (orElse(usage, null)),
		usageProblem: usage.ok ? null : usage.problem,
		receipts: /** @type {any[]} */ (orElse(receipts, { items: [] }).items ?? []),
		websites: /** @type {any[]} */ (orElse(websites, { items: [] }).items ?? []),
		filter: { from, to, websiteId },
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
