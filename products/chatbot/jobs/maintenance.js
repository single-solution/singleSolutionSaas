/**
 * Maintenance of one website: refresh due knowledge pages, record SLA breaches, wake snoozed conversations, auto-close
 * idle ones and purge soft-deleted records. It runs in two ways (free-tier hosting, PLAN F.19):
 *
 * - after requests: `product.background.every('maintenance', 15 min, { per: 'website' })`, registered by `wireJobs`,
 *   runs it for the website a request was about, at most once per interval, within a small time budget;
 * - once a day: the Vercel cron (`GET /cron/maintenance` with `Authorization: Bearer $CRON_SECRET`) catches up every
 *   website this deployment serves, in bounded batches (whatever is left is picked up by the next run).
 *
 * Correctness never waits for either: a snoozed conversation whose time has passed reads as open (adapters/db.js).
 * Websites are independent: one failing website never stops the others. Usage and events are flushed by app-kit.
 */
import { timingSafeEqual } from 'node:crypto';
import { defineRoute, ok, problem } from '@ss/app-kit';
import { purgeDeleted } from './purge-deleted.js';

/**
 * @template S
 * @param {{ websiteIds: readonly string[], siteFor: (websiteId: string) => Promise<S | null>, run: (site: S) => Promise<Record<string, unknown>>,
 *   onError?: (websiteId: string, error: unknown) => void }} input
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
export const MAINTENANCE_INTERVAL_MS = 15 * 60_000;

/**
 * Maintenance of one website (the service's `maintain` plus the purge of soft-deleted records).
 * @param {{ app: { now: () => number }, service: { maintain: (site: any, options?: { deadline?: number }) => Promise<Record<string, number>> } }} chatbot
 * @param {any} site
 * @param {{ deadline?: number }} [options] stop starting new knowledge refreshes past this instant
 */
export const maintainSite = async ({ app, service }, site, { deadline } = {}) => ({
	...(await service.maintain(site, deadline === undefined ? {} : { deadline })),
	purged: await purgeDeleted({ repos: site.repos, days: site.settings.transcripts.deleted_retention_days, now: app.now }),
});

/**
 * Register the per-website maintenance that runs after requests (throttled; one instance per interval). Called once
 * per product by the composition roots (serve.js, app/_lib/product.js); returns the chatbot with its `maintenance` task.
 * @template {{ product: { background: { every: Function } }, app: { now: () => number }, siteFor: (websiteId: string) => Promise<any>,
 *   service: { maintain: (site: any, options?: { deadline?: number }) => Promise<Record<string, number>> } }} C
 * @param {C} chatbot
 * @returns {C & { maintenance: { name: string, trigger: (input?: { websiteId?: string | null }) => Promise<boolean> } }}
 */
export const wireJobs = (chatbot) => ({
	...chatbot,
	maintenance: chatbot.product.background.every(
		'maintenance',
		MAINTENANCE_INTERVAL_MS,
		async (/** @type {{ websiteId: string, deadline: number }} */ { websiteId, deadline }) => {
			const site = await chatbot.siteFor(websiteId);
			if (site) await maintainSite(chatbot, site, { deadline });
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
 * @param {{ app: { cronSecret: string | null, now: () => number, registry: { list: () => Promise<string[]> } },
 *   siteFor: (websiteId: string) => Promise<any>, service: { maintain: (site: any) => Promise<Record<string, number>> } }} chatbot
 */
export const cronRoutes = ({ app, siteFor, service }) => [
	defineRoute({
		method: 'GET',
		path: '/cron/maintenance',
		auth: 'none',
		handler: async (ctx) => {
			if (!cronAuthorized(ctx.headers.get('authorization'), app.cronSecret))
				return problem('unauthorized', 'Cron secret required.');
			const report = await runMaintenance({
				websiteIds: await app.registry.list(),
				siteFor,
				run: (site) => maintainSite({ app, service }, site),
				onError: (websiteId, error) =>
					ctx.log?.error?.('maintenance failed', { websiteId, error: /** @type {Error} */ (error)?.message }),
			});
			// usage and events are flushed by app-kit's background flusher (after requests / heartbeat), not here
			return ok(report);
		},
	}),
];
