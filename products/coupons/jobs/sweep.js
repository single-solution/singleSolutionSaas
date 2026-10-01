/**
 * Scheduled job (Vercel cron → `GET /cron/sweep` with `Authorization: Bearer $CRON_SECRET`): for every website this
 * deployment serves, expire reservations whose TTL passed (their uses go back, `coupons.released@1` reason `expired`),
 * then send queued usage records (`redemption`) to the Portal and a heartbeat. Expired reservations are also swept
 * lazily whenever a code is full, so the job only bounds how long an abandoned checkout can hold a use. Each website is
 * independent: one failing website never stops the others. The per-website work (`sweep`) is passed in by the
 * composition root (serve.js, app/_lib/product.js), so this layer depends on no handler code.
 */
import { timingSafeEqual } from 'node:crypto';
import { defineRoute, ok, problem } from '@ss/app-kit';

/** Reservations expired per website per page. */
const PAGE = 100;
/** Pages per website per run (bounded work per invocation). */
const MAX_PAGES = 20;

/**
 * @template S
 * @param {{ websiteIds: readonly string[], siteFor: (websiteId: string) => Promise<S | null>,
 *   sweep: (site: S, options: { limit: number }) => Promise<number>, onError?: (websiteId: string, error: unknown) => void }} input
 * @returns {Promise<{ websites: number, expired: number, results: Array<Record<string, unknown>> }>}
 */
export const runSweepJob = async ({ websiteIds, siteFor, sweep, onError = () => {} }) => {
	/** @type {Array<Record<string, unknown>>} */
	const results = [];
	let total = 0;
	for (const websiteId of websiteIds) {
		try {
			const site = await siteFor(websiteId);
			if (!site) continue;
			let expired = 0;
			for (let page = 0; page < MAX_PAGES; page += 1) {
				const count = await sweep(site, { limit: PAGE });
				expired += count;
				if (count < PAGE) break;
			}
			total += expired;
			results.push({ websiteId, expired });
		} catch (error) {
			onError(websiteId, error);
			results.push({ websiteId, error: 'failed' });
		}
	}
	return { websites: results.length, expired: total, results };
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
 *   product: { heartbeat: () => Promise<unknown> },
 *   siteFor: (websiteId: string) => Promise<any>, service: { sweep: (site: any, options: { limit: number }) => Promise<number> } }} coupons
 */
export const cronRoutes = ({ app, product, siteFor, service }) => [
	defineRoute({
		method: 'GET',
		path: '/cron/sweep',
		auth: 'none',
		handler: async (ctx) => {
			if (!cronAuthorized(ctx.headers.get('authorization'), app.cronSecret))
				return problem('unauthorized', 'Cron secret required.');
			const swept = await runSweepJob({
				websiteIds: await app.registry.list(),
				siteFor,
				sweep: (site, options) => service.sweep(site, options),
				onError: (websiteId, error) =>
					ctx.log?.error?.('sweep job failed', { websiteId, error: /** @type {Error} */ (error)?.message }),
			});
			try {
				// app-kit flushes the usage queue and the event outbox before the heartbeat (and after requests)
				await product.heartbeat();
			} catch {
				// the Portal may be unreachable; the heartbeat is retried on the next run
			}
			return ok(swept);
		},
	}),
];
