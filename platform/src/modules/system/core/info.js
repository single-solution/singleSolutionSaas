/**
 * Pure logic of the `system` module.
 * @module
 */

export const NOTICE_LEVELS = Object.freeze(['info', 'warning', 'critical']);

/**
 * @typedef {{ text: string, level: 'info' | 'warning' | 'critical' }} Notice
 */

/**
 * Public service description (`GET /v1/system/info`). Nothing secret, nothing per-tenant.
 * @param {{ portalUrl: string, version: string, env: string, modules: string[], notice: Notice | null, now: number }} input
 */
export const buildInfo = ({ portalUrl, version, env, modules, notice, now }) => ({
	name: 'Single Solution Portal',
	version,
	environment: env,
	portalUrl,
	jwksUrl: `${portalUrl}/.well-known/jwks.json`,
	apiVersion: 'v1',
	modules: [...modules].sort(),
	notice,
	time: new Date(now).toISOString(),
});

/**
 * Validate a notice update (`null` clears it).
 * @param {unknown} input
 * @returns {{ ok: true, value: Notice | null } | { ok: false, errors: Array<{ path: string, message: string }> }}
 */
export const validateNotice = (input) => {
	if (typeof input !== 'object' || input === null || Array.isArray(input)) {
		return { ok: false, errors: [{ path: '', message: 'body must be an object { notice }' }] };
	}
	const { notice, ...rest } = /** @type {Record<string, unknown>} */ (input);
	/** @type {Array<{ path: string, message: string }>} */
	const errors = Object.keys(rest).map((key) => ({ path: `/${key}`, message: 'unknown property' }));
	if (notice === null) return errors.length > 0 ? { ok: false, errors } : { ok: true, value: null };
	if (typeof notice !== 'object' || notice === undefined || Array.isArray(notice)) {
		return { ok: false, errors: [...errors, { path: '/notice', message: 'notice must be an object or null' }] };
	}
	const { text, level, ...unknown } = /** @type {Record<string, unknown>} */ (notice);
	for (const key of Object.keys(unknown)) errors.push({ path: `/notice/${key}`, message: 'unknown property' });
	if (typeof text !== 'string' || text.trim().length === 0 || text.length > 280)
		errors.push({ path: '/notice/text', message: 'text must be 1..280 characters' });
	if (!NOTICE_LEVELS.includes(String(level)))
		errors.push({ path: '/notice/level', message: `level must be one of ${NOTICE_LEVELS.join(', ')}` });
	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, value: { text: /** @type {string} */ (text).trim(), level: /** @type {Notice['level']} */ (level) } };
};
