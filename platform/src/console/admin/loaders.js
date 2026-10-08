/**
 * Admin Console page loaders: the data each page needs, read through the in-process {@link ConsoleApi} with the
 * admin session cookie (public admin API only — "every UI action is an API call"). A loader resolves to
 * `{ ok: true, ... }` or `{ ok: false, status, problem }` (the first required call that failed); optional reads
 * degrade to empty values (`section(...)` keeps the problem so the page can say why a section is empty). Loaders never
 * throw for API failures. Query-string inputs are validated here; anything malformed is ignored.
 * @module
 */
import { firstFailure as anyFailure, loadWebsitePage, loadWebsiteRows } from '../loaders.js';
import { ID, adminApi as paths } from './paths.js';
import { adminCan } from './rights.js';

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
const pick = (value, pattern) => (typeof value === 'string' && pattern.test(value) ? value : null);

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
	const page = pageOf(list);
	// status, balance and daily spend of the merchants on screen (each one checked, PLAN 0.6)
	const ids = page.items.map((m) => String(m.merchantId));
	const billing = ids.length > 0 ? itemsOf(await api.get(paths.billingMerchants(ids))) : [];
	return {
		ok: /** @type {const} */ (true),
		filter: { status, q },
		page,
		billing: Object.fromEntries(billing.map((b) => [b.merchantId, b])),
	};
};

/**
 * Merchant page: the merchant, its websites with their products (chips, daily cost), the billing summary (checked),
 * receipts, day charges and activity.
 * @param {ConsoleApi} api
 * @param {string} merchantId
 */
export const loadMerchant = async (api, merchantId) => {
	const [merchant, websites, billing, receipts, dayCharges, activity] = await Promise.all([
		api.get(paths.merchant(merchantId)),
		loadWebsiteRows(api, merchantId),
		api.get(paths.billing(merchantId)),
		api.get(paths.receipts(merchantId)),
		api.get(paths.dayCharges(merchantId)),
		api.get(paths.merchantActivity(merchantId)),
	]);
	const failed = firstFailure(merchant);
	if (failed) return failed;
	return {
		ok: /** @type {const} */ (true),
		merchant: /** @type {any} */ (merchant.ok ? merchant.data : {}),
		rows: websites.rows,
		billing: /** @type {any} */ (orElse(billing, null)),
		receipts: itemsOf(receipts),
		dayCharges: itemsOf(dayCharges),
		activity: pageOf(activity),
	};
};

/**
 * The website page seen by an admin (PLAN 0.8.2): the merchant's name, the products on the website, the install blocks
 * (Owner and Support only; never Finance), the usage, and the active connected products for Add product (Owner and
 * Support).
 * @param {ConsoleApi} api
 * @param {{ merchantId: string, websiteId: string, tab?: string, admin: any }} input
 */
export const loadWebsite = async (api, { merchantId, websiteId, tab, admin }) => {
	const manage = adminCan(admin, 'products_on_websites.write');
	const [page, merchant, active] = await Promise.all([
		loadWebsitePage(api, { merchantId, websiteId, tab, tokens: adminCan(admin, 'tokens.manage') }),
		api.get(paths.merchant(merchantId)),
		manage ? api.get(paths.products({ status: 'active' })) : null,
	]);
	if (!page.ok) return page;
	const failed = anyFailure(merchant);
	if (failed) return failed;
	return {
		...page,
		merchantName: String(/** @type {any} */ (merchant.ok ? merchant.data : null)?.name ?? ''),
		addable: active ? itemsOf(active).map((p) => ({ productId: String(p.productId), name: String(p.name) })) : null,
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
 * Products (PLAN 0.8.2): the connected products with the websites using each and the credits it earned this month.
 * @param {ConsoleApi} api
 * @param {{ status?: string }} [filter]
 */
export const loadProducts = async (api, filter = {}) => {
	const status = oneOf(filter.status, ['active', 'inactive']);
	const list = await api.get(paths.products({ status }));
	const failed = firstFailure(list);
	if (failed) return failed;
	return { ok: /** @type {const} */ (true), filter: { status }, items: itemsOf(list) };
};

/**
 * A product page: the product (address, connected date, features with prices, numbers), the first page of its
 * websites, and every connected product (inner sidebar).
 * @param {ConsoleApi} api
 * @param {string} productId
 * @param {{ tab?: string }} [options]
 */
export const loadProduct = async (api, productId, { tab } = {}) => {
	const [product, websites, all] = await Promise.all([
		api.get(paths.product(productId)),
		api.get(paths.productWebsites(productId)),
		api.get(paths.products()),
	]);
	const failed = firstFailure(product);
	if (failed) return failed;
	const page = /** @type {any} */ (orElse(websites, null));
	return {
		ok: /** @type {const} */ (true),
		product: /** @type {any} */ (product.ok ? product.data : null),
		websites: { items: /** @type {any[]} */ (page?.items ?? []), cursor: /** @type {string | null} */ (page?.cursor ?? null) },
		websitesProblem: websites.ok ? null : websites.problem,
		products: itemsOf(all).map((p) => ({ productId: String(p.productId), name: String(p.name), status: String(p.status) })),
		tab: tab === 'websites' ? /** @type {const} */ ('websites') : /** @type {const} */ ('overview'),
	};
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Credits and billing (PLAN 0.8.2): all receipts (filter by merchant, UTC days, method), charges by day, merchant or
 * product, and the merchants that need attention (checked now).
 * @param {ConsoleApi} api
 * @param {{ merchantId?: string, from?: string, to?: string, method?: string, by?: string }} [filter]
 */
export const loadBilling = async (api, filter = {}) => {
	const merchantId = pick(filter.merchantId, ID.merchant);
	const from = pick(filter.from, DAY);
	const to = pick(filter.to, DAY);
	const method = pick(filter.method?.trim(), /^[^<>]{1,60}$/);
	const by = oneOf(filter.by, ['day', 'merchant', 'product']) ?? 'day';
	const [receipts, charges, attention] = await Promise.all([
		api.get(paths.allReceipts({ merchantId, from, to, method })),
		api.get(paths.charges({ by, from, to })),
		api.get(paths.attention()),
	]);
	const failed = firstFailure(receipts);
	if (failed) return failed;
	return {
		ok: /** @type {const} */ (true),
		filter: { merchantId, from, to, method, by },
		receipts: itemsOf(receipts),
		charges: /** @type {any} */ (orElse(charges, null)),
		attention: itemsOf(attention),
	};
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
