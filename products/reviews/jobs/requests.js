/**
 * Hourly job (Vercel cron → `GET /cron/requests` with `Authorization: Bearer $CRON_SECRET`): for every website this
 * deployment serves, sweep stale photo slots (objects never attached are deleted from the merchant's bucket, app-kit
 * `sweepStaleUploads`) and, with the request flow on, expire, send and remind due review requests through the
 * merchant's messaging connector. Each website is independent: one failing website never stops the others. The
 * per-website work is the service's `sweepPhotos` and `runRequests`, passed in by the composition root (serve.js,
 * app/_lib/product.js), so this layer depends on no handler code.
 */
import { timingSafeEqual } from 'node:crypto';
import { defineRoute, ok, problem } from '@ss/app-kit';

/**
 * @template S
 * @param {{ websiteIds: readonly string[], siteFor: (websiteId: string) => Promise<S | null>,
 *   wants: (site: S) => boolean, run: (site: S) => Promise<Record<string, unknown>>,
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
 * One website's hourly work: the photo sweep always, the request flow when it is on (result keys unchanged).
 * @param {{ runRequests: (site: any) => Promise<Record<string, number | boolean>>,
 *   sweepPhotos: (site: any) => Promise<Record<string, number>> }} service
 * @param {{ settings: { requestFlow?: unknown } }} site
 * @returns {Promise<Record<string, unknown>>}
 */
export const hourlyWork = async (service, site) => {
	const photos = await service.sweepPhotos(site);
	return site.settings.requestFlow ? { ...(await service.runRequests(site)), photos } : { photos };
};

/**
 * The cron route.
 * @param {{ app: { cronSecret: string | null, registry: { list: () => Promise<string[]> } },
 *   siteFor: (websiteId: string) => Promise<any>, service: { runRequests: (site: any) => Promise<Record<string, number | boolean>>,
 *   sweepPhotos: (site: any) => Promise<Record<string, number>> } }} reviews
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
					wants: () => true,
					run: (site) => hourlyWork(service, site),
					onError: (websiteId, error) =>
						ctx.log?.error?.('request job failed', { websiteId, error: /** @type {Error} */ (error)?.message }),
				}),
			);
		},
	}),
];
