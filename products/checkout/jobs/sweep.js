/**
 * Scheduled job (Vercel cron → `GET /cron/sweep` with `Authorization: Bearer $CRON_SECRET`): for every website this
 * deployment serves, cancel unpaid / unconfirmed orders whose hold expired (stock, codes and points go back through
 * `order.cancelled@1`), publish `checkout.cart_abandoned@1` once for carts left alone, then a heartbeat. Each website is
 * independent: one failing website never stops the others. The per-website work is passed in by the composition root.
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
