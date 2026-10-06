/**
 * Maintenance of one website: execute deletions whose cooling-off ended, rotate the issuer's signing key when it is due
 * (pre-published first), prune superseded keys and — once per issuer configuration, while the Portal does not carry
 * it — ask the Portal to make Signups the website's identity issuer (best effort; the merchant approves). It runs in
 * two ways (free-tier hosting, PLAN F.19):
 *
 * - after requests: `product.background.every('maintenance', 1 h, { per: 'website' })`, registered by `wireJobs`, runs
 *   it for the website a request was about, at most once an hour;
 * - once a day: the Vercel cron (`GET /cron/maintenance` with `Authorization: Bearer $CRON_SECRET`) catches up every
 *   website this deployment serves (deletions bounded per run; whatever is left is picked up by the next run).
 *
 * Correctness never waits for either: a customer whose deletion is due is deleted when accessed (sign-in, refresh,
 * identity, the customer routes), signing keys rotate lazily when due, and expired codes, links, counters and sessions
 * are refused on read and removed by TTL indexes. Each website is independent: one failing website never stops the
 * others. The per-website work is the service's `maintain`, passed in by the composition root (serve.js,
 * app/_lib/product.js), so this layer depends on no handler code.
 */
import { timingSafeEqual } from 'node:crypto';
import { defineRoute, ok, problem } from '@ss/app-kit';

/**
 * @template S
 * @param {{ websiteIds: readonly string[], siteFor: (websiteId: string) => Promise<S | null>,
 *   run: (site: S) => Promise<Record<string, number>>, onError?: (websiteId: string, error: unknown) => void }} input
 * @returns {Promise<{ websites: number, results: Array<Record<string, unknown>> }>}
 */
export const runMaintenance = async ({ websiteIds, siteFor, run, onError = () => {} }) => {
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

/** Interval of the per-website maintenance after requests. */
export const MAINTENANCE_INTERVAL_MS = 60 * 60_000;

/**
 * Register the per-website maintenance that runs after requests (throttled; one instance per interval). Called once
 * per product by the composition roots (serve.js, app/_lib/product.js); returns the application with its
 * `maintenance` task.
 * @template {{ product: { background: { every: Function } }, siteFor: (websiteId: string) => Promise<any>,
 *   service: { maintain: (site: any) => Promise<Record<string, number>> } }} S
 * @param {S} signups
 * @returns {S & { maintenance: { name: string, trigger: (input?: { websiteId?: string | null }) => Promise<boolean> } }}
 */
export const wireJobs = (signups) => ({
	...signups,
	maintenance: signups.product.background.every(
		'maintenance',
		MAINTENANCE_INTERVAL_MS,
		async (/** @type {{ websiteId: string }} */ { websiteId }) => {
			const site = await signups.siteFor(websiteId);
			if (site) await signups.service.maintain(site);
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
 *   siteFor: (websiteId: string) => Promise<any>, service: { maintain: (site: any) => Promise<Record<string, number>> } }} signups
 */
export const cronRoutes = ({ app, siteFor, service }) => [
	defineRoute({
		method: 'GET',
		path: '/cron/maintenance',
		auth: 'none',
		handler: async (ctx) => {
			if (!cronAuthorized(ctx.headers.get('authorization'), app.cronSecret))
				return problem('unauthorized', 'Cron secret required.');
			return ok(
				await runMaintenance({
					websiteIds: await app.registry.list(),
					siteFor,
					run: (site) => service.maintain(site),
					onError: (websiteId, error) =>
						ctx.log?.error?.('maintenance failed', { websiteId, error: /** @type {Error} */ (error)?.message }),
				}),
			);
		},
	}),
];
