/**
 * Scheduled maintenance (Vercel cron → `GET /cron/maintenance` with `Authorization: Bearer $CRON_SECRET`): for every
 * website this deployment serves — refresh due knowledge pages, record SLA breaches, wake snoozed conversations,
 * auto-close idle ones and purge soft-deleted records — then flush the usage queue to the Portal. Websites are
 * independent: one failing website never stops the others. The per-website work is the service's `maintain`, passed
 * in by the composition root (serve.js, app/_lib/product.js), so this layer depends on no handler code.
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
				run: async (site) => ({
					...(await service.maintain(site)),
					purged: await purgeDeleted({
						repos: site.repos,
						days: site.settings.transcripts.deleted_retention_days,
						now: app.now,
					}),
				}),
				onError: (websiteId, error) =>
					ctx.log?.error?.('maintenance failed', { websiteId, error: /** @type {Error} */ (error)?.message }),
			});
			// usage and events are flushed by app-kit's background flusher (after requests / heartbeat), not here
			return ok(report);
		},
	}),
];
