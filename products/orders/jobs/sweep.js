/**
 * Scheduled work (PLAN F.19, free-tier hosting: one daily cron per deployment).
 *
 * - **Daily catch-up** (Vercel cron, once a day → `GET /cron/sweep` with `Authorization: Bearer $CRON_SECRET`): for
 *   every website this deployment serves, move orders whose status expired (auto-expiry), redeliver order outbox
 *   entries a crashed request left behind and retry customer messages — a bounded batch per website; what is left is
 *   picked up by the next run. Each website is independent: one failing website never stops the others.
 * - **On requests** (`wireJobs`, `product.background.every`): after a request for a website, the same sweep runs for
 *   that one website at most every {@link SWEEP_INTERVAL_MS}, in a small batch within the run's deadline.
 *
 * Correctness never waits for either: an order whose status expired is moved when it is read (api/lifecycle.js
 * `expiringOnRead`) and is not counted as open. The per-website work is passed in by the composition root
 * (serve.js, app/_lib/product.js), so this layer depends on no handler code.
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

/** Per-website sweep after requests: at most one run per website per 5 minutes. */
export const SWEEP_INTERVAL_MS = 5 * 60_000;
/** Items per step of a background run. */
const BACKGROUND_LIMIT = 50;

/** @typedef {{ name: string, trigger: (input?: { websiteId?: string | null }) => Promise<boolean> }} EveryTask */

/**
 * Register the throttled per-website sweep that runs after requests (once per application instance, from the
 * composition root: app/_lib/product.js, serve.js).
 * @template {{ product: { background: { every: Function } }, siteFor: (websiteId: string) => Promise<any>,
 *   sweepSite: (site: any, options?: { limit?: number, deadline?: number }) => Promise<Record<string, number>> }} O
 * @param {O} orders
 * @returns {O & { jobs: { sweep: EveryTask } }}
 */
export const wireJobs = (orders) => {
	const { product, siteFor, sweepSite } = orders;
	/** @type {EveryTask} */
	const sweep = product.background.every(
		'sweep',
		SWEEP_INTERVAL_MS,
		async (/** @type {{ websiteId: string, deadline: number }} */ { websiteId, deadline }) => {
			const site = await siteFor(websiteId);
			return site ? sweepSite(site, { limit: BACKGROUND_LIMIT, deadline }) : null;
		},
		{ per: 'website' },
	);
	return { ...orders, jobs: { sweep } };
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
 *   siteFor: (websiteId: string) => Promise<any>, sweepSite: (site: any) => Promise<Record<string, number>> }} orders
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
					run: sweepSite,
					onError: (websiteId, error) =>
						ctx.log?.error?.('sweep failed', { websiteId, error: /** @type {Error} */ (error)?.message }),
				}),
			);
		},
	}),
];
