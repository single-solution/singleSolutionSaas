/**
 * Health endpoints. `healthz` is cheap and dependency-free. `readyz` checks the product control database (failure →
 * 503) and Portal reachability (JWKS fetch, cached for `portalCacheMs`); an unreachable Portal reports `degraded`
 * with 200, because products must keep serving on cached entitlements during a Portal outage (PLAN §12).
 * @module
 */

/**
 * @param {{
 *   product: { slug: string, version: string },
 *   portal: { jwks: () => Promise<unknown> },
 *   ping?: (() => Promise<void>) | null,
 *   now?: () => number,
 *   portalCacheMs?: number,
 *   timeoutMs?: number,
 * }} options
 */
export const createHealth = ({ product, portal, ping = null, now = Date.now, portalCacheMs = 30_000, timeoutMs = 3_000 }) => {
	/** @type {{ ok: boolean, at: number } | null} */
	let portalState = null;

	/**
	 * @template T
	 * @param {Promise<T>} promise
	 * @returns {Promise<T>}
	 */
	const withTimeout = (promise) =>
		Promise.race([
			promise,
			new Promise((_, reject) => {
				const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
				timer.unref?.();
			}),
		]);

	const healthz = () => ({ status: 200, body: { status: 'ok', product: product.slug, version: product.version } });

	const readyz = async () => {
		let cached = true;
		if (!portalState || now() - portalState.at >= portalCacheMs) {
			cached = false;
			const ok = await withTimeout(portal.jwks()).then(
				() => true,
				() => false,
			);
			portalState = { ok, at: now() };
		}
		/** @type {{ ok: boolean, skipped?: boolean }} */
		let db = { ok: true, skipped: true };
		if (ping) {
			db = await withTimeout(ping()).then(
				() => ({ ok: true }),
				() => ({ ok: false }),
			);
		}
		const status = !db.ok ? 'unavailable' : portalState.ok ? 'ok' : 'degraded';
		return {
			status: db.ok ? 200 : 503,
			body: {
				status,
				product: product.slug,
				version: product.version,
				checks: { portal: { ok: portalState.ok, cached }, productDb: db },
			},
		};
	};

	return Object.freeze({ healthz, readyz });
};
