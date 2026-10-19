/**
 * Admin Console page loaders: the data each page needs, read through the in-process {@link ConsoleApi} with the
 * admin session cookie (public admin API only — "every UI action is an API call"). A loader resolves to
 * `{ ok: true, ... }` or `{ ok: false, status, problem }` (the first required call that failed); optional reads
 * degrade to empty values. Loaders never throw for API failures. Query-string inputs are validated here; anything malformed is ignored.
 * @module
 */
import { isId } from '@ss/contracts';
import { firstFailure, itemsOf, loadWebsiteRows, orElse } from '../loaders.js';
import { adminApi as paths, merchantFilter } from './paths.js';
import { adminCan } from './rights.js';

/** @typedef {import('../api.js').ConsoleApi} ConsoleApi */
/** @typedef {import('@ss/ui/problems').Problem} Problem */
/** @typedef {{ ok: false, status: number, problem: Problem }} LoadFailure */
/**
 * @template T
 * @typedef {import('../api.js').ApiResult<T>} ApiResult
 */

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

/** An id of the given prefix from a query string (anything else is ignored). @param {unknown} value @param {string} prefix */
const idOf = (value, prefix) => (isId(value, prefix) ? value : null);

/** @param {unknown} value @param {readonly string[]} allowed */
const oneOf = (value, allowed) => (typeof value === 'string' && allowed.includes(value) ? value : null);

const CURSOR = /^[A-Za-z0-9_=-]{1,512}$/;

/**
 * The merchants as dropdown options (`{ value: merchantId, label: name }`, the first 100 by name), plus the selected
 * one when it is not among them.
 * @param {ConsoleApi} api
 * @param {string | null} selected
 */
const merchantOptions = async (api, selected) => {
	const list = itemsOf(await api.get(paths.merchants({ limit: 100 })));
	const options = list
		.map((m) => ({ value: String(m.merchantId), label: String(m.name) }))
		.sort((a, b) => a.label.localeCompare(b.label));
	if (selected && !options.some((o) => o.value === selected)) options.push({ value: selected, label: selected });
	return options;
};

/**
 * The admins as dropdown options, for those who may list them (Owners); `null` for the others.
 * @param {ConsoleApi} api
 * @param {any} admin the signed-in admin
 */
const adminOptions = async (api, admin) =>
	adminCan(admin, 'admins.manage')
		? itemsOf(await api.get(paths.admins())).map((a) => ({
				value: String(a.adminId),
				label: String(a.name ?? a.email),
			}))
		: null;
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
 * Merchants page: search by business name, owner email or website domain (prefixes), filter by status (or Setup
 * pending), paged at 50.
 * @param {ConsoleApi} api
 * @param {{ status?: string, q?: string, cursor?: string }} [filter]
 */
export const loadMerchants = async (api, filter = {}) => {
	const list = await merchantPage(api, filter);
	return list.ok ? withBilling(api, list) : list;
};

/**
 * One page of the Merchants list (search and status filter).
 * @param {ConsoleApi} api
 * @param {{ status?: string, q?: string, cursor?: string }} filter
 */
const merchantPage = async (api, filter) => {
	const status = oneOf(filter.status, ['active', 'suspended', 'setup_pending']);
	const q = pick(filter.q?.trim(), FREE_TEXT);
	const list = await api.get(paths.merchants({ ...merchantFilter(status), q, cursor: pick(filter.cursor, CURSOR), limit: 50 }));
	const failed = firstFailure(list);
	if (failed) return failed;
	return { ok: /** @type {const} */ (true), filter: { status, q }, page: pageOf(list) };
};

/**
 * The status, balance and daily spend of the merchants on screen (each one checked, PLAN 0.6).
 * @param {ConsoleApi} api
 * @param {{ ok: true, filter: { status: string | null, q: string | null }, page: { items: any[], nextCursor: string | null } }} list
 */
