/**
 * Dashboard data (SSO pages): the views of a live website (service + merchant database).
 */
import { codeView, couponView } from '../core/views.js';

/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./service.js').CouponsService} CouponsService */
/** @typedef {ReturnType<typeof couponView>} CouponView */
/** @typedef {ReturnType<typeof codeView>} CodeView */
/**
 * @typedef {object} DashboardData
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

/** Dashboard roles that may change data. */
export const DASHBOARD_WRITE_ROLES = Object.freeze(['merchant', 'platform_admin']);

/**
 * @typedef {{ state: 'signin' } | { state: 'pick_website' | 'not_subscribed', session: Record<string, any> }
 *   | { state: 'ready', session: Record<string, any>, data: DashboardData, portalLink: string | null }} DashboardContext
 */

/**
 * What the dashboard shows for a session (launch exchanged at `/sso`).
 * @param {{ coupons: import('./routes.js').Coupons, sessionId: string | undefined | null, website?: string | null }} input
 * @returns {Promise<DashboardContext>}
 */
export const resolveDashboard = async ({ coupons, sessionId, website = null }) => {
	const { product, service, siteOf, app } = coupons;
	const session = sessionId ? await product.launch.session(sessionId) : null;
	if (!session) return { state: 'signin' };
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
