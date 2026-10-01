/**
 * Hourly job (Vercel cron → `GET /cron/requests` with `Authorization: Bearer $CRON_SECRET`): for every website this
 * deployment serves with the request flow on, expire, send and remind due review requests through the merchant's
 * messaging connector. Each website is independent: one failing website never stops the others. The per-website work
 * is the service's `runRequests`, passed in by the composition root (serve.js, app/_lib/product.js), so this layer
 * depends on no handler code.
 */
import { timingSafeEqual } from 'node:crypto';
import { defineRoute, ok, problem } from '@ss/app-kit';

/**
 * @template S
 * @param {{ websiteIds: readonly string[], siteFor: (websiteId: string) => Promise<S | null>,
 *   wants: (site: S) => boolean, run: (site: S) => Promise<Record<string, number | boolean>>,
 *   onError?: (websiteId: string, error: unknown) => void }} input
 * @returns {Promise<{ websites: number, results: Array<Record<string, unknown>> }>}
 */
export const runRequestJob = async ({ websiteIds, siteFor, wants, run, onError = () => {} }) => {
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
 *   siteFor: (websiteId: string) => Promise<any>, service: { runRequests: (site: any) => Promise<Record<string, number | boolean>> } }} reviews
 */
export const cronRoutes = ({ app, siteFor, service }) => [
	defineRoute({
		method: 'GET',
		path: '/cron/requests',
		auth: 'none',
		handler: async (ctx) => {
			if (!cronAuthorized(ctx.headers.get('authorization'), app.cronSecret))
				return problem('unauthorized', 'Cron secret required.');
			return ok(
				await runRequestJob({
					websiteIds: await app.registry.list(),
					siteFor,
					wants: (site) => Boolean(site.settings.requestFlow),
					run: (site) => service.runRequests(site),
					onError: (websiteId, error) =>
						ctx.log?.error?.('request job failed', { websiteId, error: /** @type {Error} */ (error)?.message }),
				}),
			);
		},
	}),
];
