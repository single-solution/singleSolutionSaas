/**
 * Scheduled job (Vercel cron → `GET /cron/dispatch` with `Authorization: Bearer $CRON_SECRET`, every few minutes): for
 * every website this deployment serves — repair stale claims, resume open trigger runs (waitlists larger than the
 * fan-out limit), then send due messages (deferred by quiet hours, batching windows, caps or retries). Each website is
 * independent: one failing website never stops the others. The per-website work is passed in by the composition root
 * (serve.js, app/_lib/product.js), so this layer depends on no handler code.
 */
import { timingSafeEqual } from 'node:crypto';
import { defineRoute, ok, problem } from '@ss/app-kit';

/**
 * @template S
 * @param {{ websiteIds: readonly string[], siteFor: (websiteId: string) => Promise<S | null>,
 *   run: (site: S) => Promise<Record<string, unknown>>, onError?: (websiteId: string, error: unknown) => void }} input
 * @returns {Promise<{ websites: number, results: Array<Record<string, unknown>> }>}
 */
export const runDispatchJob = async ({ websiteIds, siteFor, run, onError = () => {} }) => {
	/** @type {Array<Record<string, unknown>>} */
	const results = [];
	for (const websiteId of websiteIds) {
		try {
			const site = await siteFor(websiteId);
			if (site) results.push({ websiteId, ...(await run(site)) });
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
 *   siteFor: (websiteId: string) => Promise<any>,
 *   dispatcher: { run: (site: any, options?: { limit?: number }) => Promise<Record<string, unknown>>, recover: (site: any) => Promise<Record<string, unknown>> },
 *   engine: { resume: (site: any) => Promise<Record<string, unknown>> } }} alerts
 */
export const cronRoutes = ({ app, siteFor, dispatcher, engine }) => [
	defineRoute({
		method: 'GET',
		path: '/cron/dispatch',
		auth: 'none',
		handler: async (ctx) => {
			if (!cronAuthorized(ctx.headers.get('authorization'), app.cronSecret))
				return problem('unauthorized', 'Cron secret required.');
			return ok(
				await runDispatchJob({
					websiteIds: await app.registry.list(),
					siteFor: (websiteId) => siteFor(websiteId),
					run: async (site) => {
						const recovered = await dispatcher.recover(site);
						const resumed = await engine.resume(site);
						return { recovered, resumed, ...(await dispatcher.run(site, { limit: 500 })) };
					},
					onError: (websiteId, error) =>
						ctx.log?.error?.('dispatch job failed', { websiteId, error: /** @type {Error} */ (error)?.message }),
				}),
			);
		},
	}),
];
