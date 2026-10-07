/**
 * RFC 9457 problem documents → friendly messages and form field errors. The Portal answers every failure with a
 * problem (`type`, `title`, `status`, `detail`, optional `errors: [{ path, message }]` with JSON-pointer paths).
 * @module
 */

/**
 * @typedef {object} Problem
 * @property {string} [type]
 * @property {string} [title]
 * @property {number} [status]
 * @property {string} [detail]
 * @property {string} [code]
 * @property {ReadonlyArray<{ path?: string, message?: string, code?: string }>} [errors]
 */

/** Messages for codes whose server detail is too technical (or absent). */
const FRIENDLY = Object.freeze({
	network: 'We could not reach the Portal. Check your connection and try again.',
	unauthorized: 'Your session has ended. Sign in again.',
	forbidden: 'You do not have permission to do this.',
	not_found: 'This item does not exist or was removed.',
	rate_limited: 'Too many attempts. Wait a moment, then try again.',
	validation_failed: 'Some fields need your attention.',
	conflict: 'This changed in the meantime. Reload and try again.',
	idempotency_replay_no_body: 'This request was already sent. Reload to see the result.',
	internal_error: 'Something went wrong on our side. Try again in a moment.',
	service_unavailable: 'The service is temporarily unavailable. Try again shortly.',
	payload_too_large: 'The request is too large.',
	unsupported_media_type: 'The request could not be read.',
});

/** Codes whose server `detail` is written for people and is shown as is. */
const DETAIL_FIRST = new Set([
	'invalid_credentials',
	'token_invalid',
	'conflict',
	'forbidden',
	'not_found',
	'catalog_launch_refused',
	'account_locked',
]);

/**
 * Stable code of a problem: `code` member, else the last segment of `type`, else from the status.
 * @param {Problem | null | undefined} problem
 * @returns {string}
 */
export const problemCode = (problem) => {
	if (!problem) return 'internal_error';
	if (typeof problem.code === 'string' && problem.code) return problem.code;
	if (typeof problem.type === 'string' && problem.type && problem.type !== 'about:blank') {
		const last = problem.type.replace(/\/+$/, '').split('/').pop();
		if (last) return last;
	}
	const status = problem.status ?? 500;
	if (status === 401) return 'unauthorized';
	if (status === 403) return 'forbidden';
	if (status === 404) return 'not_found';
	if (status === 409) return 'conflict';
	if (status === 422) return 'validation_failed';
	if (status === 429) return 'rate_limited';
	if (status === 503) return 'service_unavailable';
	return 'internal_error';
};

/**
 * One friendly sentence for a problem.
 * @param {Problem | null | undefined} problem
 * @returns {string}
 */
export const describeProblem = (problem) => {
	const code = problemCode(problem);
	const detail = typeof problem?.detail === 'string' ? problem.detail.trim() : '';
	if (detail && DETAIL_FIRST.has(code)) return detail;
	const friendly = /** @type {Record<string, string>} */ (FRIENDLY)[code];
	if (friendly) return friendly;
	if (detail) return detail;
	return typeof problem?.title === 'string' && problem.title ? problem.title : FRIENDLY.internal_error;
};

/**
 * Field errors keyed by dotted field name: `/credentials/uri` → `credentials.uri`. `base` strips a prefix
 * (`/features/bar.message` with base `/features/` → `bar.message`). Only the first message per field is kept.
 * @param {Problem | null | undefined} problem
 * @param {{ base?: string }} [options]
 * @returns {Record<string, string>}
 */
export const fieldErrors = (problem, { base = '/' } = {}) => {
	/** @type {Record<string, string>} */
	const out = {};
	for (const error of problem?.errors ?? []) {
		const path = typeof error?.path === 'string' ? error.path : '';
		if (!path.startsWith(base) && !(base === '/' && path === '')) continue;
		const rest = path.slice(base.length);
		const name = base.endsWith('/') ? rest.replace(/\//g, '.') : rest.replace(/^\//, '').replace(/\//g, '.');
		const key = name || '_form';
		if (!(key in out))
			out[key] = typeof error.message === 'string' && error.message ? sentence(error.message) : 'Invalid value.';
	}
	return out;
};

/** @param {string} message */
const sentence = (message) => {
	const text = message.trim();
	const capital = text.charAt(0).toUpperCase() + text.slice(1);
	return /[.!?]$/.test(capital) ? capital : `${capital}.`;
};

/**
 * Network failure as a problem (fetch rejected).
 * @param {unknown} [error]
 * @returns {Problem}
 */
export const networkProblem = (error) => ({
	type: 'network',
	title: 'Network error',
	status: 0,
	detail: error instanceof Error ? error.message : 'Network error',
	code: 'network',
});
