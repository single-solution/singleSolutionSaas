/**
 * Dashboard data (SSO pages): the same views for a live website (service + merchant database) and for demo launches
 * (sandbox deals evaluated in memory with the real core — nothing is stored, nothing can be changed).
 */
import { normaliseDeal } from '../core/deals.js';
import { evaluateCart } from '../core/evaluate.js';
import { scheduleState } from '../core/schedule.js';
import { normaliseLine } from '../core/scope.js';
import { DAY_MS, HOUR_MS } from '../core/time.js';
import { sessionView } from './session.js';
import { settingsFrom } from './settings.js';

/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./service.js').DealsService} DealsService */
/**
 * @typedef {object} DashboardData
 * @property {boolean} demo
 * @property {boolean} canWrite
 * @property {string | null} websiteId
 * @property {import('./settings.js').Settings} settings
 * @property {() => Promise<Record<string, any>>} overview
 * @property {() => Promise<Array<Record<string, any>>>} deals
 * @property {(id: string) => Promise<Record<string, any> | null>} deal
 */

/** Deals listed on one dashboard page. */
export const DASHBOARD_PAGE = 100;

/** Dashboard roles that may change data (demo sessions are read-only). */
export const DASHBOARD_WRITE_ROLES = Object.freeze(['merchant', 'platform_admin', 'impersonate']);

/**
 * Audit actor of a dashboard session (staff when impersonating or on an admin launch).
 * @param {any} session
 */
export const dashboardActor = (session) => {
	const view = sessionView(session);
	return view.actor
		? { type: 'staff', id: view.actor }
		: { type: view.kind === 'admin' ? 'staff' : 'merchant', id: view.user ?? 'unknown' };
};

/**
 * @param {{ service: DealsService, site: Site, canWrite: boolean }} input
 * @returns {DashboardData}
 */
export const liveDashboard = ({ service, site, canWrite }) => ({
	demo: false,
	canWrite,
	websiteId: site.websiteId,
	settings: site.settings,
	overview: () => service.overview(site),
	deals: () => service.listDeals(site, { after: null, fetchLimit: DASHBOARD_PAGE }),
	deal: (id) => service.getDeal(site, id),
});

/** Every element on, product defaults (what a demo shows). */
const demoSettings = () => settingsFrom({ can: () => true, config: () => ({}) });

/**
 * Sandbox data: sample deals (a weekday-evening deal with an overnight window, a cart threshold with free shipping, a
 * flash sale, a mix-and-match bundle) and a sample cart evaluated by the real engine.
 * @param {{ now: number }} input
 * @returns {DashboardData}
 */
