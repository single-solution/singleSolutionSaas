/**
 * Dashboard data (SSO pages): the same views for a live website (service + merchant database) and for demo launches
 * (sandbox data computed in memory with the real core and the default settings — nothing is stored or changed).
 */
import { criticalFailed, scoreOf, suggestTier } from '../core/inspection.js';
import { mappingProblems } from '../core/mapping.js';
import { inspectionView, unitView } from './inspections.js';
import { settingsFrom } from './settings.js';
import { sessionView } from './session.js';

/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./service.js').GradesService} GradesService */

/**
 * @typedef {object} DashboardData
 * @property {boolean} demo
 * @property {boolean} canWrite
 * @property {string | null} websiteId
 * @property {import('./settings.js').Settings} settings
 * @property {Array<{ vocabulary: string, tier: string, problem: string }>} mappingProblems
 * @property {() => Promise<Awaited<ReturnType<GradesService['overview']>>>} overview
 * @property {() => Promise<Array<ReturnType<typeof unitView>>>} units
 * @property {() => Promise<Array<ReturnType<typeof inspectionView>>>} inspections
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
 * @param {{ service: GradesService, site: Site, canWrite: boolean }} input
 * @returns {DashboardData}
 */
export const liveDashboard = ({ service, site, canWrite }) => ({
	demo: false,
	canWrite,
	websiteId: site.websiteId,
	settings: site.settings,
	mappingProblems: mappingProblems(site.settings.vocabularies),
	overview: () => service.overview(site),
	units: async () =>
		(await site.repos.units.list({ after: null, fetchLimit: DASHBOARD_PAGE })).map((/** @type {any} */ row) => unitView(row)),
	inspections: async () =>
		(await site.repos.inspections.list({ after: null, fetchLimit: DASHBOARD_PAGE })).map((/** @type {any} */ row) =>
			inspectionView(row),
		),
});

/**
 * Sandbox data: three units inspected with the default checklist and scored by the real core.
 * @param {{ now: number }} input
 * @returns {DashboardData}
 */
export const demoDashboard = ({ now }) => {
	const settings = settingsFrom({ can: () => true, config: () => ({}) });
	const checklist = /** @type {import('../core/inspection.js').Checklist} */ (settings.checklists[0]);
	/** @type {Array<[string, number, boolean, boolean]>} serial, appearance, works, complete */
	const script = [
		['SN-DEMO-001', 5, true, true],
		['SN-DEMO-002', 4, true, false],
		['SN-DEMO-003', 3, false, true],
	];
	const at = (/** @type {number} */ days) => new Date(now - days * 86_400_000).toISOString();
	const rows = script.map(([serial, appearance, works, complete], index) => {
		const results = [
			{ item: 'appearance', value: appearance, note: null },
			{ item: 'function', value: works, note: null },
			{ item: 'completeness', value: complete, note: null },
		];
		const score = scoreOf(checklist, results);
		const critical = criticalFailed(checklist, results);
		const tier = suggestTier({
			score,
			critical,
			thresholds: settings.inspection.thresholds,
			index: settings.index,
			criticalFailTier: '',
		});
		const unit = {
			id: `unt_demo_${index}`,
			itemId: 'demo_item',
			variantId: null,
			serial,
			tier,
			note: null,
			available: true,
			lastInspectionId: `ins_demo_${index}`,
			inspectedAt: at(index + 1),
			score,
			report: null,
			addedAt: at(index + 2),
		};
		const inspection = {
			id: `ins_demo_${index}`,
			unitId: unit.id,
			itemId: unit.itemId,
			checklist: checklist.key,
			status: 'completed',
			results,
			score,
			suggestedTier: tier,
			criticalFailed: critical,
			tier,
			inspector: null,
			startedAt: at(index + 1),
			completedAt: at(index + 1),
		};
		return { unit: unitView(unit), inspection: inspectionView(inspection) };
	});
	return {
		demo: true,
		canWrite: false,
		websiteId: null,
		settings,
		mappingProblems: mappingProblems(settings.vocabularies),
		overview: async () => ({
			items: { graded: 1, known: 1 },
			tiers: settings.tiers.map((tier) => ({
				key: tier.key,
				label: tier.label,
				assignments: 0,
				units: rows.filter((row) => row.unit.tier === tier.key).length,
			})),
			ungradedUnits: 0,
			inspections: { draft: 0, completed: rows.length },
		}),
		units: async () => rows.map((row) => row.unit),
		inspections: async () => rows.map((row) => row.inspection),
	};
};

/**
 * @typedef {{ state: 'signin' } | { state: 'pick_website' | 'not_subscribed', session: Record<string, any> }
 *   | { state: 'ready', session: Record<string, any>, data: DashboardData, portalLink: string | null }} DashboardContext
 */

/**
 * What the dashboard shows for a session (launch exchanged at `/sso`).
 * @param {{ grades: import('./routes.js').Grades, sessionId: string | undefined | null, website?: string | null, now?: number }} input
 * @returns {Promise<DashboardContext>}
 */
export const resolveDashboard = async ({ grades, sessionId, website = null, now = Date.now() }) => {
	const { product, service, siteOf, app } = grades;
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
	if (!result.ok || !product.entitlements.can(result.doc, 'tiers')) return { state: 'not_subscribed', session };
	const site = await siteOf(websiteId, result.doc);
	return {
		state: 'ready',
		session,
		data: liveDashboard({ service, site, canWrite: DASHBOARD_WRITE_ROLES.includes(session.role) }),
		portalLink: `${app.portalUrl.replace(/\/+$/, '')}/websites/${encodeURIComponent(websiteId)}/subscriptions/${encodeURIComponent(result.doc.subscriptionId)}`,
	};
};
