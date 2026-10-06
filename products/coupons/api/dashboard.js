/**
 * Dashboard data (SSO pages): the same views for a live website (service + merchant database) and for demo launches
 * (sandbox data computed in memory with the real core — nothing is stored, nothing can be changed).
 */
import { normaliseCart } from '../core/cart.js';
import { evaluateCoupon } from '../core/evaluate.js';
import { shareLink } from '../core/links.js';
import { encodeQr, qrToSvg } from '../core/qr.js';
import { summarise } from '../core/report.js';
import { applyStack } from '../core/stacking.js';
import { codeView, couponView } from '../core/views.js';
import { settingsFrom } from './settings.js';

/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./service.js').CouponsService} CouponsService */
/** @typedef {ReturnType<typeof couponView>} CouponView */
/** @typedef {ReturnType<typeof codeView>} CodeView */
/**
 * @typedef {object} DashboardData
 * @property {boolean} demo
 * @property {boolean} canWrite
 * @property {string | null} websiteId
 * @property {import('./settings.js').Settings} settings
 * @property {() => Promise<Record<string, any>>} overview
 * @property {(query: { status?: string | null }) => Promise<CouponView[]>} coupons
 * @property {(id: string) => Promise<{ coupon: CouponView, codes: CodeView[], qr: string | null, link: string | null } | null>} coupon
 */

/** Rows listed per dashboard page. */
export const DASHBOARD_PAGE = 50;

/**
 * @param {{ service: CouponsService, site: Site, canWrite: boolean }} input
 * @returns {DashboardData}
 */
export const liveDashboard = ({ service, site, canWrite }) => ({
	demo: false,
	canWrite,
	websiteId: site.websiteId,
	settings: site.settings,
	overview: () => service.overview(site),
	coupons: async ({ status = null }) =>
		(await site.repos.coupons.list({ fetchLimit: DASHBOARD_PAGE, status })).map((/** @type {Record<string, any>} */ doc) =>
			couponView(doc),
		),
	coupon: async (id) => {
		const doc = await site.repos.coupons.get(id);
		if (!doc) return null;
		/** @type {CodeView[]} */
		const codes = (await site.repos.codes.byCoupon(id, { fetchLimit: DASHBOARD_PAGE })).map(
			(/** @type {Record<string, any>} */ code) => codeView(code),
		);
		const first = codes[0];
		const qr = first && site.settings.enabled('distribution') ? await service.qr(site, first.code) : null;
		const link = first && site.settings.enabled('distribution') ? await service.shareLink(site, { code: first.code }) : null;
		return {
			coupon: couponView(doc),
			codes,
			qr: qr?.ok ? qr.svg : null,
			link: link?.ok ? link.link.url : null,
		};
	},
});

/** Every element on, product defaults (what a demo shows). */
const demoSettings = () => settingsFrom({ can: () => true, config: () => ({}) });

/** Sample coupons of the demo (shared codes). */
const DEMO_COUPONS = Object.freeze([
	{
		id: 'cpn_demo_welcome',
		name: 'Welcome 10 %',
		status: 'active',
		mode: 'shared',
		currency: null,
		action: { type: 'percent', percent: 10, target: 'order' },
		eligibility: { when: '', conditions: [{ type: 'first_order', operator: 'eq', value: true }] },
		limits: { total: null, per_customer: 1, per_device: null, per_code: null },
		stacking: { class: 'order' },
		validity: {},
		listed: true,
		codeCount: 1,
		counters: { taken: 42, redeemed: 38 },
		code: 'WELCOME10',
	},
	{
		id: 'cpn_demo_shipping',
		name: 'Free shipping over 50.00',
		status: 'active',
		mode: 'shared',
		currency: 'EUR',
		action: { type: 'free_shipping' },
		eligibility: { when: '', conditions: [{ type: 'subtotal', operator: 'gte', value: 5000 }] },
		limits: { total: 500, per_customer: null, per_device: null, per_code: null },
		stacking: { class: 'shipping' },
		validity: { windows: [{ days: ['fri', 'sat'], start: '18:00', end: '02:00' }] },
		listed: false,
		codeCount: 1,
		counters: { taken: 120, redeemed: 117 },
		code: 'SHIPFREE',
	},
	{
		id: 'cpn_demo_bundle',
		name: 'Buy 2 get 1',
		status: 'active',
		mode: 'unique',
		currency: null,
		action: { type: 'bxgy', buy: 2, get: 1, percent: 100 },
		eligibility: { when: '', conditions: [{ type: 'collections', operator: 'in', value: ['socks'] }] },
		limits: { total: 1000, per_customer: null, per_device: null, per_code: 1 },
		stacking: { class: 'item' },
		validity: {},
		listed: false,
		codeCount: 1000,
		counters: { taken: 210, redeemed: 204 },
		code: 'B2G1-7KQM-X2PA',
	},
]);

