/**
 * Dashboard data (SSO pages): the same views for a live website (service + merchant database) and for demo launches
 * (sandbox data built in memory with the real core and the default settings — nothing is stored, nothing can change).
 */
import { buildClaim, transitionSet } from '../core/claims.js';
import { linesOf } from '../core/purchases.js';
import { DAY_MS, iso } from '../core/time.js';
import { ownerClaimView } from '../core/views.js';
import { purchaseEligibility } from '../core/windows.js';
import { settingsFrom } from './settings.js';
import { sessionView } from './session.js';

/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./service.js').AftersalesService} AftersalesService */
/**
 * @typedef {object} DashboardData
 * @property {boolean} demo
 * @property {boolean} canWrite
 * @property {string | null} websiteId
 * @property {import('./settings.js').Settings} settings
 * @property {() => Promise<{ byStatus: Record<string, number>, byKind: Record<string, number>, overdue: number,
 *   refunded: Record<string, number> }>} overview
 * @property {(statuses: string[] | null) => Promise<Array<ReturnType<typeof ownerClaimView>>>} claims
 * @property {(raw: string) => Promise<Record<string, any> | null>} serial
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
 * @param {{ service: AftersalesService, site: Site, canWrite: boolean }} input
 * @returns {DashboardData}
 */
export const liveDashboard = ({ service, site, canWrite }) => ({
	demo: false,
	canWrite,
	websiteId: site.websiteId,
	settings: site.settings,
	overview: () => service.overview(site),
	claims: async (statuses) => {
		const views = await service.viewsFor(site);
		const rows = await site.repos.claims.list({ ...(statuses ? { statuses } : {}), fetchLimit: DASHBOARD_PAGE });
		return rows.map((/** @type {any} */ row) => views.owner(row));
	},
	serial: async (raw) => {
		const result = await service.lookupSerial(site, raw);
		return result.ok ? { ...result.serial, claims: result.claims, cover: result.entry?.windows ?? {} } : null;
	},
});

/**
 * Sandbox data: two delivered purchases and claims built by the real core with the default settings.
 * @param {{ now: number }} input
 * @returns {DashboardData}
 */
export const demoDashboard = ({ now }) => {
	const settings = settingsFrom({ can: () => true, config: () => ({}) });
	const { vocabulary } = settings;
	/** @type {Array<[string, string, string, number, string[]]>} type, reason, details, days ago, later statuses */
	const script = [
		['return', 'changed_mind', '', 2, []],
		['warranty', 'defective', 'It stopped charging after a week.', 6, ['approved', 'received']],
		['exchange', 'wrong_item', 'I ordered the blue one.', 9, ['approved']],
		['return', 'damaged_in_transit', 'The box arrived crushed.', 12, ['rejected']],
	];
	const claims = script.map(([type, reason, details, days, later], index) => {
		const purchase = {
			id: `pur_demo_${index}`,
			orderId: `ord_demo_${index}`,
			number: `D-${1001 + index}`,
			currency: null,
			status: 'delivered',
			placedAt: iso(now - (days + 3) * DAY_MS),
			deliveredAt: iso(now - (days + 1) * DAY_MS),
			lines: linesOf([
				{ itemId: `itm_demo_${index}`, title: `Demo item ${index + 1}`, quantity: 1, unitAmount: 2500, warrantyDays: 365 },
			]),
		};
		const eligibility = purchaseEligibility({
			purchase,
			claims: [],
			types: vocabulary.types,
			gradeOf: () => null,
			defaultItemType: settings.claims.default_item_type,
			gradeWindows: [],
			rules: [],
			now: now - days * DAY_MS,
			timeZone: settings.timeZone,
		});
		const built = buildClaim({
			id: `clm_demo_${index}`,
			input: {
				purchaseId: purchase.id,
				type,
				reason,
				details,
				lines: [{ lineId: /** @type {any} */ (purchase.lines[0]).lineId, quantity: 1, serial: null }],
				photoIds: [],
			},
			purchase,
			eligibility: eligibility.lines,
			types: vocabulary.types,
			reasons: vocabulary.reasons,
			maxLines: settings.claims.max_lines_per_claim,
			serialKeyOf: (raw) => raw,
			knownSerials: new Map(),
			status: settings.initialStatus,
			via: 'identity',
			customerKeys: [`cus_demo_${index}`],
			slaHours: settings.queue.sla_hours,
			now: now - days * DAY_MS,
		});
		/** @type {Record<string, any>} */
		let claim = built.ok ? built.claim : {};
		for (const [step, to] of later.entries()) {
			const at = now - (days - step - 1) * DAY_MS;
			claim = {
				...claim,
				...transitionSet({ claim, to, statuses: vocabulary.statuses, now: at }),
				history: [...claim.history, { from: claim.status, to, at: iso(at), actor: { type: 'merchant', id: 'demo' } }],
			};
		}
		return ownerClaimView(claim, vocabulary, { now });
	});
	/** @type {Record<string, number>} */
	const byStatus = {};
	/** @type {Record<string, number>} */
	const byKind = { open: 0, resolved: 0, rejected: 0, closed: 0 };
	for (const claim of claims) {
		byStatus[claim.status] = (byStatus[claim.status] ?? 0) + 1;
		byKind[claim.kind] = (byKind[claim.kind] ?? 0) + 1;
	}
	return {
		demo: true,
		canWrite: false,
		websiteId: null,
		settings,
		overview: async () => ({ byStatus, byKind, overdue: claims.filter((claim) => claim.overdue).length, refunded: {} }),
		claims: async (statuses) => claims.filter((claim) => !statuses || statuses.includes(claim.status)),
		serial: async () => null,
	};
};

/**
 * @typedef {{ state: 'signin' } | { state: 'pick_website' | 'not_subscribed', session: Record<string, any> }
 *   | { state: 'ready', session: Record<string, any>, data: DashboardData, portalLink: string | null }} DashboardContext
 */

/**
 * What the dashboard shows for a session (launch exchanged at `/sso`).
 * @param {{ aftersales: import('./routes.js').Aftersales, sessionId: string | undefined | null, website?: string | null, now?: number }} input
 * @returns {Promise<DashboardContext>}
 */
export const resolveDashboard = async ({ aftersales, sessionId, website = null, now = Date.now() }) => {
	const { product, service, siteOf, app } = aftersales;
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
	if (!result.ok || !product.entitlements.can(result.doc, 'claims')) return { state: 'not_subscribed', session };
	const site = await siteOf(websiteId, result.doc);
	return {
		state: 'ready',
		session,
		data: liveDashboard({ service, site, canWrite: DASHBOARD_WRITE_ROLES.includes(session.role) }),
		portalLink: `${app.product.portal.baseUrl}/websites/${encodeURIComponent(websiteId)}/subscriptions/${encodeURIComponent(result.doc.subscriptionId)}`,
	};
};
