/**
 * Connection-check reports and connector status (pure). Reports carry only codes, names, counts and HTTP statuses
 * the Portal produced itself — never credentials, never upstream error text.
 * @module
 */

/**
 * @typedef {object} CheckStep
 * @property {string} name e.g. `reachability`, `auth`, `create_collection`, `put_object`
 * @property {boolean} ok
 * @property {string} [code] stable failure code (`unreachable`, `auth_failed`, `permission_denied`, `address_refused`, …)
 * @property {number} [status] upstream HTTP status, when there was one
 */

/**
 * @typedef {object} CheckReport
 * @property {boolean} ok
 * @property {boolean} [skipped] no automated check exists for this provider
 * @property {string} checkedAt ISO-8601
 * @property {number} durationMs
 * @property {CheckStep[]} checks
 * @property {string[]} warnings
 * @property {Record<string, unknown>} [info]
 */

/** Connector statuses (`@ss/contracts` `RESOURCE_STATUSES`). */
export const STATUSES = Object.freeze(/** @type {const} */ (['connected', 'missing', 'failing', 'revoked']));

/**
 * Status that follows a check report.
 * @param {CheckReport} report
 */
export const statusFromReport = (report) => (report.ok ? 'connected' : 'failing');

/**
 * Assemble a report from steps.
 * @param {{ steps: CheckStep[], warnings?: string[], info?: Record<string, unknown>, startedAt: number, now: number, skipped?: boolean }} input
 * @returns {CheckReport}
 */
export const buildReport = ({ steps, warnings = [], info, startedAt, now, skipped = false }) => ({
	ok: steps.every((step) => step.ok),
	...(skipped ? { skipped: true } : {}),
	checkedAt: new Date(now).toISOString(),
	durationMs: Math.max(0, now - startedAt),
	checks: steps.map((step) => ({
		name: step.name,
		ok: step.ok,
		...(step.code ? { code: step.code } : {}),
		...(step.status === undefined ? {} : { status: step.status }),
	})),
	warnings: [...new Set(warnings)],
	...(info ? { info } : {}),
});

/** Built-in MongoDB roles that reach beyond one database or into the cluster: always refused. */
const CLUSTER_ROLES = new Set([
	'root',
	'__system',
	'__queryableBackup',
	'clusterAdmin',
	'clusterManager',
	'clusterMonitor',
	'hostManager',
	'backup',
	'restore',
	'atlasAdmin',
	'enableSharding',
	'searchCoordinator',
	'directShardOperations',
]);
/** Administrative roles tolerated on the target database only (reported as a warning). */
const ADMIN_ROLES = new Set(['dbAdmin', 'dbOwner', 'userAdmin']);

/**
 * @typedef {object} PrivilegeAnalysis
 * @property {boolean} authenticated
 * @property {string[]} roles `role@db`, sorted
 * @property {boolean} overPrivileged the connection must be refused (`over_privileged`)
 * @property {string[]} reasons why: `cluster_role`, `any_database_role`, `other_database`, `cluster_privilege`
 * @property {string[]} warnings `db_admin` when dbAdmin / dbOwner / userAdmin is held on the target database
 */

/**
 * Least-privilege analysis of `connectionStatus` (`showPrivileges: true`). A product connection may hold privileges on
 * the target database only. Refused (`overPrivileged`): cluster-level roles (`root`, `clusterAdmin`, …), any
 * `*AnyDatabase` role, any role or privilege on another database (including `admin` and the every-database resource
 * `db: ''`), and cluster / any-resource privileges. `dbAdmin`, `dbOwner` and `userAdmin` on the target database are a
 * warning only.
 * @param {unknown} status raw command result
 * @param {string} dbName target database
 * @returns {PrivilegeAnalysis}
 */
export const analysePrivileges = (status, dbName) => {
	const authInfo = /** @type {any} */ (status)?.authInfo ?? {};
	const users = Array.isArray(authInfo.authenticatedUsers) ? authInfo.authenticatedUsers : [];
	/** @type {Array<{ role: string, db: string }>} */
	const roles = (Array.isArray(authInfo.authenticatedUserRoles) ? authInfo.authenticatedUserRoles : [])
		.filter((/** @type {any} */ r) => typeof r?.role === 'string' && typeof r?.db === 'string')
		.map((/** @type {any} */ r) => ({ role: String(r.role), db: String(r.db) }));
	const privileges = Array.isArray(authInfo.authenticatedUserPrivileges) ? authInfo.authenticatedUserPrivileges : [];
	/** @type {Set<string>} */
	const reasons = new Set();
	/** @type {Set<string>} */
	const warnings = new Set();
	for (const { role, db } of roles) {
		if (CLUSTER_ROLES.has(role)) reasons.add('cluster_role');
		else if (role.endsWith('AnyDatabase')) reasons.add('any_database_role');
		else if (db !== dbName) reasons.add('other_database');
		else if (ADMIN_ROLES.has(role)) warnings.add('db_admin');
	}
	for (const privilege of privileges) {
		const resource = /** @type {any} */ (privilege)?.resource ?? {};
		if (resource.cluster === true || resource.anyResource === true) reasons.add('cluster_privilege');
		else if (typeof resource.db === 'string' && resource.db !== dbName) reasons.add('other_database'); // '' = every db
	}
	return {
		authenticated: users.length > 0,
		roles: roles.map((r) => `${r.role}@${r.db}`).sort(),
		overPrivileged: reasons.size > 0,
		reasons: [...reasons].sort(),
		warnings: [...warnings],
	};
};
