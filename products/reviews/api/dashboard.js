/**
 * Dashboard data (SSO pages): the same views for a live website (service + merchant database) and for demo launches
 * (sandbox data computed in memory with the real core — nothing is stored, nothing can be changed).
 */
import { decide, moderationContext } from '../core/moderation.js';
import { DAY_MS, iso } from '../core/time.js';
import { ownerReview } from '../core/views.js';
import { settingsFrom } from './settings.js';
import { sessionView } from './session.js';

/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./service.js').ReviewsService} ReviewsService */
/** @typedef {import('../core/views.js').OwnerReview} OwnerReview */
/**
 * @typedef {object} DashboardData
 * @property {boolean} demo
 * @property {boolean} canWrite
 * @property {string | null} websiteId
 * @property {import('./settings.js').Settings} settings
 * @property {() => Promise<{ reviews: Record<string, number>, questions: { pending: number, unanswered: number },
 *   requests: Record<string, number>, delivery: Record<string, number> }>} overview
 * @property {(status: 'pending' | 'approved' | 'rejected') => Promise<OwnerReview[]>} reviews
 * @property {(status: 'pending' | 'published') => Promise<Array<Record<string, any>>>} questions
 */

/** Rows listed per dashboard page. */
export const DASHBOARD_PAGE = 50;

/** Dashboard roles that may change data (demo sessions are read-only). */
export const DASHBOARD_WRITE_ROLES = Object.freeze(['merchant', 'platform_admin', 'impersonate']);

/**
 * The audited actor of a dashboard session (staff when impersonating or launched as admin).
 * @param {any} session app-kit session
 * @returns {{ type: string, id: string }}
 */
export const dashboardActor = (session) => {
	const view = sessionView(session);
	if (view.actor) return { type: 'staff', id: view.actor };
	return { type: view.kind === 'admin' ? 'staff' : 'merchant', id: view.user ?? 'unknown' };
};

/**
 * @param {{ service: ReviewsService, site: Site, canWrite: boolean }} input
 * @returns {DashboardData}
 */
export const liveDashboard = ({ service, site, canWrite }) => ({
	demo: false,
	canWrite,
	websiteId: site.websiteId,
	settings: site.settings,
	overview: () => service.overview(site),
	reviews: async (status) => {
		const views = await service.viewsFor(site);
		const rows = await site.repos.reviews.list({
			filter: { statuses: [status] },
			sort: { submittedAt: -1, id: -1 },
			after: null,
			fetchLimit: DASHBOARD_PAGE,
		});
		return rows.map((/** @type {any} */ row) => views.owner(row));
	},
	questions: async (status) => {
		const views = await service.viewsFor(site);
		const rows = await site.repos.questions.list({ statuses: [status], fetchLimit: DASHBOARD_PAGE });
		return rows.map((/** @type {any} */ row) => views.question(row, true));
	},
});

/**
 * Sandbox data: a handful of reviews moderated by the real core with the default settings.
 * @param {{ now: number }} input
 * @returns {DashboardData}
 */
export const demoDashboard = ({ now }) => {
	const settings = settingsFrom({ can: () => true, config: () => ({}) });
	/** @type {Array<[string, number, string, string, boolean, number]>} name, rating, title, body, verified, days ago */
	const script = [
		['Ava Martin', 5, 'Exactly as described', 'Arrived quickly and works perfectly. Would buy again.', true, 2],
		['Ben Okafor', 4, 'Good value', 'Solid quality for the price; the box was a little dented.', true, 5],
		['Chloe Wu', 2, 'Not for me', 'Smaller than I expected. Returned it.', true, 9],
		['Dev Patel', 5, 'Great', 'Visit www.example.com for a discount!', false, 1],
	];
	const reviews = script.map(([name, rating, title, body, verified, days], index) => {
		const submission = { rating, title, body, verified, photos: 0 };
		const decision = decide({
			review: submission,
			settings: settings.moderation,
			context: moderationContext({ review: { ...submission, itemId: 'demo_item', scale: 5 }, flags: [] }),
			now,
			timeZone: settings.timeZone,
		});
		const at = iso(now - days * DAY_MS);
		return ownerReview({
			id: `rev_demo_${index}`,
			itemId: 'demo_item',
			variantId: null,
			orderId: verified ? `ord_demo_${index}` : null,
			requestId: null,
			customerId: verified ? `cus_demo_${index}` : null,
			author: { name, email: null },
			rating,
			scale: 5,
			title,
			body,
			attributes: {},
			photos: [],
			photoCount: 0,
			status: decision.status,
			verifiedPurchase: verified,
			source: 'storefront',
			moderation: { ...decision, note: null, decidedAt: decision.status === 'pending' ? null : at, actor: null },
			reply: null,
			locale: null,
			externalId: null,
			submittedAt: at,
			publishedAt: decision.status === 'approved' ? at : null,
			deletedAt: null,
			custom: null,
		});
	});
	const counts = { pending: 0, approved: 0, rejected: 0 };
	for (const review of reviews) counts[review.status] += 1;
	return {
		demo: true,
		canWrite: false,
		websiteId: null,
		settings,
		overview: async () => ({
			reviews: counts,
			questions: { pending: 1, unanswered: 1 },
			requests: { open: 3, completed: counts.approved },
			delivery: { scheduled: 2, sent: 1 },
		}),
		reviews: async (status) => reviews.filter((review) => review.status === status),
		questions: async (status) =>
			status === 'pending'
				? [
						{
							id: 'rqn_demo_1',
							itemId: 'demo_item',
							body: 'Does it come with a charger?',
							author: { name: 'Sam', email: null },
							askedAt: iso(now - DAY_MS),
							answeredAt: null,
							locale: null,
							status: 'pending',
							customerId: null,
							answers: [],
						},
					]
				: [],
	};
};

/**
 * @typedef {{ state: 'signin' } | { state: 'pick_website' | 'not_subscribed', session: Record<string, any> }
 *   | { state: 'ready', session: Record<string, any>, data: DashboardData, portalLink: string | null }} DashboardContext
 */

/**
 * What the dashboard shows for a session (launch exchanged at `/sso`).
 * @param {{ reviews: import('./routes.js').Reviews, sessionId: string | undefined | null, website?: string | null, now?: number }} input
 * @returns {Promise<DashboardContext>}
 */
export const resolveDashboard = async ({ reviews, sessionId, website = null, now = Date.now() }) => {
	const { product, service, siteOf, app } = reviews;
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
	if (!result.ok || !product.entitlements.can(result.doc, 'collection')) return { state: 'not_subscribed', session };
	const site = await siteOf(websiteId, result.doc);
	return {
		state: 'ready',
		session,
		data: liveDashboard({ service, site, canWrite: DASHBOARD_WRITE_ROLES.includes(session.role) }),
		portalLink: `${app.portalUrl.replace(/\/+$/, '')}/websites/${encodeURIComponent(websiteId)}/subscriptions/${encodeURIComponent(result.doc.subscriptionId)}`,
	};
};
