/**
 * The answer of a product that cannot serve because of its configuration: 503 with
 * `{ status: 'misconfigured', problems }` on every route (`/healthz` and `/.well-known/ss-app.json` included), so the
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
