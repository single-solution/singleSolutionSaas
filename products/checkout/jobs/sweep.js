/**
 * Scheduled work (PLAN F.19, free-tier hosting: one daily cron per deployment).
 *
 * - **Daily catch-up** (Vercel cron, once a day → `GET /cron/sweep` with `Authorization: Bearer $CRON_SECRET`): for
 *   every website this deployment serves, cancel unpaid / unconfirmed orders whose hold expired (stock, codes and points
 *   go back through `order.cancelled@1`), publish `checkout.cart_abandoned@1` once for carts left alone, then a
 *   heartbeat. Bounded pages per website; what is left is picked up by the next run. Each website is independent: one
 *   failing website never stops the others.
 * - **On requests** (`wireJobs`, `product.background.every`): after a request for a website, the same work runs for
 *   that one website — expired holds at most every {@link HOLDS_INTERVAL_MS}, abandoned carts at most every
 *   {@link ABANDONED_INTERVAL_MS} — in small pages within the run's deadline.
 *
 * Correctness never waits for either: an order whose hold expired is cancelled (and its stock released) when it is read,
 * is never counted as open, and placement releases expired holds before refusing for stock (api/orders.js).
 */
import { timingSafeEqual } from 'node:crypto';
import { defineRoute, ok, problem } from '@ss/app-kit';

/** Items handled per website per page. */
const PAGE = 100;
/** Pages per website per run (bounded work per invocation). */
const MAX_PAGES = 10;

/**
 * @template S
 * @param {{ websiteIds: readonly string[], siteFor: (websiteId: string) => Promise<S | null>,
 *   tasks: Record<string, (site: S, options: { limit: number }) => Promise<number>>, onError?: (websiteId: string, error: unknown) => void }} input
 */
export const runSweepJob = async ({ websiteIds, siteFor, tasks, onError = () => {} }) => {
	/** @type {Array<Record<string, unknown>>} */
	const results = [];
	for (const websiteId of websiteIds) {
		try {
			const site = await siteFor(websiteId);
			if (!site) continue;
			/** @type {Record<string, unknown>} */
			const row = { websiteId };
			for (const [name, task] of Object.entries(tasks)) {
				let done = 0;
				for (let page = 0; page < MAX_PAGES; page += 1) {
					const count = await task(site, { limit: PAGE });
					done += count;
					if (count < PAGE) break;
				}
				row[name] = done;
			}
			results.push(row);
		} catch (error) {
			onError(websiteId, error);
			results.push({ websiteId, error: 'failed' });
		}
	}
	return { websites: results.length, results };
};

/** Expired holds: at most one run per website per 5 minutes, after a request for that website. */
export const HOLDS_INTERVAL_MS = 5 * 60_000;
/** Abandoned carts: at most one run per website per hour. */
export const ABANDONED_INTERVAL_MS = 60 * 60_000;
/** Items per page of a background run. */
const BACKGROUND_PAGE = 50;
/** Pages per background run (also stopped by the run's deadline). */
const BACKGROUND_PAGES = 4;

/**
 * Run one task for one website in small pages until it is done, the page budget is spent or the deadline passed.
 * @template S
 * @param {(site: S, options: { limit: number }) => Promise<number>} task
 * @param {S} site
 * @param {{ deadline: number, now: () => number, limit?: number, pages?: number }} options
 */
export const drain = async (task, site, { deadline, now, limit = BACKGROUND_PAGE, pages = BACKGROUND_PAGES }) => {
	let done = 0;
	for (let page = 0; page < pages && now() < deadline; page += 1) {
		const count = await task(site, { limit });
		done += count;
		if (count < limit) break;
	}
	return done;
};

/** @typedef {{ name: string, trigger: (input?: { websiteId?: string | null }) => Promise<boolean> }} EveryTask */

/**
 * Register the throttled per-website work that runs after requests (once per application instance, from the
 * composition root: app/_lib/product.js, serve.js).
 * @template {{ product: { background: { every: Function } }, app: { now: () => number },
 *   siteFor: (websiteId: string) => Promise<any>, orders: { expire: Function, abandon: Function } }} A
 * @param {A} application
 * @returns {A & { jobs: { holds: EveryTask, abandoned: EveryTask } }}
 */
export const wireJobs = (application) => {
	const { product, app, siteFor, orders } = application;
	/**
	 * @param {string} name
	 * @param {number} intervalMs
	 * @param {(site: any, options: { limit: number }) => Promise<number>} task
	 */
	const register = (name, intervalMs, task) =>
		product.background.every(
			name,
			intervalMs,
			async (/** @type {{ websiteId: string, deadline: number }} */ { websiteId, deadline }) => {
				const site = await siteFor(websiteId);
				return site ? drain(task, site, { deadline, now: app.now }) : 0;
			},
			{ per: 'website' },
		);
	const jobs = {
		holds: register('holds', HOLDS_INTERVAL_MS, (site, options) => orders.expire(site, options)),
		abandoned: register('abandoned', ABANDONED_INTERVAL_MS, (site, options) => orders.abandon(site, options)),
	};
	return { ...application, jobs };
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
 * @param {{ app: { cronSecret: string | null, registry: { list: () => Promise<string[]> } },
 *   product: { heartbeat: () => Promise<unknown> }, siteFor: (websiteId: string) => Promise<any>,
 *   orders: { expire: (site: any, o: { limit: number }) => Promise<number>, abandon: (site: any, o: { limit: number }) => Promise<number> } }} application
 */
export const cronRoutes = ({ app, product, siteFor, orders }) => [
	defineRoute({
		method: 'GET',
		path: '/cron/sweep',
		auth: 'none',
		handler: async (ctx) => {
			if (!cronAuthorized(ctx.headers.get('authorization'), app.cronSecret))
				return problem('unauthorized', 'Cron secret required.');
			const swept = await runSweepJob({
				websiteIds: await app.registry.list(),
				siteFor: (websiteId) => siteFor(websiteId),
				tasks: { expired: orders.expire, abandoned: orders.abandon },
				onError: (websiteId, error) =>
					ctx.log?.error?.('sweep job failed', { websiteId, error: /** @type {Error} */ (error)?.message }),
			});
			try {
				await product.heartbeat();
			} catch {
				// the Portal may be unreachable; the heartbeat is retried on the next run
			}
			return ok(swept);
		},
	}),
];
