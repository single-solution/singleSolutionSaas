/**
 * Per-website work: sweep stale photo slots (objects never attached are deleted from the merchant's bucket, app-kit
 * `sweepStaleUploads`) and, with the request flow on, expire, send and remind due review requests through the
 * merchant's messaging connector. It runs in two ways (free-tier hosting, PLAN F.19):
 *
 * - after requests: `product.background.every('requests', 15 min, { per: 'website' })`, registered by `wireJobs`,
 *   runs it for the website a request was about, at most every 15 minutes, with small batches and a time budget;
 * - once a day: the Vercel cron (`GET /cron/requests` with `Authorization: Bearer $CRON_SECRET`) catches up every
 *   website this deployment serves (bounded per website; whatever is left is picked up by the next run).
 *
 * Correctness never waits for either: a request past its `expiresAt` reads as expired and a slot past its `staleAt`
 * can no longer be attached. Each website is independent: one failing website never stops the others. The per-website
 * work is the service's `sweepPhotos` and `runRequests`, passed in by the composition root (serve.js,
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

/** Interval of the per-website work after requests. */
export const WORK_INTERVAL_MS = 15 * 60_000;
/** Photo slots per website per sweep after a request (the daily cron uses the sweep's default). */
export const SWEEP_BATCH = 25;

/**
 * @typedef {{ runRequests: (site: any, options?: { deadline?: number }) => Promise<Record<string, number | boolean>>,
 *   sweepPhotos: (site: any, options?: { limit?: number }) => Promise<Record<string, number>> }} JobService
 */

/**
 * One website's work: the photo sweep always, the request flow when it is on (result keys unchanged).
 * @param {JobService} service
 * @param {{ settings: { requestFlow?: unknown } }} site
 * @param {{ deadline?: number, limit?: number }} [options] bounds for the run after a request
 * @returns {Promise<Record<string, unknown>>}
 */
export const websiteWork = async (service, site, { deadline, limit } = {}) => {
	const photos = await service.sweepPhotos(site, limit === undefined ? {} : { limit });
	return site.settings.requestFlow
		? { ...(await service.runRequests(site, deadline === undefined ? {} : { deadline })), photos }
		: { photos };
};

/**
 * Register the per-website work that runs after requests (throttled; one instance per interval). Called once per
 * product by the composition roots (serve.js, app/_lib/product.js); returns the application with its `work` task.
 * @template {{ product: { background: { every: Function } }, siteFor: (websiteId: string) => Promise<any>, service: JobService }} R
 * @param {R} reviews
 * @returns {R & { work: { name: string, trigger: (input?: { websiteId?: string | null }) => Promise<boolean> } }}
 */
export const wireJobs = (reviews) => ({
	...reviews,
	work: reviews.product.background.every(
		'requests',
		WORK_INTERVAL_MS,
		async (/** @type {{ websiteId: string, deadline: number }} */ { websiteId, deadline }) => {
			const site = await reviews.siteFor(websiteId);
			if (site) await websiteWork(reviews.service, site, { deadline, limit: SWEEP_BATCH });
		},
		{ per: 'website', budgetMs: 10_000 },
	),
});

/**
 * The daily cron route: catch-up over every website.
 * @param {{ app: { cronSecret: string | null, registry: { list: () => Promise<string[]> } },
 *   siteFor: (websiteId: string) => Promise<any>, service: JobService }} reviews
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
					run: (site) => websiteWork(service, site),
					onError: (websiteId, error) =>
						ctx.log?.error?.('request job failed', { websiteId, error: /** @type {Error} */ (error)?.message }),
				}),
			);
		},
	}),
];
