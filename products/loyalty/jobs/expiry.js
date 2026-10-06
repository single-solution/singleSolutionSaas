/**
 * Daily catch-up job (Vercel cron, once a day → `GET /cron/expiry` with `Authorization: Bearer $CRON_SECRET`): for every
 * website this deployment serves, expire points FIFO, publish `loyalty.expiring@1` notices and review tiers. Correctness
 * never waits for it: points past their expiry are expired when the member is read or moves, and a throttled
 * per-website run happens after requests (`wireEvents` in api/routes.js). Each website is independent: one failing
 * website never stops the others. The per-website work is the service's `runExpiry`, passed
 * in by the composition root (serve.js, app/_lib/product.js), so this layer depends on no handler code.
 */
import { timingSafeEqual } from 'node:crypto';
import { defineRoute, ok, problem } from '@ss/app-kit';

/**
 * @template S
 * @param {{ websiteIds: readonly string[], siteFor: (websiteId: string) => Promise<S | null>,
 *   wants: (site: S) => boolean, run: (site: S) => Promise<Record<string, number>>,
 *   onError?: (websiteId: string, error: unknown) => void }} input
 * @returns {Promise<{ websites: number, results: Array<Record<string, unknown>> }>}
 */
export const runExpiryJob = async ({ websiteIds, siteFor, wants, run, onError = () => {} }) => {
	/** @type {Array<Record<string, unknown>>} */
	const results = [];
	for (const websiteId of websiteIds) {
		try {
			const site = await siteFor(websiteId);
			if (site && wants(site)) results.push({ websiteId, ...(await run(site)) });
		} catch (error) {
			onError(websiteId, error);
			results.push({ websiteId, error: 'failed' });
		}
	}
	return { websites: results.length, results };
};

/**
 * Constant-time bearer comparison.
 * @param {string | null} header
 * @param {string | null} secret
 */
export const cronAuthorized = (header, secret) => {
	if (!secret || !header) return false;
	const given = Buffer.from(header.replace(/^Bearer\s+/i, ''));
	const expected = Buffer.from(secret);
	return given.length === expected.length && timingSafeEqual(given, expected);
};

/**
 * The cron route.
 * @param {{ app: { cronSecret: string | null, registry: { list: () => Promise<string[]> } },
 *   siteFor: (websiteId: string) => Promise<any>, service: { runExpiry: (site: any) => Promise<Record<string, number>> } }} loyalty
 */
export const cronRoutes = ({ app, siteFor, service }) => [
	defineRoute({
		method: 'GET',
		path: '/cron/expiry',
		auth: 'none',
		handler: async (ctx) => {
			if (!cronAuthorized(ctx.headers.get('authorization'), app.cronSecret))
				return problem('unauthorized', 'Cron secret required.');
			return ok(
				await runExpiryJob({
					websiteIds: await app.registry.list(),
					siteFor,
					wants: (site) => Boolean(site.settings.expiry || site.settings.tiers),
					run: (site) => service.runExpiry(site),
					onError: (websiteId, error) =>
						ctx.log?.error?.('expiry job failed', { websiteId, error: /** @type {Error} */ (error)?.message }),
				}),
			);
		},
	}),
];
