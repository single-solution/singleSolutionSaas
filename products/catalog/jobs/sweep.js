/**
 * Sweep: publish `item.updated@1` for items whose scheduled publish / unpublish time passed, release expired stock
 * reservations, and republish event outbox entries a crashed request left behind. Free-tier hosting (Vercel Hobby)
 * allows one daily cron per deployment, so it runs in two ways:
 *
 * - **after requests** (`scheduleSweep`, registered by the composition root with app-kit `background.every`): at most
 *   once every `SWEEP_INTERVAL_MS` per website, after any request that carries that website, a small bounded pass;
 * - **daily catch-up** (Vercel cron → `GET /cron/sweep` with `Authorization: Bearer $CRON_SECRET`): the same pass for
 *   every website this deployment serves, for websites without traffic. Each website is independent: one failing
 *   website never stops the others; each step is bounded per website and the next run continues.
 *
 * Correctness never waits for it: public listings filter on the publish / unpublish times at read time, and an expired
 * reservation is treated as expired (and released) when it is read or a new reservation is taken. The per-website work
 * is passed in by the composition root (serve.js, app/_lib/product.js), so this layer depends on no handler code.
 */
import { timingSafeEqual } from 'node:crypto';
import { defineRoute, ok, problem } from '@ss/app-kit';

/**
 * @template S
 * @param {{ websiteIds: readonly string[], siteFor: (websiteId: string) => Promise<S | null>,
 *   run: (site: S) => Promise<Record<string, number>>, onError?: (websiteId: string, error: unknown) => void }} input
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

/** Background sweep: at most one pass per website every 5 minutes, after requests. */
export const SWEEP_INTERVAL_MS = 5 * 60_000;
/** Records per step of one background pass (the daily cron takes more). */
export const SWEEP_BACKGROUND_LIMIT = 50;

/**
 * Register the background sweep (app-kit `product.background.every`, per website) and return the catalog with the
 * task under `tasks.sweep` (tests and tools call `trigger({ websiteId })`).
 * @template {{ product: any, siteFor: (websiteId: string) => Promise<any>,
 *   sweepSite: (site: any, options?: { limit?: number }) => Promise<Record<string, number>> }} C
 * @param {C} catalog
 * @returns {C & { tasks: { sweep: { name: string, trigger: (input?: { websiteId?: string | null }) => Promise<boolean> } } }}
 */
export const scheduleSweep = (catalog) => {
	const sweep = catalog.product.background.every(
		'sweep',
		SWEEP_INTERVAL_MS,
		async (/** @type {{ websiteId: string | null }} */ { websiteId }) => {
			const site = await catalog.siteFor(/** @type {string} */ (websiteId));
			if (site) await catalog.sweepSite(site, { limit: SWEEP_BACKGROUND_LIMIT });
		},
		{ per: 'website', budgetMs: 10_000 },
	);
	return { ...catalog, tasks: Object.freeze({ sweep }) };
};

/**
 * The cron route (daily catch-up over every website).
 * @param {{ app: { cronSecret: string | null, registry: { list: () => Promise<string[]> } },
 *   siteFor: (websiteId: string) => Promise<any>,
 *   sweepSite: (site: any, options?: { limit?: number }) => Promise<Record<string, number>> }} catalog
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
