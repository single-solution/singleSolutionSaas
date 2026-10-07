/**
 * The answer of a product that cannot serve because of its configuration: 503 with
 * `{ status: 'misconfigured', problems }` on every route (`/.well-known/ss-app.json` included), so the
 * deployer and the Portal see the reason instead of a blank 500. Problems name variables, never values.
 * Dependency-free: the Next.js proxy imports it.
 * @module
 */

/**
 * @param {ReadonlyArray<string>} problems
 * @returns {Response}
 */
export const misconfiguredResponse = (problems) =>
	new Response(JSON.stringify({ status: 'misconfigured', problems: [...problems] }), {
		status: 503,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': '60' },
	});

/**
 * Remove anything secret-looking from an error message: credentials in URLs and long opaque tokens.
 * @param {string} message
 */
const scrub = (message) =>
	message
		.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[redacted]@')
		.replace(/[A-Za-z0-9_\-+/=]{32,}/g, '[redacted]')
		.slice(0, 500);

/**
 * The answer of a product whose start-up failed (database unreachable, unreadable files, …): 503 with
 * `{ status: 'unavailable', problems: [scrubbed message] }` instead of a blank 500, so the deployer sees the cause.
 * @param {unknown} error
 * @returns {Response}
 */
export const startupFailedResponse = (error) =>
	new Response(
		JSON.stringify({
			status: 'unavailable',
			problems: [`Start-up failed: ${scrub(String(/** @type {any} */ (error)?.message ?? error))}`],
		}),
		{ status: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': '30' } },
	);
