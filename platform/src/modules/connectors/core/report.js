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

/** Built-in MongoDB roles that reach beyond one database (more than a product connection needs). */
const BROAD_ROLES = new Set([
	'root',
	'__system',
	'clusterAdmin',
	'clusterManager',
	'clusterMonitor',
	'hostManager',
	'backup',
	'restore',
	'readAnyDatabase',
	'readWriteAnyDatabase',
	'userAdminAnyDatabase',
	'dbAdminAnyDatabase',
	'atlasAdmin',
	'enableSharding',
]);

/**
 * Summarise `connectionStatus` (`showPrivileges: true`) for the report: role names (`role@db`), whether the user is
 * authenticated, and whether it holds more than least privilege (cluster/any-resource privileges, broad built-in
 * roles, or privileges on `admin` / other databases).
 * @param {unknown} status raw command result
 * @param {string} dbName target database
 * @returns {{ authenticated: boolean, roles: string[], overPrivileged: boolean }}
 */
export const analysePrivileges = (status, dbName) => {
	const authInfo = /** @type {any} */ (status)?.authInfo ?? {};
	const users = Array.isArray(authInfo.authenticatedUsers) ? authInfo.authenticatedUsers : [];
	/** @type {Array<{ role: string, db: string }>} */
	const roles = (Array.isArray(authInfo.authenticatedUserRoles) ? authInfo.authenticatedUserRoles : [])
		.filter((/** @type {any} */ r) => typeof r?.role === 'string' && typeof r?.db === 'string')
		.map((/** @type {any} */ r) => ({ role: String(r.role), db: String(r.db) }));
	const privileges = Array.isArray(authInfo.authenticatedUserPrivileges) ? authInfo.authenticatedUserPrivileges : [];
	const broadRole = roles.some((r) => BROAD_ROLES.has(r.role) || (r.db === 'admin' && r.role !== 'read'));
	const broadPrivilege = privileges.some((/** @type {any} */ p) => {
		const resource = p?.resource ?? {};
		if (resource.cluster === true || resource.anyResource === true) return true;
		return typeof resource.db === 'string' && resource.db !== dbName; // '' = every database
	});
	return {
		authenticated: users.length > 0,
		roles: roles.map((r) => `${r.role}@${r.db}`).sort(),
		overPrivileged: broadRole || broadPrivilege,
	};
};
