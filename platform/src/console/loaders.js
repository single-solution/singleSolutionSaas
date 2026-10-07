/**
 * Page loaders: the data each console page needs, read through the in-process {@link ConsoleApi} (public API
 * only). A loader resolves to `{ ok: true, ... }` or `{ ok: false, status, problem }` (the first required call that
 * failed); optional reads degrade to empty values. Loaders never throw for API failures. The website loaders are
 * shared with the admin console (the same `/v1/merchants/…` routes).
 * @module
 */
import { api as paths, websiteTab } from './paths.js';

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
export const firstFailure = (...results) => {
	for (const r of results) if (!r.ok) return { ok: false, status: r.status, problem: r.problem };
	return null;
};

/** @param {import('./api.js').ApiResult} r */
const itemsOf = (r) => /** @type {any[]} */ (orElse(r, { items: [] })?.items ?? []);

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
 * Frame data: the websites (switcher) and the billing summary (banners; the check runs for the merchant, PLAN 0.6).
 * @param {ConsoleApi} api
 * @param {string} merchantId
 */
export const loadFrame = async (api, merchantId) => {
	const [websites, billing] = await Promise.all([api.get(paths.websites(merchantId)), api.get(paths.billing(merchantId))]);
	return { websites: itemsOf(websites), billing: /** @type {any} */ (orElse(billing, null)) };
};

/**
 * Every website of a merchant with its products (cards: status, features on, daily cost). Removed websites and
 * products are not listed.
 * @param {ConsoleApi} api
 * @param {string} merchantId
 */
export const loadWebsiteRows = async (api, merchantId) => {
	const websites = await api.get(paths.websites(merchantId));
	if (!websites.ok) return { failed: firstFailure(websites), rows: [] };
	const list = itemsOf(websites);
	const cards = await Promise.all(list.map((w) => api.get(paths.websiteProducts(merchantId, String(w.websiteId)))));
	return {
		failed: null,
		rows: list.map((website, index) => ({
			website,
			cards: /** @type {any[]} */ (itemsOf(/** @type {import('./api.js').ApiResult} */ (cards[index]))),
		})),
	};
};

/**
 * Overview (PLAN 0.8.2 Merchant): balance and days left, the 30-day spend chart, the websites with product chips and
 * Open buttons.
 * @param {ConsoleApi} api
 * @param {string} merchantId
 */
export const loadOverview = async (api, merchantId) => {
	const [billing, usage, websites] = await Promise.all([
		api.get(paths.billing(merchantId)),
		api.get(paths.usage(merchantId)),
		loadWebsiteRows(api, merchantId),
	]);
	const failed = firstFailure(billing) ?? websites.failed;
	if (failed) return failed;
	return {
		ok: /** @type {const} */ (true),
		merchantId,
		billing: /** @type {any} */ (orElse(billing, null)),
		usage: /** @type {any} */ (orElse(usage, null)),
		rows: websites.rows,
	};
};

/**
 * Websites (PLAN 0.8.2 Merchant): the list with product chips and daily cost.
 * @param {ConsoleApi} api
 * @param {string} merchantId
 */
export const loadWebsites = async (api, merchantId) => {
	const websites = await loadWebsiteRows(api, merchantId);
	if (websites.failed) return websites.failed;
	return { ok: /** @type {const} */ (true), merchantId, rows: websites.rows };
};

/**
 * The website page (both consoles): the website, the merchant's websites (inner sidebar), the products on it, the
 * install blocks with the tokens (only when `tokens`; Finance never sees them) and its usage of the last 30 UTC days.
 * @param {ConsoleApi} api
 * @param {{ merchantId: string, websiteId: string, tab?: string, tokens: boolean }} input
 */
export const loadWebsitePage = async (api, { merchantId, websiteId, tab, tokens }) => {
	const [website, websites, cards, install, usage] = await Promise.all([
		api.get(paths.website(merchantId, websiteId)),
		api.get(paths.websites(merchantId)),
		api.get(paths.websiteProducts(merchantId, websiteId)),
		tokens ? api.get(paths.tokens(merchantId, websiteId)) : null,
		api.get(paths.usage(merchantId, { websiteId })),
	]);
	const failed = firstFailure(website, cards);
	if (failed) return failed;
	return {
		ok: /** @type {const} */ (true),
		website: /** @type {any} */ (website.ok ? website.data : null),
		websites: itemsOf(websites).map((w) => ({ websiteId: String(w.websiteId), domain: String(w.domain) })),
		cards: itemsOf(cards),
		tokens: install ? itemsOf(install) : null,
		tokensProblem: install && !install.ok ? install.problem : null,
		usage: /** @type {any} */ (orElse(usage, null)),
		usageProblem: usage.ok ? null : usage.problem,
		tab: websiteTab(tab),
	};
};

/**
 * The merchant's website page.
 * @param {ConsoleApi} api
 * @param {string} merchantId
 * @param {string} websiteId
 * @param {string} [tab]
 */
export const loadWebsite = async (api, merchantId, websiteId, tab) => {
	const [page, merchant] = await Promise.all([
		loadWebsitePage(api, { merchantId, websiteId, tab, tokens: true }),
		api.get(paths.merchant(merchantId)),
	]);
	if (!page.ok) return page;
	return { ...page, merchantName: String(orElse(merchant, null)?.name ?? '') };
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
		receipts: itemsOf(receipts),
		websites: itemsOf(websites),
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
