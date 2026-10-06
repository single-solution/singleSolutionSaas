/**
 * Dashboard data (SSO pages): the same views for a live website (service + merchant database) and for demo launches
 * (sandbox data computed in memory with the real core — nothing is stored, nothing can be changed).
 */
import { applyMovement, newMember, withTier } from '../core/member.js';
import { DAY_MS } from '../core/time.js';
import { memberView, transactionView } from '../core/views.js';
import { settingsFrom } from './settings.js';

/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./service.js').LoyaltyService} LoyaltyService */
/** @typedef {ReturnType<typeof memberView>} MemberView */
/** @typedef {ReturnType<typeof transactionView>} TransactionView */
/**
 * @typedef {object} DashboardData
 * @property {boolean} demo
 * @property {boolean} canWrite
 * @property {string | null} websiteId
 * @property {import('./settings.js').Settings} settings
 * @property {() => Promise<Record<string, any>>} overview
 * @property {(query: { q?: string, limit?: number }) => Promise<MemberView[]>} members
 * @property {(customerId: string) => Promise<{ member: MemberView, history: TransactionView[] } | null>} member
 */

/** Members listed per dashboard page. */
export const DASHBOARD_PAGE = 50;

/**
 * @param {{ service: LoyaltyService, site: Site, canWrite: boolean }} input
 * @returns {DashboardData}
 */
export const liveDashboard = ({ service, site, canWrite }) => ({
	demo: false,
	canWrite,
	websiteId: site.websiteId,
	settings: site.settings,
	overview: () => service.overview(site),
	members: async ({ q = '', limit = DASHBOARD_PAGE }) =>
		(await site.repos.members.list({ fetchLimit: limit, prefix: q })).map(
			(/** @type {import("../core/member.js").Member} */ member) => service.view(site, member),
		),
	member: async (customerId) => {
		const member = await service.member(site, customerId);
		if (!member) return null;
		return {
			member: service.view(site, member),
			history: await service.history(site, { customerId, fetchLimit: DASHBOARD_PAGE }),
		};
	},
});

/** Every element on, product defaults (what a demo shows). */
const demoSettings = () => settingsFrom({ can: () => true, config: () => ({}) });

/**
 * Sandbox data: a few members built by replaying sample movements through the real core.
 * @param {{ now: number }} input
 * @returns {DashboardData}
 */
export const demoDashboard = ({ now }) => {
	const settings = demoSettings();
	const options = { timeZone: settings.timeZone, tierWindowMonths: settings.tiers?.window_months ?? 0, expiry: settings.expiry };
	/** @type {Array<[string, Array<[import('../core/member.js').MovementKind, number, number]>]>} kind, points, days ago */
	const script = [
		[
			'cus_demo_ava',
			[
				['earn', 1200, 300],
				['earn', 2600, 120],
				['redeem', 800, 90],
				['earn', 1900, 20],
			],
		],
		[
			'cus_demo_ben',
			[
				['earn', 450, 200],
				['earn', 300, 60],
				['adjust', 100, 30],
			],
		],
		[
			'cus_demo_chloe',
			[
				['earn', 5400, 40],
				['redeem', 1000, 10],
			],
		],
		['cus_demo_dev', [['earn', 120, 2]]],
	];
	/** @type {Map<string, { member: import('../core/member.js').Member, history: import('../core/member.js').Transaction[] }>} */
	const members = new Map();
	for (const [customerId, steps] of script) {
		let member = newMember(customerId, now - 400 * DAY_MS);
		/** @type {import('../core/member.js').Transaction[]} */
		const history = [];
		for (const [index, [kind, points, daysAgo]] of steps.entries()) {
			const at = now - daysAgo * DAY_MS;
			const applied = applyMovement(
				member,
				{
					kind,
					points,
					at,
					txId: `ptx_demo_${customerId}_${index}`,
					sourceKey: `demo:${customerId}:${index}`,
					qualifying: kind === 'earn' ? { points } : undefined,
					source: { type: 'demo' },
					reason: kind === 'earn' ? 'earn_rules' : kind,
				},
				options,
			);
			if (!applied.ok) continue;
			member = withTier(applied.member, settings.tiers, { now: at, timeZone: settings.timeZone }).member;
			history.unshift(applied.tx);
		}
		members.set(customerId, { member, history });
	}
	const view = (/** @type {import('../core/member.js').Member} */ member) =>
		memberView(member, {
			tiers: settings.tiers,
			now,
			timeZone: settings.timeZone,
			expiringWindowDays: settings.wallet.expiring_window_days,
			expiry: settings.expiry,
		});
	const all = [...members.values()];
	const since = now - 30 * DAY_MS;
	const recent = all.flatMap((entry) => entry.history).filter((tx) => Date.parse(tx.occurredAt) >= since);
	return {
		demo: true,
		canWrite: false,
		websiteId: null,
		settings,
		overview: async () => ({
			members: all.length,
			outstandingPoints: all.reduce((sum, entry) => sum + entry.member.balance, 0),
			last30Days: {
				earned: recent.filter((tx) => tx.kind === 'earn').reduce((sum, tx) => sum + tx.points, 0),
				redeemed: -recent.filter((tx) => tx.kind === 'redeem').reduce((sum, tx) => sum + tx.points, 0),
				expired: 0,
				reversed: 0,
				transactions: recent.length,
			},
			activeRedemptions: 0,
		}),
		members: async ({ q = '' }) =>
			all.filter((entry) => entry.member.customerId.startsWith(q)).map((entry) => view(entry.member)),
		member: async (customerId) => {
			const entry = members.get(customerId);
			return entry ? { member: view(entry.member), history: entry.history.map(transactionView) } : null;
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
 * @param {{ loyalty: import('./routes.js').Loyalty, sessionId: string | undefined | null, website?: string | null, now?: number }} input
 * @returns {Promise<DashboardContext>}
 */
export const resolveDashboard = async ({ loyalty, sessionId, website = null, now = Date.now() }) => {
	const { product, service, siteOf, app } = loyalty;
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
	if (!result.ok || !product.entitlements.can(result.doc, 'earn_rules')) return { state: 'not_subscribed', session };
	const site = await siteOf(websiteId, result.doc);
	return {
		state: 'ready',
		session,
		data: liveDashboard({ service, site, canWrite: DASHBOARD_WRITE_ROLES.includes(session.role) }),
		portalLink: `${app.product.portal.baseUrl}/websites/${encodeURIComponent(websiteId)}/subscriptions/${encodeURIComponent(result.doc.subscriptionId)}`,
	};
};
