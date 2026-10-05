/**
 * Framework-free replies returned by the api/ handlers. `api/routes.js` turns them into app-kit results
 * (`ok`, `created`, `problem`), so handlers stay testable without the kit.
 */

/**
 * @typedef {{ kind: 'ok', status: number, body: unknown, headers?: Record<string, string> }
 *   | { kind: 'problem', code: string, detail?: string, errors?: Array<{ path: string, message: string, code?: string }> }} Reply
 */

/**
 * @param {unknown} body
 * @param {{ status?: number, headers?: Record<string, string> }} [init]
 * @returns {Reply}
 */
export const reply = (body, { status = 200, headers } = {}) => ({ kind: 'ok', status, body, ...(headers ? { headers } : {}) });

/**
 * @param {string} code a stable problem code (`@ss/contracts` PROBLEM_CODES)
 * @param {string} [detail]
 * @param {Array<{ path: string, message: string, code?: string }>} [errors]
 * @returns {Reply}
 */
export const fail = (code, detail, errors) => ({
	kind: 'problem',
	code,
	...(detail ? { detail } : {}),
	...(errors ? { errors } : {}),
});