export const demoDashboard = ({ now }) => {
	const settings = demoSettings();
	const rules = settings.dealRules;
	const defaults = settings.defaults;
	const iso = (/** @type {number} */ ms) => new Date(ms).toISOString();
	const deals = [
		normaliseDeal(
			{
				kind: 'item',
				name: 'Weekday evenings: 15% off shoes',
				scope: { collections: ['shoes'] },
				action: { type: 'percent', percent: 15 },
				schedule: { windows: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '18:00', end: '02:00' }] },
				createdAt: iso(now - 20 * DAY_MS),
			},
			{ id: 'dl_demo_evenings', rules, defaults },
		),
		normaliseDeal(
			{
				kind: 'cart',
				name: 'Free shipping over 50.00',
				conditions: { minSubtotal: 5000 },
				action: { type: 'free_shipping' },
				createdAt: iso(now - 30 * DAY_MS),
			},
			{ id: 'dl_demo_shipping', rules, defaults },
		),
		normaliseDeal(
			{
				kind: 'flash',
				name: 'Flash sale: headphones',
				scope: { brands: ['acme'] },
				action: { type: 'percent', percent: 30 },
				schedule: { startsAt: iso(now - 2 * HOUR_MS), endsAt: iso(now + 6 * HOUR_MS) },
				limits: { stockUnits: 50 },
				createdAt: iso(now - 2 * HOUR_MS),
			},
			{ id: 'dl_demo_flash', rules, defaults },
		),
		normaliseDeal(
			{
				kind: 'bundle',
				name: 'Any 3 socks for 20.00',
				bundle: { type: 'mix_and_match', scope: { collections: ['socks'] }, quantity: 3 },
				action: { type: 'fixed_price', amount: 2000 },
				createdAt: iso(now - 10 * DAY_MS),
			},
			{ id: 'dl_demo_socks', rules, defaults },
		),
	];
	const usage = { dl_demo_flash: { uses: 12, units: 14 } };
	const view = (/** @type {import('../core/deals.js').Deal} */ deal) => {
		const state = scheduleState(deal.schedule, now, settings.timeZone);
		return {
			...deal,
			usage: /** @type {Record<string, { uses: number, units: number }>} */ (usage)[deal.id] ?? { uses: 0, units: 0 },
			state: {
				active: state.active,
				phase: state.phase,
				activeUntil: state.activeUntil === null ? null : iso(state.activeUntil),
				nextStart: state.nextStart === null ? null : iso(state.nextStart),
				timeZone: state.timeZone,
			},
		};
	};
	const sample = evaluateCart({
		cart: {
			currency: 'EUR',
			lines: [
				{ itemId: 'itm_runner', quantity: 1, unitAmount: 8900, collections: ['shoes'] },
				{ itemId: 'itm_buds', quantity: 1, unitAmount: 5900, brand: 'acme' },
				{ itemId: 'itm_socks', quantity: 3, unitAmount: 900, collections: ['socks'] },
			].map((line, index) => normaliseLine(line, index)),
			customer: { id: null, segments: [], orders: null, tags: [] },
			paymentMethod: null,
			deliveryMethod: null,
			shippingAmount: 495,
		},
		deals,
		usage,
		customerUsage: {},
		settings: settings.engine,
		now,
	});
	return {
		demo: true,
		canWrite: false,
		websiteId: null,
		settings,
		overview: async () => ({
			live: deals.filter((d) => scheduleState(d.schedule, now, settings.timeZone).active).length,
			scheduled: deals.filter((d) => {
				const s = scheduleState(d.schedule, now, settings.timeZone);
				return !s.active && s.nextStart !== null;
			}).length,
			paused: 0,
			openQuotes: 3,
			windowDays: settings.reporting.window_days,
			report: {
				orders: 128,
				ordersWithDeals: 74,
				subtotal: 912_400,
				discountTotal: 61_250,
				revenue: 851_150,
				averageOrder: { withDeals: 7840, withoutDeals: 6630 },
				upliftPercent: 18.3,
				margin: null,
				deals: deals.map((d, index) => ({
					dealId: d.id,
					name: d.name,
					kind: d.kind,
					uses: 40 - index * 9,
					units: 52 - index * 11,
					discount: 24_000 - index * 5000,
					revenue: 0,
				})),
			},
			sample,
		}),
		deals: async () => deals.map(view),
		deal: async (id) => {
			const deal = deals.find((d) => d.id === id);
			return deal ? view(deal) : null;
		},
	};
};

/**
 * @typedef {{ state: 'signin' } | { state: 'pick_website' | 'not_subscribed', session: Record<string, any> }
 *   | { state: 'ready', session: Record<string, any>, data: DashboardData, portalLink: string | null }} DashboardContext
 */

/**
 * What the dashboard shows for a session (launch exchanged at `/sso`).
 * @param {{ deals: import('./routes.js').Deals, sessionId: string | undefined | null, website?: string | null, now?: number }} input
 * @returns {Promise<DashboardContext>}
 */
export const resolveDashboard = async ({ deals, sessionId, website = null, now = Date.now() }) => {
	const { product, service, siteOf, app } = deals;
	const session = sessionId ? await product.launch.session(sessionId) : null;
	if (!session) return { state: 'signin' };
	if (session.role === 'demo') return { state: 'ready', session, data: demoDashboard({ now }), portalLink: null };
	const scope = session.scope ?? {};
	const allowed = [scope.websiteId, ...(Array.isArray(scope.websiteIds) ? scope.websiteIds : [])].filter(
		(/** @type {unknown} */ id) => typeof id === 'string' && id.length > 0,
	);
	const websiteId = website && allowed.includes(website) ? website : allowed[0];
	if (!websiteId) return { state: 'pick_website', session };
	const result = await product.entitlements.forWebsite(websiteId);
	if (!result.ok || !product.entitlements.can(result.doc, 'quote_api')) return { state: 'not_subscribed', session };
	const site = await siteOf(websiteId, result.doc);
	return {
		state: 'ready',
		session,
		data: liveDashboard({ service, site, canWrite: DASHBOARD_WRITE_ROLES.includes(session.role) }),
		portalLink: `${app.portalUrl.replace(/\/+$/, '')}/websites/${encodeURIComponent(websiteId)}/subscriptions/${encodeURIComponent(result.doc.subscriptionId)}`,
	};
};