/**
 * Sandbox data computed with the real core.
 * @param {{ now: number }} input
 * @returns {DashboardData}
 */
export const demoDashboard = ({ now }) => {
	const settings = demoSettings();
	const cart = normaliseCart({
		currency: 'EUR',
		lines: [
			{ itemId: 'itm_socks', quantity: 3, unitAmount: 1200, collections: ['socks'] },
			{ itemId: 'itm_shoes', quantity: 1, unitAmount: 8900 },
		],
		shipping: 495,
		customer: { id: 'cus_demo', orderCount: 0 },
	});
	const candidates = DEMO_COUPONS.flatMap((coupon, index) => {
		const verdict = evaluateCoupon({
			coupon,
			code: { code: coupon.code, status: 'active', taken: 0 },
			cart,
			now,
			index,
			settings: settings.evaluation,
		});
		return verdict.ok ? [verdict.candidate] : [];
	});
	const sample = applyStack({ cart, candidates, policy: { ...settings.policy, maxCoupons: 3 }, bounds: settings.bounds });
	const views = DEMO_COUPONS.map((coupon) => couponView(coupon));
	return {
		demo: true,
		canWrite: false,
		websiteId: null,
		settings,
		overview: async () => ({
			activeCoupons: views.length,
			openReservations: 1,
			windowDays: settings.reporting.default_window_days,
			sample: { codes: sample.applied.map((coupon) => coupon.code), discount: sample.discount + sample.shippingDiscount },
			...summarise({
				from: new Date(now - 30 * 86_400_000).toISOString(),
				to: new Date(now).toISOString(),
				orders: [{ currency: 'EUR', count: 359, discount: 412_350, revenue: 3_987_400 }],
				codes: DEMO_COUPONS.map((coupon) => ({
					couponId: coupon.id,
					code: coupon.code,
					currency: 'EUR',
					redemptions: coupon.counters.redeemed,
					discount: coupon.counters.redeemed * 1100,
				})),
				released: 4,
				top: settings.reporting.top_codes,
			}),
		}),
		coupons: async ({ status = null }) => views.filter((view) => !status || view.status === status),
		coupon: async (id) => {
			const coupon = DEMO_COUPONS.find((entry) => entry.id === id);
			if (!coupon) return null;
			const link = shareLink({
				domain: 'shop.example.com',
				path: '/',
				param: settings.codes.auto_apply_param,
				code: coupon.code,
			});
			const encoded = link ? encodeQr(link, { ecc: settings.distribution.qr_ecc }) : null;
			return {
				coupon: couponView(coupon),
				codes: [
					codeView({
						code: coupon.code,
						couponId: coupon.id,
						status: 'active',
						maxUses: coupon.limits.per_code,
						taken: 0,
						redeemed: 0,
					}),
				],
				qr: encoded?.ok ? qrToSvg(encoded.qr, { title: coupon.code, moduleSize: 4 }) : null,
				link,
			};
		},
	};
};

/** Dashboard roles that may change data (demo sessions are read-only). */
export const DASHBOARD_WRITE_ROLES = Object.freeze(['merchant', 'platform_admin', 'impersonate']);

/**
 * @typedef {{ state: 'signin' } | { state: 'pick_website' | 'not_subscribed', session: Record<string, any> }
 *   | { state: 'ready', session: Record<string, any>, data: DashboardData, portalLink: string | null }} DashboardContext
 */

/**
 * What the dashboard shows for a session (launch exchanged at `/sso`).
 * @param {{ coupons: import('./routes.js').Coupons, sessionId: string | undefined | null, website?: string | null, now?: number }} input
 * @returns {Promise<DashboardContext>}
 */
export const resolveDashboard = async ({ coupons, sessionId, website = null, now = Date.now() }) => {
	const { product, service, siteOf, app } = coupons;
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
	if (!result.ok || !product.entitlements.can(result.doc, 'codes')) return { state: 'not_subscribed', session };
	const site = await siteOf(websiteId, result.doc);
	return {
		state: 'ready',
		session,
		data: liveDashboard({ service, site, canWrite: DASHBOARD_WRITE_ROLES.includes(session.role) }),
		portalLink: `${app.product.portal.baseUrl}/websites/${encodeURIComponent(websiteId)}/subscriptions/${encodeURIComponent(result.doc.subscriptionId)}`,
	};
};
