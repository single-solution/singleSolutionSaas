/**
 * Admin Console page loaders: the data each page needs, read through the in-process {@link ConsoleApi} with the
 * staff session cookie (public staff API only — "every UI action is an API call"). A loader resolves to
 * `{ ok: true, ... }` or `{ ok: false, status, problem }` (the first required call that failed); optional reads
 * degrade to empty values (`section(...)` keeps the problem so the page can say why a section is empty). Loaders never
 * throw for API failures. Query-string inputs are validated here; anything malformed is ignored.
 * @module
 */
import { ID, adminApi as paths } from './paths.js';

/** @typedef {import('../api.js').ConsoleApi} ConsoleApi */
/** @typedef {import('@ss/ui/problems').Problem} Problem */
/** @typedef {{ ok: false, status: number, problem: Problem }} LoadFailure */
/**
 * @template T
 * @typedef {import('../api.js').ApiResult<T>} ApiResult
 */

/**
 * @template T
 * @param {ApiResult<T>} result
 * @param {T} fallback
 * @returns {T}
 */
const orElse = (result, fallback) => (result.ok ? result.data : fallback);

/**
 * @param {...ApiResult<any>} results
 * @returns {LoadFailure | null}
 */
const firstFailure = (...results) => {
	for (const r of results) if (!r.ok) return { ok: false, status: r.status, problem: r.problem };
	return null;
};

/**
 * An optional section of a page: its data (or the fallback) and the problem that emptied it.
 * @template T
 * @param {ApiResult<T>} result
 * @param {T} fallback
 */
const section = (result, fallback) => ({
	data: result.ok ? result.data : fallback,
	problem: result.ok ? null : result.problem,
});

/** @param {ApiResult<any>} r */
const itemsOf = (r) => /** @type {any[]} */ (orElse(r, { items: [] })?.items ?? []);

/** @param {ApiResult<any>} r */
const pageOf = (r) => {
	const data = /** @type {any} */ (orElse(r, null));
	return {
		items: /** @type {any[]} */ (data?.items ?? []),
		nextCursor: /** @type {string | null} */ (data?.nextCursor ?? null),
	};
};

/**
 * @param {unknown} value
 * @param {RegExp} pattern
 * @returns {string | null}
 */
export const pick = (value, pattern) => (typeof value === 'string' && pattern.test(value) ? value : null);

/** @param {unknown} value @param {readonly string[]} allowed */
const oneOf = (value, allowed) => (typeof value === 'string' && allowed.includes(value) ? value : null);

const CURSOR = /^[A-Za-z0-9_=-]{1,512}$/;
const FREE_TEXT = /^[^<>]{1,120}$/;

/** Problem of a staff session that has not completed its second factor. */
export const MFA_PENDING = 'mfa_pending';

/**
 * The signed-in staff member (console frame). A half-signed session (password only) is reported as
 * `{ ok: false, status: 401, problem: { code: 'mfa_pending' } }` so pages send it back to the sign-in flow.
 * @param {ConsoleApi} api
 */
export const loadStaffSession = async (api) => {
	const me = await api.get(paths.me());
	if (!me.ok) {
		if (me.status === 403 && /two-factor/i.test(me.problem.detail ?? ''))
			return /** @type {LoadFailure} */ ({
				ok: false,
				status: 401,
				problem: { status: 401, code: MFA_PENDING, title: 'Two-factor authentication required' },
			});
		return /** @type {LoadFailure} */ ({ ok: false, status: me.status, problem: me.problem });
	}
	if (me.data?.kind !== 'staff')
		return /** @type {LoadFailure} */ ({
			ok: false,
			status: 401,
			problem: { status: 401, title: 'Unauthorized', detail: 'The admin console needs a staff account.' },
		});
	return { ok: /** @type {const} */ (true), me: me.data, staff: /** @type {any} */ (me.data.staff) };
};

/**
 * Platform health: queues and dead letters, unhealthy service apps, reconciliation and finance alerts, operation runs,
 * the job queue and the last audit-chain verification (each section degrades on its own, e.g. for roles without
 * `platform.jobs.read`).
 * @param {ConsoleApi} api
 */
