/**
 * Dashboard data (SSO pages): the same views for a live website (merchant database) and for demo launches (sandbox
 * data computed in memory with the real core — nothing is stored, nothing is published).
 */
import { addEntry, newEntry } from '../core/lists.js';
import { priceSignals } from '../core/signals.js';
import { listView, notificationView } from '../core/views.js';
import { settingsFrom } from './settings.js';

/** Rows listed per dashboard page. */
export const DASHBOARD_PAGE = 50;
/** Most saved items shown on the overview. */
export const TOP_ITEMS = 10;

/**
 * @typedef {{ lists: number, customerLists: number, guestLists: number, items: number, optedIn: number, shared: number }} Stats
 * @typedef {object} DashboardData
 * @property {boolean} demo
 * @property {string | null} websiteId
 * @property {() => Promise<{ stats: Stats, topItems: Array<{ itemId: string, title: string | null, saves: number }> }>} overview
 * @property {() => Promise<Array<ReturnType<typeof listView>>>} lists
 * @property {() => Promise<Array<ReturnType<typeof notificationView>>>} notifications
 */

/**
 * @param {{ site: import('./lists.js').Site }} input
 * @returns {DashboardData}
 */
export const liveDashboard = ({ site }) => ({
	demo: false,
	websiteId: site.websiteId,
	overview: async () => ({ stats: await site.repos.lists.stats(), topItems: await site.repos.lists.topItems(TOP_ITEMS) }),
	lists: async () =>
		(await site.repos.lists.page({ fetchLimit: DASHBOARD_PAGE })).map((/** @type {any} */ list) =>
			listView(list, { reveal: true }),
		),
	notifications: async () =>
		(await site.repos.notifications.page({ fetchLimit: DASHBOARD_PAGE })).map((/** @type {any} */ record) =>
			notificationView(record),
		),
});

/**
 * Sandbox data: a few saved items, then a price cut decided by the real signal rules.
 * @param {{ now: number }} input
 * @returns {DashboardData}
 */
export const demoDashboard = ({ now }) => {
	const settings = settingsFrom({ can: () => true, config: () => ({}) });
	const HOUR = 3_600_000;
	const sample = /** @type {const} */ ([
		['cus_demo_ava', 'itm_demo_lamp', 'Desk lamp', 4900, true],
		['cus_demo_ava', 'itm_demo_chair', 'Reading chair', 18_900, true],
		['cus_demo_ben', 'itm_demo_lamp', 'Desk lamp', 4900, false],
		['gst_demo_1', 'itm_demo_mug', 'Stoneware mug', 1500, false],
	]);
	const byOwner = new Map();
	sample.forEach(([ownerId, itemId, title, amount, notify], index) => {
		const list = byOwner.get(ownerId) ?? {
			id: `wl_demo_${byOwner.size}`,
			ownerKind: ownerId.startsWith('gst_') ? 'guest' : 'customer',
			ownerId,
			name: 'Wishlist',
			isDefault: true,
			notify,
			items: [],
			share: null,
			createdOn: new Date(now - (10 - index) * 24 * HOUR).toISOString(),
			touchedOn: new Date(now - index * HOUR).toISOString(),
		};
		const entry = newEntry(
			{ itemId, variantId: null, title, image: null, url: null, price: { amount, currency: 'EUR' } },
			{ id: `wli_demo_${index}`, now: now - (10 - index) * 24 * HOUR },
		);
		const added = addEntry(list.items, entry, { max: settings.lists.maxItems, whenFull: settings.lists.whenFull });
		byOwner.set(ownerId, { ...list, items: added.ok ? added.entries : list.items });
	});
	const all = [...byOwner.values()];
	const signals = priceSignals({
		lists: all,
		change: {
			kind: 'price',
			itemId: 'itm_demo_lamp',
			variantId: null,
			price: { amount: 3900, currency: 'EUR' },
			previousPrice: null,
		},
		settings: settings.signals,
		now,
	});
	const notifications = signals.map((signal, index) =>
		notificationView({
			id: `wln_demo_${index}`,
			kind: 'price_dropped',
			itemId: signal.entry.itemId,
			variantId: null,
			ownerId: signal.ownerId,
			listIds: signal.listIds,
			eventId: 'evt_demo',
			at: new Date(now - HOUR).toISOString(),
		}),
	);
	const counts = new Map();
	for (const list of all)
		for (const entry of list.items)
			counts.set(entry.itemId, { title: entry.title, saves: (counts.get(entry.itemId)?.saves ?? 0) + 1 });
	return {
		demo: true,
		websiteId: null,
		overview: async () => ({
			stats: {
				lists: all.length,
				customerLists: all.filter((list) => list.ownerKind === 'customer').length,
				guestLists: all.filter((list) => list.ownerKind === 'guest').length,
				items: all.reduce((sum, list) => sum + list.items.length, 0),
				optedIn: all.filter((list) => list.notify).length,
				shared: 0,
			},
			topItems: [...counts.entries()]
				.map(([itemId, value]) => ({ itemId, title: value.title, saves: value.saves }))
				.sort((a, b) => b.saves - a.saves || a.itemId.localeCompare(b.itemId)),
		}),
		lists: async () => all.map((list) => listView(list, { reveal: true, now })),
		notifications: async () => notifications,
	};
};

/**
 * @typedef {{ state: 'signin' } | { state: 'pick_website' | 'not_subscribed', session: Record<string, any> }
 *   | { state: 'ready', session: Record<string, any>, data: DashboardData }} DashboardContext
 */

/**
 * What the dashboard shows for a session (launch exchanged at `/sso`).
 * @param {{ wishlist: import('./service.js').Wishlist, sessionId: string | undefined | null, website?: string | null, now?: number }} input
 * @returns {Promise<DashboardContext>}
 */
export const resolveDashboard = async ({ wishlist, sessionId, website = null, now = Date.now() }) => {
	const { product, siteOf } = wishlist;
	const session = sessionId ? await product.launch.session(sessionId) : null;
	if (!session) return { state: 'signin' };
	if (session.role === 'demo') return { state: 'ready', session, data: demoDashboard({ now }) };
	const scope = session.scope ?? {};
	const allowed = [scope.websiteId, ...(Array.isArray(scope.websiteIds) ? scope.websiteIds : [])].filter(
		(/** @type {unknown} */ id) => typeof id === 'string' && id.length > 0,
	);
	const websiteId = website && allowed.includes(website) ? website : allowed[0];
	if (!websiteId) return { state: 'pick_website', session };
	const result = await product.entitlements.forWebsite(websiteId);
	if (!result.ok || !product.entitlements.can(result.doc, 'lists')) return { state: 'not_subscribed', session };
	return { state: 'ready', session, data: liveDashboard({ site: await siteOf(websiteId, result.doc) }) };
};