const withBilling = async (api, list) => {
	const ids = list.page.items.map((m) => String(m.merchantId));
	const billing = ids.length > 0 ? itemsOf(await api.get(paths.billingMerchants(ids))) : [];
	return { ...list, billing: Object.fromEntries(billing.map((b) => [b.merchantId, b])) };
};

/**
 * The selected merchant of the Merchants screen: the merchant, its websites with their products (cards: status,
 * features on, daily cost), the billing summary (checked), receipts, day charges, activity, and the active connected
 * products that Add product offers (only for admins who add products: Owner and Support).
 * @param {ConsoleApi} api
 * @param {string} merchantId
 * @param {any} admin the signed-in admin
 */
export const loadMerchant = async (api, merchantId, admin) => {
	const manage = adminCan(admin, 'products_on_websites.write');
	const [merchant, websites, billing, receipts, dayCharges, activity, active] = await Promise.all([
		api.get(paths.merchant(merchantId)),
		loadWebsiteRows(api, merchantId),
		api.get(paths.billing(merchantId)),
		api.get(paths.receipts(merchantId)),
		api.get(paths.dayCharges(merchantId)),
		api.get(paths.merchantActivity(merchantId)),
		manage ? api.get(paths.products({ status: 'active' })) : null,
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
		addable: active ? itemsOf(active).map((p) => ({ productId: String(p.productId), name: String(p.name) })) : null,
	};
};

/** How many merchants the Overview lists. */
const OVERVIEW_MERCHANTS = 5;

/**
 * Admin Overview: the numbers (with the credits added this month, summed by the Portal), the merchants that need
 * attention (checked now) and the first merchants with their balance.
 * @param {ConsoleApi} api
 */
export const loadOverview = async (api) => {
	const [overview, attention, merchants] = await Promise.all([
		api.get(paths.overview()),
		api.get(paths.attention()),
		api.get(paths.merchants({ limit: OVERVIEW_MERCHANTS })),
	]);
	const failed = firstFailure(overview);
	if (failed) return failed;
	// the first merchants with their balance (empty when the admin may not list them)
	const firstMerchants = merchants.ok ? itemsOf(merchants).slice(0, OVERVIEW_MERCHANTS) : [];
	const billing =
		firstMerchants.length > 0 ? await api.get(paths.billingMerchants(firstMerchants.map((m) => String(m.merchantId)))) : null;
	return {
		ok: /** @type {const} */ (true),
		overview: /** @type {any} */ (overview.ok ? overview.data : null),
		attention: itemsOf(attention),
		// credits added this month (UTC), every receipt summed by the Portal
		creditsAdded: overview.ok ? Number(/** @type {any} */ (overview.data).creditsAddedThisMonth ?? 0) : null,
		merchants: firstMerchants,
		billing: Object.fromEntries((billing?.ok ? itemsOf(billing) : []).map((b) => [b.merchantId, b])),
	};
};

/**
 * Products (PLAN 0.8.2): the connected products, by name, with the websites using each and the credits it earned this
 * month (the list of the Products screen).
 * @param {ConsoleApi} api
 * @param {{ status?: string }} [filter]
 */
export const loadProducts = async (api, filter = {}) => {
	const status = oneOf(filter.status, ['active', 'inactive']);
	const list = await api.get(paths.products({ status }));
	const failed = firstFailure(list);
	if (failed) return failed;
	const items = itemsOf(list).sort((a, b) => String(a.name).localeCompare(String(b.name)));
	return { ok: /** @type {const} */ (true), filter: { status }, items };
};

/**
 * A product's page: the product (address, connected date, features with prices, numbers)
 * and the first page of its websites.
 * @param {ConsoleApi} api
 * @param {string} productId
 */
export const loadProduct = async (api, productId) => {
	const [product, websites] = await Promise.all([api.get(paths.product(productId)), api.get(paths.productWebsites(productId))]);
	const failed = firstFailure(product);
	if (failed) return failed;
	const page = /** @type {any} */ (orElse(websites, null));
	return {
		ok: /** @type {const} */ (true),
		product: /** @type {any} */ (product.ok ? product.data : null),
		websites: { items: /** @type {any[]} */ (page?.items ?? []), cursor: /** @type {string | null} */ (page?.cursor ?? null) },
		websitesProblem: websites.ok ? null : websites.problem,
	};
};

/**
 * How many merchants need attention (low, in grace or stopped), for the badge on the "Credits and billing" menu entry.
 * Only a number: a failed read shows no badge (the menu never waits on or breaks for it).
 * @param {ConsoleApi} api
 * @returns {Promise<number>}
 */
export const loadAttentionCount = async (api) => itemsOf(await api.get(paths.attention())).length;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Credits and billing (PLAN 0.8.2): all receipts (filter by merchant, UTC days, method), charges by day, merchant or
 * product, the merchants that need attention (checked now), and the merchants for the filter and Add credits.
 * @param {ConsoleApi} api
 * @param {{ merchantId?: string, from?: string, to?: string, method?: string, by?: string }} [filter]
 */
export const loadBilling = async (api, filter = {}) => {
	const merchantId = idOf(filter.merchantId, 'mer');
	const from = pick(filter.from, DAY);
	const to = pick(filter.to, DAY);
	const method = pick(filter.method?.trim(), /^[^<>]{1,60}$/);
	const by = oneOf(filter.by, ['day', 'merchant', 'product']) ?? 'day';
	const [receipts, charges, attention, merchants] = await Promise.all([
		api.get(paths.allReceipts({ merchantId, from, to, method })),
		api.get(paths.charges({ by, from, to })),
		api.get(paths.attention()),
		merchantOptions(api, merchantId),
	]);
	const failed = firstFailure(receipts);
	if (failed) return failed;
	return {
		ok: /** @type {const} */ (true),
		filter: { merchantId, from, to, method, by },
		receipts: itemsOf(receipts),
		charges: /** @type {any} */ (orElse(charges, null)),
		attention: itemsOf(attention),
		merchants,
	};
};

/**
 * Activity: newest-first entries filtered by merchant, admin and UTC days, with the merchants (and, for Owners, the
 * admins) for the filter dropdowns.
 * @param {ConsoleApi} api
 * @param {{ merchantId?: string, adminId?: string, from?: string, to?: string }} [filter]
 * @param {any} [admin] the signed-in admin
 */
export const loadActivity = async (api, filter = {}, admin = null) => {
	const day = /^\d{4}-\d{2}-\d{2}$/;
	const f = {
		merchantId: idOf(filter.merchantId, 'mer'),
		adminId: idOf(filter.adminId, 'adm'),
		from: pick(filter.from, day),
		to: pick(filter.to, day),
	};
	const [list, merchants, admins] = await Promise.all([
		api.get(paths.activity(f)),
		merchantOptions(api, f.merchantId),
		adminOptions(api, admin),
	]);
	const failed = firstFailure(list);
	if (failed) return failed;
	return { ok: /** @type {const} */ (true), filter: f, page: pageOf(list), merchants, admins };
};

/**
 * Settings (Owner): email sending, branding, support contact, security.
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
 * One admin's page: the Admins list (it holds the admin) and, on the Activity part, the first page of the entries this
 * admin made.
 * @param {ConsoleApi} api
 * @param {any} admin the signed-in admin
 * @param {string} adminId the admin of the page
 * @param {string} [part] 'details' or 'activity'
 */
export const loadAdmin = async (api, admin, adminId, part = 'details') => {
	const [base, activity] = await Promise.all([
		loadAdmins(api, admin),
		part === 'activity' ? api.get(paths.activity({ adminId })) : Promise.resolve(null),
	]);
	return base.ok && activity ? { ...base, activity: pageOf(activity) } : base;
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
