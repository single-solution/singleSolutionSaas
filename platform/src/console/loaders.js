/**
 * Page loaders: the data each console page needs, read through the in-process {@link ConsoleApi} (public API
 * only). A loader resolves to `{ ok: true, ... }` or `{ ok: false, status, problem }` (the first required call that
 * failed); optional reads degrade to empty values. Loaders never throw for API failures. `loadWebsiteRows` is shared
 * with the admin console (the same `/v1/merchants/…` routes).
 * @module
 */
import { isId } from '@ss/contracts';
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
export const orElse = (result, fallback) => (result.ok ? result.data : fallback);

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
export const itemsOf = (r) => /** @type {any[]} */ (orElse(r, { items: [] })?.items ?? []);

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
 * Open buttons, the latest activity and the latest credit receipts.
 * @param {ConsoleApi} api
 * @param {string} merchantId
 */
export const loadOverview = async (api, merchantId) => {
	const [billing, usage, websites, activity, receipts] = await Promise.all([
		api.get(paths.billing(merchantId)),
		api.get(paths.usage(merchantId)),
		loadWebsiteRows(api, merchantId),
		api.get(`${paths.activity(merchantId)}?limit=8`),
		api.get(paths.receipts(merchantId)),
	]);
	const failed = firstFailure(billing) ?? websites.failed;
	if (failed) return failed;
	return {
		ok: /** @type {const} */ (true),
		merchantId,
		billing: /** @type {any} */ (orElse(billing, null)),
		usage: /** @type {any} */ (orElse(usage, null)),
		rows: websites.rows,
		activity: /** @type {any[]} */ (orElse(activity, { items: [] })?.items ?? []),
		receipts: itemsOf(receipts).slice(0, 5),
	};
};

/**
 * Websites (PLAN 0.8.2 Merchant): the list-and-detail screen — every website with its products (cards), and the
 * selected one (`websiteId`, when given and the merchant's); the billing summary (checked) for the frame.
 * @param {ConsoleApi} api
 * @param {string} merchantId
 * @param {string | null} [websiteId]
 */
export const loadWebsites = async (api, merchantId, websiteId = null) => {
	const [websites, billing] = await Promise.all([loadWebsiteRows(api, merchantId), api.get(paths.billing(merchantId))]);
	if (websites.failed) return websites.failed;
	return {
		ok: /** @type {const} */ (true),
		merchantId,
		rows: websites.rows,
		selectedId: websiteId,
		billing: /** @type {any} */ (orElse(billing, null)),
	};
};

/**
 * Usage and credits (PLAN 0.8.2 Merchant): balance and days left, usage per product × website × day × feature, and
 * the credit receipts.
 * @param {ConsoleApi} api
 * @param {string} merchantId
 * @param {{ from?: string, to?: string, websiteId?: string }} [filter]
 * @param {'usage' | 'receipts'} [part] the sub-page: Receipts needs no usage, so it does not ask for it
 */
export const loadCredits = async (api, merchantId, filter = {}, part = 'usage') => {
	const from = isoDay(filter.from);
	const to = isoDay(filter.to);
	const websiteId = isId(filter.websiteId, 'web') ? filter.websiteId : null;
	const usageToo = part !== 'receipts';
	const [billing, usage, receipts, websites] = await Promise.all([
		api.get(paths.billing(merchantId)),
		usageToo ? api.get(paths.usage(merchantId, { from, to, websiteId })) : null,
		api.get(paths.receipts(merchantId)),
		usageToo ? api.get(paths.websites(merchantId)) : null,
	]);
	const failed = firstFailure(billing);
	if (failed) return failed;
	return {
		ok: /** @type {const} */ (true),
		part: /** @type {'usage' | 'receipts'} */ (usageToo ? 'usage' : 'receipts'),
		merchantId,
		billing: /** @type {any} */ (billing.ok ? billing.data : null),
		usage: /** @type {any} */ (usage ? orElse(usage, null) : null),
		usageProblem: !usage || usage.ok ? null : usage.problem,
		receipts: itemsOf(receipts),
		websites: websites ? itemsOf(websites) : [],
		filter: { from, to, websiteId },
	};
};

/**
 * Account: business details, sign-in email, two-step and own activity; the billing summary (checked) for the frame.
 * @param {ConsoleApi} api
 * @param {string} merchantId
 */
export const loadAccount = async (api, merchantId) => {
	const [me, activity, billing] = await Promise.all([
		api.get(paths.me()),
		api.get(paths.activity(merchantId)),
		api.get(paths.billing(merchantId)),
	]);
	const failed = firstFailure(me);
	if (failed) return failed;
	return {
		ok: /** @type {const} */ (true),
		merchantId,
		me: me.ok ? me.data : null,
		activity: orElse(activity, { items: [], nextCursor: null }),
		billing: /** @type {any} */ (orElse(billing, null)),
	};
};

/**
 * The Setup page of a website (both consoles): the sheet and its share links.
 * @param {ConsoleApi} api
 * @param {string} merchantId
 * @param {string} websiteId
 */
export const loadSetup = async (api, merchantId, websiteId) => {
	const [sheet, links] = await Promise.all([
		api.get(paths.setup(merchantId, websiteId)),
		api.get(paths.setupLinks(merchantId, websiteId)),
	]);
	const failed = firstFailure(sheet, links);
	if (failed) return failed;
	return { ok: /** @type {const} */ (true), sheet: sheet.ok ? sheet.data : null, links: itemsOf(links) };
};

/**
 * The Website settings page of a website (both consoles): the document with what the products need from it, and its
 * Recent changes (the list degrades to empty).
 * @param {ConsoleApi} api
 * @param {string} merchantId
 * @param {string} websiteId
 */
export const loadWebsiteSettings = async (api, merchantId, websiteId) => {
	const [settings, changes, connections] = await Promise.all([
		api.get(paths.websiteSettings(merchantId, websiteId)),
		api.get(paths.websiteSettingsChanges(merchantId, websiteId)),
		api.get(paths.websiteConnections(merchantId, websiteId)),
	]);
	const failed = firstFailure(settings);
	if (failed) return failed;
	return {
		ok: /** @type {const} */ (true),
		data: settings.ok ? settings.data : null,
		changes: itemsOf(changes),
		// what is set in Data and files, never a value (null: this person may not see it)
		connections: connections.ok ? connections.data : null,
		domain: settings.ok ? String(settings.data?.website?.domain ?? '') : '',
	};
};
