/**
 * Sweep: run one step of every crawled source that is due, re-check the Atlas Search index state and remove vocabulary
 * terms no document uses any more. Free-tier hosting (Vercel Hobby) allows one daily cron per deployment, so it runs in
 * two ways:
 *
 * - **after requests** (`scheduleSweep`, registered by the composition root with app-kit `background.every`): at most
 *   once every `SWEEP_INTERVAL_MS` per website, after any request that carries that website, within a time budget;
 * - **daily catch-up** (Vercel cron → `GET /cron/sweep` with `Authorization: Bearer $CRON_SECRET`): the same work for
 *   every website this deployment serves, for websites without traffic.
 *
 * Whether a source is due is decided from its `nextRunAt` at the time of the run, so a missed run is simply done by the
 * next one; a crawl in progress continues step by step. Each website is independent: one failing website never stops
 * the others. The per-website work is passed in by the composition root (serve.js, app/_lib/product.js), so this layer
 * depends on no handler code.
 */
import { timingSafeEqual } from 'node:crypto';
import { defineRoute, ok, problem } from '@ss/app-kit';

/**
 * @template S
 * @param {{ websiteIds: readonly string[], siteFor: (websiteId: string) => Promise<S | null>,
 *   run: (site: S) => Promise<Record<string, unknown>>, onError?: (websiteId: string, error: unknown) => void }} input
 * @returns {Promise<{ websites: number, results: Array<Record<string, unknown>> }>}
 */
export const runSweep = async ({ websiteIds, siteFor, run, onError = () => {} }) => {
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

/** Background sweep: at most one pass per website every 15 minutes, after requests. */
export const SWEEP_INTERVAL_MS = 15 * 60_000;
/** Time budget of one background pass: no crawl step starts after it. */
export const SWEEP_BUDGET_MS = 10_000;

/**
 * Register the background sweep (app-kit `product.background.every`, per website) and return the search product with
 * the task under `tasks.sweep` (tests and tools call `trigger({ websiteId })`).
 * @template {{ product: any, siteFor: (websiteId: string) => Promise<any>,
 *   sweepSite: (site: any, options?: { deadline?: number }) => Promise<Record<string, unknown>> }} S
 * @param {S} search
 * @returns {S & { tasks: { sweep: { name: string, trigger: (input?: { websiteId?: string | null }) => Promise<boolean> } } }}
 */
export const scheduleSweep = (search) => {
	const sweep = search.product.background.every(
		'sweep',
		SWEEP_INTERVAL_MS,
		async (/** @type {{ websiteId: string | null, deadline: number }} */ { websiteId, deadline }) => {
			const site = await search.siteFor(/** @type {string} */ (websiteId));
			if (site) await search.sweepSite(site, { deadline });
		},
		{ per: 'website', budgetMs: SWEEP_BUDGET_MS },
	);
	return { ...search, tasks: Object.freeze({ sweep }) };
};

/**
 * The cron route (daily catch-up over every website).
 * @param {{ app: { cronSecret: string | null, registry: { list: () => Promise<string[]> } },
 *   siteFor: (websiteId: string) => Promise<any>,
 *   sweepSite: (site: any, options?: { deadline?: number }) => Promise<Record<string, unknown>> }} catalog
 */
export const cronRoutes = ({ app, siteFor, sweepSite }) => [
	defineRoute({
		method: 'GET',
		path: '/cron/sweep',
		auth: 'none',
		handler: async (ctx) => {
			if (!cronAuthorized(ctx.headers.get('authorization'), app.cronSecret))
				return problem('unauthorized', 'Cron secret required.');
			return ok(
				await runSweep({
					websiteIds: await app.registry.list(),
					siteFor,
					run: (site) => sweepSite(site),
					onError: (websiteId, error) =>
						ctx.log?.error?.('sweep failed', { websiteId, error: /** @type {Error} */ (error)?.message }),
				}),
			);
		},
	}),
];
