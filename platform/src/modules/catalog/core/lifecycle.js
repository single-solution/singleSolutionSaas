/**
 * App lifecycle and version review state machines (pure).
 *
 *   pending ──activate──▶ active ──deprecate(sunsetAt)──▶ deprecated ──retire (at/after sunset)──▶ retired
 *      │                    ▲                                 │
 *      └──retire────────────┼──────── activate (undo) ────────┘
 *
 * Versions: pending ──approve──▶ accepted (becomes current; the previous current is superseded)
 *                   └─reject───▶ rejected          a newer pending candidate supersedes an older one
 * @module
 */

export const APP_STATUSES = Object.freeze(/** @type {const} */ (['pending', 'active', 'deprecated', 'retired']));
export const APP_ACTIONS = Object.freeze(/** @type {const} */ (['activate', 'deprecate', 'retire']));
export const VERSION_STATUSES = Object.freeze(/** @type {const} */ (['pending', 'accepted', 'superseded', 'rejected']));
/** Longest deprecation notice accepted (2 years). */
export const MAX_SUNSET_MS = 2 * 366 * 24 * 60 * 60_000;
/** Shortest deprecation notice accepted (1 day), so merchants always get a warning. */
export const MIN_SUNSET_MS = 24 * 60 * 60_000;

/** @typedef {typeof APP_STATUSES[number]} AppStatus */
/** @typedef {typeof APP_ACTIONS[number]} AppAction */
/** @typedef {typeof VERSION_STATUSES[number]} VersionStatus */

/**
 * Apply a lifecycle action.
 * @param {{ status: AppStatus, action: AppAction, now: number, sunsetAt?: string | null, currentSunsetAt?: Date | null,
 *   force?: boolean }} input
 * @returns {{ ok: true, status: AppStatus, sunsetAt: Date | null } | { ok: false, reason: string }}
 */
export const applyLifecycle = ({ status, action, now, sunsetAt, currentSunsetAt = null, force = false }) => {
	switch (action) {
		case 'activate':
			if (status === 'pending' || status === 'deprecated') return { ok: true, status: 'active', sunsetAt: null };
			return { ok: false, reason: `an app that is ${status} cannot be activated` };
		case 'deprecate': {
			if (status !== 'active') return { ok: false, reason: `an app that is ${status} cannot be deprecated` };
			const at = typeof sunsetAt === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(sunsetAt) ? Date.parse(sunsetAt) : NaN;
			if (!Number.isFinite(at)) return { ok: false, reason: 'sunsetAt must be an ISO-8601 UTC timestamp' };
			if (at < now + MIN_SUNSET_MS) return { ok: false, reason: 'sunsetAt must be at least one day ahead' };
			if (at > now + MAX_SUNSET_MS) return { ok: false, reason: 'sunsetAt must be within two years' };
			return { ok: true, status: 'deprecated', sunsetAt: new Date(at) };
		}
		case 'retire':
			if (status === 'pending') return { ok: true, status: 'retired', sunsetAt: currentSunsetAt };
			if (status !== 'deprecated')
				return { ok: false, reason: `an app that is ${status} cannot be retired (deprecate it first)` };
			if (!force && currentSunsetAt && currentSunsetAt.getTime() > now)
				return { ok: false, reason: 'the sunset date has not been reached (use force to retire early)' };
			return { ok: true, status: 'retired', sunsetAt: currentSunsetAt };
		default:
			return { ok: false, reason: `unknown action ${String(action)}` };
	}
};

/**
 * Deprecated apps whose sunset has passed are retired the first time they are read after it (no timer).
 * @param {{ status: string, sunsetAt?: Date | null }} app
 * @param {number} now
 */
export const dueForRetirement = (app, now) =>
	app.status === 'deprecated' && app.sunsetAt instanceof Date && app.sunsetAt.getTime() <= now;

/**
 * Can a version be reviewed?
 * @param {{ versionStatus: string, appStatus: string, action: 'approve' | 'reject' }} input
 * @returns {string | null} why not, or null
 */
export const reviewRefusal = ({ versionStatus, appStatus, action }) => {
	if (appStatus === 'retired') return 'the app is retired';
	if (versionStatus !== 'pending') return `the version is ${versionStatus}, not pending`;
	if (action !== 'approve' && action !== 'reject') return 'unknown review action';
	return null;
};

/**
 * Which launch kinds an app in this status accepts (pending apps: staff testing before listing only).
 * @param {string} status
 * @returns {ReadonlyArray<string>}
 */
export const launchKindsFor = (status) => {
	if (status === 'active' || status === 'deprecated')
		return ['merchant', 'demo', 'admin', 'impersonate', 'partner', 'developer'];
	if (status === 'pending') return ['admin', 'developer', 'demo'];
	return [];
};