export const loadDashboard = async (api) => {
	const [health, metrics, deadLetters, apps, alerts, reports] = await Promise.all([
		api.get(paths.health()),
		api.get(paths.metrics()),
		api.get(`${paths.deadLetters()}?limit=5`),
		api.get(paths.apps({ limit: 100 })),
		api.get(paths.alerts()),
		api.get(paths.reconciliation()),
	]);
	const appItems = itemsOf(apps);
	return {
		ok: /** @type {const} */ (true),
		health: section(health, /** @type {any} */ (null)),
		metrics: orElse(metrics, null),
		metricsProblem: metrics.ok ? null : metrics.problem,
		deadLetters: itemsOf(deadLetters),
		apps: appItems,
		unhealthy: unhealthyApps(appItems),
		alerts: itemsOf(alerts),
		reports: itemsOf(reports),
	};
};

/**
 * Live service apps whose heartbeat is stale or reports a non-`ok` status.
 * @param {any[]} apps
 */
export const unhealthyApps = (apps) =>
	apps.filter(
		(a) =>
			a.kind === 'service' &&
			(a.status === 'active' || a.status === 'deprecated') &&
			a.health &&
			(a.health.stale === true || (a.health.status !== null && a.health.status !== 'ok')),
	);

const DOMAIN = /^(?=.{1,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/**
 * Merchants page. The search box takes a merchant id (exact lookup), a domain (owner of the live or test website)
 * or a name / e-mail prefix (`GET /v1/admin/merchants?q=`: case- and accent-insensitive name prefix, or a team
 * member's e-mail prefix when it contains `@`).
 * @param {ConsoleApi} api
 * @param {{ status?: string, q?: string, cursor?: string }} [filter]
 */
export const loadMerchants = async (api, filter = {}) => {
	const status = oneOf(filter.status, ['active', 'suspended']);
	const q = pick(filter.q?.trim(), FREE_TEXT);
	const byId = pick(q, ID.merchant);
	const domain = !byId && q && !q.includes('@') ? pick(q.toLowerCase(), DOMAIN) : null;
	const search = q && !byId && !domain ? q : null;
	const [list, exact, live, test] = await Promise.all([
		api.get(paths.merchants({ status, q: search, cursor: pick(filter.cursor, CURSOR), limit: 100 })),
		byId ? api.get(paths.merchant(byId)) : null,
		domain ? api.get(paths.websiteLookup({ domain, env: 'live' })) : null,
		domain ? api.get(paths.websiteLookup({ domain, env: 'test' })) : null,
	]);
	const failed = firstFailure(list);
	if (failed) return failed;
	const owners = [...new Set([...(live ? itemsOf(live) : []), ...(test ? itemsOf(test) : [])].map((w) => w.merchantId))];
	const found = await Promise.all(owners.map((id) => api.get(paths.merchant(id))));
	const matches = [...(exact && exact.ok ? [exact.data] : []), ...found.flatMap((r) => (r.ok ? [r.data] : []))];
	return {
		ok: /** @type {const} */ (true),
		filter: { status, q },
		mode: byId ? 'id' : domain ? 'domain' : search ? 'search' : 'all',
		page: pageOf(list),
		matches,
	};
};

/**
 * Merchant detail: profile and websites, team, subscriptions, balance and meter, staff notes, finance
 * alerts, and the listed apps (for impersonated product launches).
 * @param {ConsoleApi} api
 * @param {string} merchantId
 */
export const loadMerchant = async (api, merchantId) => {
	const [merchant, team, subscriptions, balance, meter, notes, alerts, apps] = await Promise.all([
		api.get(paths.merchant(merchantId)),
		api.get(paths.team(merchantId)),
		api.get(paths.subscriptions(merchantId)),
		api.get(paths.balance(merchantId)),
		api.get(paths.meter(merchantId)),
		api.get(paths.notes(merchantId)),
		api.get(paths.alerts({ merchantId })),
		api.get(paths.apps({ status: 'active,deprecated', limit: 100 })),
	]);
	const failed = firstFailure(merchant);
	if (failed) return failed;
	const data = /** @type {any} */ (merchant.ok ? merchant.data : {});
	return {
		ok: /** @type {const} */ (true),
		merchant: data,
		websites: /** @type {any[]} */ (data.websites ?? []),
		members: /** @type {any[]} */ (orElse(team, { members: [] })?.members ?? []),
		invites: /** @type {any[]} */ (orElse(team, { invites: [] })?.invites ?? []),
		subscriptions: itemsOf(subscriptions),
		balance: orElse(balance, null),
		meter: orElse(meter, null),
		notes: section(notes, { items: [] }),
		alerts: itemsOf(alerts),
		apps: itemsOf(apps),
	};
};

/**
 * Website lookup by domain (live or test).
 * @param {ConsoleApi} api
 * @param {{ domain?: string, env?: string }} [filter]
 */
export const loadWebsites = async (api, filter = {}) => {
	const domain = pick(filter.domain?.trim().toLowerCase(), /^[a-z0-9.-]{1,253}$/);
	const env = oneOf(filter.env, ['live', 'test']) ?? 'live';
	if (!domain) return { ok: /** @type {const} */ (true), filter: { domain: null, env }, results: [], merchants: {} };
	const lookup = await api.get(paths.websiteLookup({ domain, env }));
	if (!lookup.ok && lookup.status !== 400 && lookup.status !== 422) return /** @type {LoadFailure} */ (firstFailure(lookup));
	const results = itemsOf(lookup);
	const owners = await Promise.all(results.map((w) => api.get(paths.merchant(w.merchantId))));
	/** @type {Record<string, any>} */
	const merchants = {};
	owners.forEach((r, i) => {
		if (r.ok) merchants[/** @type {any} */ (results[i]).merchantId] = r.data;
	});
	return {
		ok: /** @type {const} */ (true),
		filter: { domain, env },
		results,
		merchants,
		lookupProblem: lookup.ok ? null : lookup.problem,
	};
};

/**
 * @param {ConsoleApi} api
 * @param {{ status?: string, kind?: string, cursor?: string }} [filter]
 */
export const loadApps = async (api, filter = {}) => {
	const status = oneOf(filter.status, ['pending', 'active', 'deprecated', 'retired']);
	const kind = oneOf(filter.kind, ['service', 'pack']);
	const list = await api.get(paths.apps({ status, kind, cursor: pick(filter.cursor, CURSOR), limit: 50 }));
	const failed = firstFailure(list);
	if (failed) return failed;
	return { ok: /** @type {const} */ (true), filter: { status, kind }, page: pageOf(list) };
};

/**
 * App detail: app (keys, environments, health), versions, and its platform policy layer.
 * @param {ConsoleApi} api
 * @param {string} appId
 */
export const loadApp = async (api, appId) => {
	const [app, versions, policy] = await Promise.all([
		api.get(paths.app(appId)),
		api.get(paths.versions(appId)),
		api.get(paths.platformPolicy(appId)),
	]);
	const failed = firstFailure(app);
	if (failed) return failed;
	return {
		ok: /** @type {const} */ (true),
		app: /** @type {any} */ (app.ok ? app.data : null),
		versions: pageOf(versions),
		policy: orElse(policy, null),
	};
};

/**
 * One manifest version with its diff against the version before it.
 * @param {ConsoleApi} api
 * @param {string} appId
 * @param {string} version
 */
export const loadVersion = async (api, appId, version) => {
	if (!/^\d{1,9}$/.test(version))
		return /** @type {LoadFailure} */ ({
			ok: false,
			status: 404,
			problem: { status: 404, title: 'Not found', detail: 'No such version.' },
		});
	const [app, detail] = await Promise.all([api.get(paths.app(appId)), api.get(paths.version(appId, version))]);
	const failed = firstFailure(app, detail);
	if (failed) return failed;
	return {
		ok: /** @type {const} */ (true),
		app: /** @type {any} */ (app.ok ? app.data : null),
		version: /** @type {any} */ (detail.ok ? detail.data : null),
	};
};

/**
 * The current accepted manifest of an app (null when it has none yet).
 * @param {ConsoleApi} api
 * @param {any} app
 */
const currentManifest = async (api, app) => {
	if (!app?.currentVersion) return null;
	const version = await api.get(paths.version(app.appId, app.currentVersion));
	return version.ok ? /** @type {any} */ (version.data.manifest ?? null) : null;
};

/**
 * Platform policy of an app (applies to every subscription): the layer, its history, and the manifest schemas.
 * @param {ConsoleApi} api
 * @param {string} appId
 */
export const loadPolicies = async (api, appId) => {
	const [app, layer, history] = await Promise.all([
		api.get(paths.app(appId)),
		api.get(paths.platformPolicy(appId)),
		api.get(paths.platformHistory(appId)),
	]);
	const failed = firstFailure(app, layer);
	if (failed) return failed;
	const appData = /** @type {any} */ (app.ok ? app.data : null);
	return {
		ok: /** @type {const} */ (true),
		app: appData,
		layer: /** @type {any} */ (layer.ok ? layer.data : null),
		history: orElse(history, { items: [], nextCursor: null }),
		manifest: await currentManifest(api, appData),
	};
};

/**
 * A subscription seen by staff: the configuration overview (merchant, website, layers), the subscription, its
 * manifest (pinned version, feature schemas), the effective document (preview of an empty change) and the admin
 * and website histories.
 * @param {ConsoleApi} api
 * @param {string} subscriptionId
 */
export const loadSubscription = async (api, subscriptionId) => {
	const overview = await api.get(paths.adminConfig(subscriptionId));
	const failed = firstFailure(overview);
	if (failed) return failed;
	const o = /** @type {any} */ (overview.ok ? overview.data : {});
	const [subscription, app, adminHistory, websiteHistory, preview] = await Promise.all([
		api.get(paths.subscription(o.merchantId, subscriptionId)),
		api.get(paths.app(o.appId)),
		api.get(paths.adminHistory(subscriptionId, { level: 'admin' })),
		api.get(paths.adminHistory(subscriptionId, { level: 'website' })),
		api.post(paths.preview(o.merchantId, o.websiteId, subscriptionId), { change: {} }),
	]);
	const failedSub = firstFailure(subscription);
	if (failedSub) return failedSub;
	const sub = /** @type {any} */ (subscription.ok ? subscription.data.subscription : null);
	const pinned = await api.get(paths.version(o.appId, sub.manifestVersion));
	return {
		ok: /** @type {const} */ (true),
		overview: o,
		subscription: sub,
		app: orElse(app, null),
		manifest: /** @type {any} */ (pinned.ok ? (pinned.data.manifest ?? null) : null),
		effective: /** @type {any} */ (orElse(preview, { preview: null })?.preview ?? null),
		adminHistory: orElse(adminHistory, { items: [], nextCursor: null }),
		websiteHistory: orElse(websiteHistory, { items: [], nextCursor: null }),
	};
};

/**
 * Finance overview: reconciliation reports and alerts.
 * @param {ConsoleApi} api
 */
export const loadFinance = async (api) => {
	const [reports, alerts] = await Promise.all([api.get(paths.reconciliation()), api.get(paths.alerts())]);
	const failed = firstFailure(reports);
	if (failed) return failed;
	return { ok: /** @type {const} */ (true), reports: itemsOf(reports), alerts: itemsOf(alerts) };
};

/**
 * Ledger of one merchant (first page, ascending `seq`), balance and profile.
 * @param {ConsoleApi} api
 * @param {string} merchantId
 */
export const loadLedger = async (api, merchantId) => {
	const [merchant, balance, ledger] = await Promise.all([
		api.get(paths.merchant(merchantId)),
		api.get(paths.balance(merchantId)),
		api.get(paths.ledger(merchantId, { limit: 100 })),
	]);
	const failed = firstFailure(merchant, ledger);
	if (failed) return failed;
	return {
		ok: /** @type {const} */ (true),
		merchant: /** @type {any} */ (merchant.ok ? merchant.data : null),
		balance: orElse(balance, null),
		ledger: pageOf(ledger),
	};
};

const DELIVERY_STATUSES = Object.freeze(['pending', 'retrying', 'delivered', 'dead']);

/**
 * Integration: metrics and dead letters (all, or for a website/app), the delivery log for a website or app.
 * @param {ConsoleApi} api
 * @param {{ websiteId?: string, appId?: string, status?: string }} [filter]
 */
export const loadIntegration = async (api, filter = {}) => {
	const websiteId = pick(filter.websiteId, ID.website);
	const appId = pick(filter.appId, ID.app);
	const status = oneOf(filter.status, DELIVERY_STATUSES);
	const scope = { websiteId, appId };
	const [metrics, deadLetters, deliveries, apps] = await Promise.all([
		api.get(paths.metrics(scope)),
		api.get(paths.deadLetters(scope)),
		websiteId || appId ? api.get(paths.deliveries({ ...scope, status })) : Promise.resolve(null),
		api.get(paths.apps({ limit: 100 })),
	]);
	const failed = firstFailure(metrics, deadLetters);
	if (failed) return failed;
	return {
		ok: /** @type {const} */ (true),
		filter: { websiteId, appId, status },
		metrics: /** @type {any} */ (metrics.ok ? metrics.data : null),
		deadLetters: pageOf(deadLetters),
		deliveries: deliveries ? pageOf(deliveries) : null,
		deliveriesProblem: deliveries && !deliveries.ok ? deliveries.problem : null,
		apps: itemsOf(apps),
	};
};

export const CONNECTOR_KINDS = Object.freeze(['database', 'storage', 'ai', 'messaging', 'payments', 'analytics']);
export const CONNECTOR_STATUSES = Object.freeze(['connected', 'missing', 'failing', 'revoked']);

/**
 * Connector status list (never secrets: the staff view carries status and check reports only).
 * @param {ConsoleApi} api
 * @param {{ merchantId?: string, kind?: string, status?: string }} [filter]
 */
export const loadConnectors = async (api, filter = {}) => {
	const merchantId = pick(filter.merchantId, ID.merchant);
	const kind = oneOf(filter.kind, CONNECTOR_KINDS);
	const status = oneOf(filter.status, CONNECTOR_STATUSES);
	const list = await api.get(paths.connectors({ merchantId, kind, status }));
	const failed = firstFailure(list);
	if (failed) return failed;
	return { ok: /** @type {const} */ (true), filter: { merchantId, kind, status }, page: pageOf(list) };
};

const SCOPE = /^(global|merchant:mer_[0-9a-z]{10,64})$/;
const AUDIT_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const ACTION = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*(\.\*)?$/;

/**
 * Audit log: newest-first entries filtered by scope, actor, target or action (`credits.*` matches a prefix).
 * @param {ConsoleApi} api
 * @param {{ scope?: string, actorId?: string, targetId?: string, action?: string }} [filter]
 */
export const loadAudit = async (api, filter = {}) => {
	const f = {
		scope: pick(filter.scope, SCOPE),
		actorId: pick(filter.actorId, AUDIT_ID),
		targetId: pick(filter.targetId, AUDIT_ID),
		action: pick(filter.action, ACTION),
	};
	const list = await api.get(paths.audit(f));
	const failed = firstFailure(list);
	if (failed) return failed;
	return { ok: /** @type {const} */ (true), filter: f, page: pageOf(list) };
};

/**
 * Portal settings (needs `platform.settings.write`): the Portal URL, the preview URL, the mailer and the key ids.
 * @param {ConsoleApi} api
 * @param {any} staff the signed-in staff member
 */
export const loadSettings = async (api, staff) => {
	const settings = await api.get(paths.settings());
	const failed = firstFailure(settings);
	if (failed) return failed;
	return { ok: /** @type {const} */ (true), me: staff, settings: /** @type {any} */ (settings).data };
};

/**
 * Staff users (needs `platform.staff.manage`).
 * @param {ConsoleApi} api
 * @param {any} staff the signed-in staff member
 */
export const loadStaff = async (api, staff) => {
	const list = await api.get(paths.staffList());
	const failed = firstFailure(list);
	if (failed) return failed;
	return { ok: /** @type {const} */ (true), me: staff, items: itemsOf(list) };
};

/**
 * Subscription lookup by id (the configuration overview resolves its merchant and website).
 * @param {ConsoleApi} api
 * @param {{ id?: string }} [filter]
 */
export const loadSubscriptionLookup = async (api, filter = {}) => {
	const id = pick(filter.id?.trim(), ID.subscription);
	if (!id) return { ok: /** @type {const} */ (true), id: null, invalid: Boolean(filter.id), found: null };
	const overview = await api.get(paths.adminConfig(id));
	if (!overview.ok && overview.status !== 404) return /** @type {LoadFailure} */ (firstFailure(overview));
	return { ok: /** @type {const} */ (true), id, invalid: false, found: overview.ok ? overview.data : null };
};

/**
 * Impersonation state of a merchant session (for the merchant console banner): the staff member behind it and
 * when it ends, read from `GET /v1/system/whoami` (`actor.via`, `session.expiresAt`). Null for ordinary sessions.
 * @param {ConsoleApi} api
 * @returns {Promise<{ staffId: string, staffName: string | null, expiresAt: string | null } | null>}
 */
export const loadImpersonation = async (api) => {
	const who = await api.get(paths.whoami());
	if (!who.ok) return null;
	const data = /** @type {any} */ (who.data);
	const via = data?.actor?.via;
	if (data?.authMode !== 'merchant' || !via || typeof via.id !== 'string') return null;
	const expiresAt = data.session?.expiresAt;
	return {
		staffId: via.id,
		staffName: typeof via.name === 'string' ? via.name : null,
		expiresAt: typeof expiresAt === 'string' ? expiresAt : expiresAt ? new Date(expiresAt).toISOString() : null,
	};
};
