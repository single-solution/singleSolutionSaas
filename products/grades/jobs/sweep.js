/**
 * Sweep of inspection photo slots that were never confirmed — the object in the merchant's bucket (when it was
 * uploaded) and the slot record (app-kit `sweepStaleUploads`, bounded per run) — for websites with `inspection` on. It
 * runs in two ways (free-tier hosting, PLAN F.19):
 *
 * - after requests: `product.background.every('sweep', 1 h, { per: 'website' })`, registered by `wireJobs`, sweeps
 *   the website a request was about, at most once an hour, with a small batch;
 * - once a day: the Vercel cron (`GET /cron/sweep` with `Authorization: Bearer $CRON_SECRET`) catches up every website
 *   this deployment serves (bounded per website; whatever is left is picked up by the next run).
 *
 * Correctness never waits for either: a slot past its `staleAt` never counts towards an inspection (api/inspections.js).
 * Each website is independent: one failing website never stops the others. The per-website work is the service's
 * `sweepPhotos`, passed in by the composition root (serve.js, app/_lib/product.js), so this layer depends on no
 * handler code.
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
export const runSweepJob = async ({ websiteIds, siteFor, wants, run, onError = () => {} }) => {
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

/** Interval of the per-website sweep after requests. */
export const SWEEP_INTERVAL_MS = 60 * 60_000;
/** Slots per website per sweep after a request (the daily cron uses the sweep's default). */
export const SWEEP_BATCH = 25;

/**
 * Register the per-website sweep that runs after requests (throttled; one instance per interval). Called once per
 * product by the composition roots (serve.js, app/_lib/product.js); returns the application with its `sweep` task.
 * @template {{ product: { background: { every: Function } }, siteFor: (websiteId: string) => Promise<any>,
 *   service: { sweepPhotos: (site: any, options?: { limit?: number }) => Promise<Record<string, number>> } }} G
 * @param {G} grades
 * @returns {G & { sweep: { name: string, trigger: (input?: { websiteId?: string | null }) => Promise<boolean> } }}
 */
export const wireJobs = (grades) => ({
	...grades,
	sweep: grades.product.background.every(
		'sweep',
		SWEEP_INTERVAL_MS,
		async (/** @type {{ websiteId: string }} */ { websiteId }) => {
			const site = await grades.siteFor(websiteId);
			if (site && site.settings.enabled('inspection')) await grades.service.sweepPhotos(site, { limit: SWEEP_BATCH });
		},
		{ per: 'website', budgetMs: 10_000 },
	),
});

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
 * The daily cron route: catch-up over every website.
 * @param {{ app: { cronSecret: string | null, registry: { list: () => Promise<string[]> } },
 *   siteFor: (websiteId: string) => Promise<any>,
 *   service: { sweepPhotos: (site: any) => Promise<Record<string, number>> } }} grades
 */
export const cronRoutes = ({ app, siteFor, service }) => [
	defineRoute({
		method: 'GET',
		path: '/cron/sweep',
		auth: 'none',
		handler: async (ctx) => {
			if (!cronAuthorized(ctx.headers.get('authorization'), app.cronSecret))
				return problem('unauthorized', 'Cron secret required.');
			return ok(
				await runSweepJob({
					websiteIds: await app.registry.list(),
					siteFor,
					wants: (site) => site.settings.enabled('inspection'),
					run: async (site) => ({ photos: await service.sweepPhotos(site) }),
					onError: (websiteId, error) =>
						ctx.log?.error?.('sweep job failed', { websiteId, error: /** @type {Error} */ (error)?.message }),
				}),
				{ headers: { 'cache-control': 'no-store' } },
			);
		},
	}),
];
