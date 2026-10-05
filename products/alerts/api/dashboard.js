/**
 * Dashboard data (SSO pages): the same views for a live website (merchant database) and for demo launches (sandbox
 * data computed in memory with the real core — nothing is stored, nothing is sent).
 */
import { summarize } from '../core/analytics.js';
import { DAY_MS, iso } from '../core/time.js';
import { shouldFire } from '../core/types.js';
import { newSubscription } from '../core/subscription.js';
import { messageView, subscriptionView } from '../core/views.js';
import { analyticsOf } from './analytics.js';
import { settingsFrom } from './settings.js';

/** Rows listed per dashboard page. */
export const DASHBOARD_PAGE = 50;

/**
 * @typedef {object} DashboardData
 * @property {boolean} demo
 * @property {string | null} websiteId
 * @property {number} windowDays
 * @property {() => Promise<{ active: number, analytics: ReturnType<typeof summarize> }>} overview
 * @property {() => Promise<Array<ReturnType<typeof subscriptionView>>>} subscriptions
 * @property {() => Promise<Array<ReturnType<typeof messageView>>>} messages
 */

/**
 * @param {{ site: import('./service.js').Site, now: () => number }} input
 * @returns {DashboardData}
 */
export const liveDashboard = ({ site, now }) => ({
	demo: false,
	websiteId: site.websiteId,
	windowDays: site.settings.analytics.defaultDays,
	overview: async () => ({
		active: await site.repos.subscriptions.countActive(),
		analytics: await analyticsOf(site, site.settings.analytics.defaultDays, now()),
	}),
	subscriptions: async () =>
		(await site.repos.subscriptions.list({ fetchLimit: DASHBOARD_PAGE })).map((/** @type {any} */ sub) =>
			subscriptionView(sub),
		),
	messages: async () => (await site.repos.messages.list({ fetchLimit: DASHBOARD_PAGE })).map(messageView),
});

/**
 * Sandbox data: sample sign-ups, then a restock and a price cut decided by the real type rules.
 * @param {{ now: number }} input
 * @returns {DashboardData}
 */
export const demoDashboard = ({ now }) => {
	const settings = settingsFrom({ can: () => true, config: () => ({}) });
	const sample = [
		['back_in_stock', 'itm_demo_phone', 'email', { email: 'ava@example.com' }, 9],
		['back_in_stock', 'itm_demo_phone', 'sms', { phone: '+447700900123' }, 6],
		['price_drop', 'itm_demo_watch', 'email', { email: 'ben@example.com' }, 4],
		['back_in_stock', 'itm_demo_case', 'whatsapp', { phone: '+5511987654321' }, 1],
	];
	const subscriptions = sample.map(([type, itemId, channel, address, daysAgo], index) =>
		newSubscription({
			id: `als_demo_${index}`,
			type: /** @type {string} */ (type),
			target: { itemId: /** @type {string} */ (itemId) },
			channel: /** @type {any} */ (channel),
			address: /** @type {any} */ (address),
			contactKey: `ck_demo_${index}`,
			customerId: null,
			lang: 'en',
			tier: null,
			rank: 0,
			threshold: null,
			priceAtSubscribe: type === 'price_drop' ? { amount: 25_000, currency: 'EUR' } : null,
			item: { name: String(itemId).replace('itm_demo_', 'Demo ') },
			consent: { given: true, textVersion: null },
			source: 'widget',
			confirm: false,
			now: now - Number(daysAgo) * DAY_MS,
			pendingDays: settings.types.pendingDays,
			confirmHours: settings.capture.confirmHours,
		}),
	);
	const changes = {
		itm_demo_phone: { before: { quantity: 0, available: false }, after: { quantity: 4, available: true } },
		itm_demo_watch: {
			before: { quantity: 3, available: true, price: { amount: 25_000, currency: 'EUR' } },
			after: { quantity: 3, available: true, price: { amount: 19_900, currency: 'EUR' } },
		},
		itm_demo_case: { before: { quantity: 0, available: false }, after: { quantity: 0, available: false } },
	};
	const decided = subscriptions.map((sub) => {
		const change = changes[/** @type {keyof typeof changes} */ (sub.target.itemId)];
		const fired = shouldFire(sub, change.before, change.after, settings.types);
		return fired ? { ...sub, status: /** @type {const} */ ('notified'), notifiedAt: iso(now - DAY_MS) } : sub;
	});
	const messages = decided
		.filter((sub) => sub.status === 'notified')
		.map((sub, index) => ({
			id: `alm_demo_${index}`,
			kind: 'alert',
			channel: sub.channel,
			to: sub.address,
			lang: sub.lang,
			status: 'sent',
			items: [{ subscriptionId: sub.id, type: sub.type, itemId: sub.target.itemId }],
			attempts: 1,
			sentAt: sub.notifiedAt,
			queuedAt: sub.notifiedAt,
		}));
	const days = Array.from({ length: settings.analytics.defaultDays }, (_, index) =>
		iso(now - (settings.analytics.defaultDays - 1 - index) * DAY_MS).slice(0, 10),
	);
	return {
		demo: true,
		websiteId: null,
		windowDays: settings.analytics.defaultDays,
		overview: async () => ({
			active: decided.filter((sub) => sub.status === 'pending').length,
			analytics: summarize({
				from: iso(now - settings.analytics.defaultDays * DAY_MS),
				to: iso(now),
				subscriptions: decided.map((sub) => ({ type: sub.type, status: sub.status, count: 1 })),
				messages: messages.map((m) => ({ channel: m.channel, status: 'sent', count: 1, alerts: 1 })),
				daily: [],
				days,
			}),
		}),
		subscriptions: async () => decided.map((sub) => subscriptionView(sub)),
		messages: async () => messages.map(messageView),
	};
};

/**
 * @typedef {{ state: 'signin' } | { state: 'pick_website' | 'not_subscribed', session: Record<string, any> }
 *   | { state: 'ready', session: Record<string, any>, data: DashboardData }} DashboardContext
 */

/**
 * What the dashboard shows for a session (launch exchanged at `/sso`).
 * @param {{ alerts: import('./service.js').Alerts, sessionId: string | undefined | null, website?: string | null, now?: number }} input
 * @returns {Promise<DashboardContext>}
 */
export const resolveDashboard = async ({ alerts, sessionId, website = null, now = Date.now() }) => {
	const { product, siteOf, deps } = alerts;
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
	if (!result.ok || !product.entitlements.can(result.doc, 'types')) return { state: 'not_subscribed', session };
	return { state: 'ready', session, data: liveDashboard({ site: await siteOf(websiteId, result.doc), now: deps.now }) };
};
