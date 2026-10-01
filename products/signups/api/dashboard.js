/**
 * Dashboard data (SSO pages): the same views for a live website (service + merchant database) and for demo launches
 * (sandbox data built with the real core — nothing is stored, nothing can be changed).
 */
import { DAY_MS } from '../core/limits.js';
import { issuerFor, jwksUrlFor } from '../core/tokens.js';
import { customerView } from '../core/views.js';
import { settingsFrom } from './settings.js';

/** @typedef {import('./service.js').Site} Site */
/** @typedef {ReturnType<typeof customerView>} CustomerView */
/**
 * @typedef {object} DashboardData
 * @property {boolean} demo
 * @property {string | null} websiteId
 * @property {() => Promise<Record<string, number>>} overview
 * @property {(query: { email?: string, limit?: number }) => Promise<CustomerView[]>} customers
 * @property {() => Promise<Record<string, any>>} issuer
 */

/** Customers listed per dashboard page. */
export const DASHBOARD_PAGE = 50;
/** Launch roles that may open the dashboard. */
export const DASHBOARD_ROLES = Object.freeze(['merchant', 'demo', 'platform_admin', 'impersonate', 'partner', 'developer']);

/**
 * @param {{ service: import('./service.js').SignupsService, site: Site }} input
 * @returns {DashboardData}
 */
export const liveDashboard = ({ service, site }) => ({
	demo: false,
	websiteId: site.websiteId,
	overview: () => service.overview(site),
	customers: async ({ email, limit = DASHBOARD_PAGE }) =>
		(await site.repos.customers.list({ fetchLimit: limit, ...(email ? { email } : {}) })).map((/** @type {any} */ customer) =>
			service.viewOf(site, /** @type {any} */ (customer)),
		),
	issuer: () => service.issuer(site),
});

/**
 * Sandbox data (product defaults, sample customers).
 * @param {{ now: number, base: string }} input
 * @returns {DashboardData}
 */
export const demoDashboard = ({ now, base }) => {
	const settings = settingsFrom({ can: () => true, config: () => ({}) });
	const at = (/** @type {number} */ days) => new Date(now - days * DAY_MS).toISOString();
	const samples = /** @type {const} */ ([
		['cus_demo_ava', 'ava@example.com', null, 'Ava', 40, 1],
		['cus_demo_ben', null, '+442071838750', 'Ben', 25, 3],
		['cus_demo_chloe', 'chloe@example.com', '+14155550100', 'Chloé', 8, 0],
		['cus_demo_dev', 'dev@example.com', null, 'Dev', 2, 2],
	]);
	const customers = samples.map(([id, email, phone, name, created, signedIn]) =>
		customerView(
			{
				id,
				email,
				phone,
				emailVerifiedAt: email ? at(created) : null,
				phoneVerifiedAt: phone ? at(created) : null,
				status: 'active',
				profile: { given_name: name },
				createdAt: at(created),
				lastSignInAt: at(signedIn),
				signInCount: 3,
			},
			{ fields: settings.profile.fields },
		),
	);
	const websiteId = 'web_demo00000000000000000000';
	return {
		demo: true,
		websiteId: null,
		overview: async () => ({
			customers: customers.length,
			newLast30Days: 3,
			signedInLast30Days: customers.length,
			activeSessions: 6,
			pendingDeletions: 0,
		}),
		customers: async ({ email }) => customers.filter((c) => !email || c.email === email),
		issuer: async () => ({
			issuer: issuerFor(base, websiteId),
			jwksUrl: jwksUrlFor(base, websiteId),
			audience: websiteId,
			claimMap: { subject: 'sub', email: 'email', phone: 'phone_number' },
			algorithm: 'EdDSA',
			keys: [{ kid: 'demo-1', activatesAt: at(30), signing: true }],
			registered: false,
		}),
	};
};

/**
 * @typedef {{ state: 'signin' } | { state: 'pick_website' | 'not_subscribed', session: Record<string, any> }
 *   | { state: 'ready', session: Record<string, any>, data: DashboardData, portalLink: string | null }} DashboardContext
 */

/**
 * What the dashboard shows for a session (launch exchanged at `/sso`).
 * @param {{ signups: import('./routes.js').Signups, sessionId: string | undefined | null, website?: string | null, now?: number }} input
 * @returns {Promise<DashboardContext>}
 */
export const resolveDashboard = async ({ signups, sessionId, website = null, now = Date.now() }) => {
	const { product, service, siteOf, app } = signups;
	const session = sessionId ? await product.launch.session(sessionId) : null;
	if (!session) return { state: 'signin' };
	if (session.role === 'demo')
		return { state: 'ready', session, data: demoDashboard({ now, base: app.base }), portalLink: null };
	const scope = session.scope ?? {};
	const allowed = [scope.websiteId, ...(Array.isArray(scope.websiteIds) ? scope.websiteIds : [])].filter(
		(/** @type {unknown} */ id) => typeof id === 'string' && id.length > 0,
	);
	const websiteId = website && allowed.includes(website) ? website : allowed[0];
	if (!websiteId) return { state: 'pick_website', session };
	const result = await product.entitlements.forWebsite(websiteId);
	if (!result.ok || !product.entitlements.can(result.doc, 'profile')) return { state: 'not_subscribed', session };
	const site = await siteOf(websiteId, result.doc);
	return {
		state: 'ready',
		session,
		data: liveDashboard({ service, site }),
		portalLink: `${app.portalUrl.replace(/\/+$/, '')}/websites/${encodeURIComponent(websiteId)}/identity`,
	};
};
