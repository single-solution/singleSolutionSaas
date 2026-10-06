/**
 * Scheduled work. Free-tier hosting (Vercel Hobby) allows one daily cron per deployment, so the outbox runs in two ways:
 *
 * - **after requests** (`scheduleDispatch`, registered by the composition root with app-kit `background.every`): at most
 *   once every `DISPATCH_INTERVAL_MS` per website, after any request that carries that website, a short bounded pass
 *   (repair stale claims, resume open trigger runs, send due messages) within a time budget;
 * - **daily catch-up** (Vercel cron → `GET /cron/dispatch` with `Authorization: Bearer $CRON_SECRET`): the same pass for
 *   every website this deployment serves, for websites without traffic. Each website is independent: one failing
 *   website never stops the others. Whatever is not done today (bounded per website) is picked up by the next run.
 *
 * Deferred messages (quiet hours, batching windows, caps, retries) carry their own `notBefore`; message leases expire by
 * time and are taken over by whichever run comes next. The per-website work is passed in by the composition root
 * (serve.js, app/_lib/product.js), so this layer depends on no handler code.
 */
import { timingSafeEqual } from 'node:crypto';
import { defineRoute, ok, problem } from '@ss/app-kit';

/**
 * @template S
 * @param {{ websiteIds: readonly string[], siteFor: (websiteId: string) => Promise<S | null>,
 *   run: (site: S) => Promise<Record<string, unknown>>, onError?: (websiteId: string, error: unknown) => void }} input
 * @returns {Promise<{ websites: number, results: Array<Record<string, unknown>> }>}
 */
export const runDispatchJob = async ({ websiteIds, siteFor, run, onError = () => {} }) => {
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

/** Background dispatch: at most one pass per website every 5 minutes, after requests. */
export const DISPATCH_INTERVAL_MS = 5 * 60_000;
/** Time budget of one background pass (the request already answered; keep it well below the function limit). */
export const DISPATCH_BUDGET_MS = 10_000;

/**
 * One bounded dispatch pass over a website: repair stale claims, resume open trigger runs, send due messages.
 * @param {{ dispatcher: { run: (site: any, options?: { limit?: number, deadline?: number }) => Promise<Record<string, unknown>>,
 *   recover: (site: any) => Promise<Record<string, unknown>> },
 *   engine: { resume: (site: any) => Promise<Record<string, unknown>> } }} alerts
 * @param {any} site
 * @param {{ limit: number, deadline?: number }} options
 */
export const dispatchSite = async ({ dispatcher, engine }, site, { limit, deadline }) => {
	const recovered = await dispatcher.recover(site);
	const resumed = await engine.resume(site);
	return { recovered, resumed, ...(await dispatcher.run(site, { limit, ...(deadline ? { deadline } : {}) })) };
};

/**
 * Register the background dispatch pass (app-kit `product.background.every`, per website) and return the alerts with
 * the task under `tasks.dispatch` (tests and tools call `trigger({ websiteId })`).
 * @template {{ product: any, siteFor: (websiteId: string) => Promise<any>, dispatcher: any, engine: any }} A
 * @param {A} alerts
 * @returns {A & { tasks: { dispatch: { name: string, trigger: (input?: { websiteId?: string | null }) => Promise<boolean> } } }}
 */
export const scheduleDispatch = (alerts) => {
	const dispatch = alerts.product.background.every(
		'dispatch',
		DISPATCH_INTERVAL_MS,
		async (/** @type {{ websiteId: string | null, deadline: number }} */ { websiteId, deadline }) => {
			const site = await alerts.siteFor(/** @type {string} */ (websiteId));
			if (site) await dispatchSite(alerts, site, { limit: 50, deadline });
		},
		{ per: 'website', budgetMs: DISPATCH_BUDGET_MS },
	);
	return { ...alerts, tasks: Object.freeze({ dispatch }) };
};

/**
 * The cron route (daily catch-up over every website).
 * @param {{ app: { cronSecret: string | null, registry: { list: () => Promise<string[]> } },
 *   siteFor: (websiteId: string) => Promise<any>,
 *   dispatcher: { run: (site: any, options?: { limit?: number }) => Promise<Record<string, unknown>>, recover: (site: any) => Promise<Record<string, unknown>> },
 *   engine: { resume: (site: any) => Promise<Record<string, unknown>> } }} alerts
 */
export const cronRoutes = ({ app, siteFor, dispatcher, engine }) => [
	defineRoute({
		method: 'GET',
		path: '/cron/dispatch',
		auth: 'none',
		handler: async (ctx) => {
			if (!cronAuthorized(ctx.headers.get('authorization'), app.cronSecret))
				return problem('unauthorized', 'Cron secret required.');
			return ok(
				await runDispatchJob({
					websiteIds: await app.registry.list(),
					siteFor: (websiteId) => siteFor(websiteId),
					run: (site) => dispatchSite({ dispatcher, engine }, site, { limit: 500 }),
					onError: (websiteId, error) =>
						ctx.log?.error?.('dispatch job failed', { websiteId, error: /** @type {Error} */ (error)?.message }),
				}),
			);
		},
	}),
];
