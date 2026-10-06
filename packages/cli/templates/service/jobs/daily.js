/**
 * The daily cron (Vercel Hobby runs crons at most once a day: `vercel.json` → `GET /cron/daily` with
 * `Authorization: Bearer $CRON_SECRET`). It is a catch-up, not the clock: work that must happen sooner runs when data is
 * touched and as throttled background work after requests (`product.background.every`, see `jobs/index.js`). Here: flush
 * the usage queue and the event outbox and send the heartbeat. Add bounded, resumable catch-up work over all websites
 * when the product keeps a list of them.
 */
import { timingSafeEqual } from 'node:crypto';
import { defineRoute, ok, problem } from '@ss/app-kit';

/**
 * Constant-time bearer comparison.
 * @param {string | null} header
 * @param {string | null | undefined} secret
 */
export const cronAuthorized = (header, secret) => {
	if (!secret || !header) return false;
	const given = Buffer.from(header.replace(/^Bearer\s+/i, ''));
	const expected = Buffer.from(secret);
	return given.length === expected.length && timingSafeEqual(given, expected);
};

/**
 * @param {{ product: { heartbeat: () => Promise<unknown> }, cronSecret: string | null | undefined }} input
 */
export const dailyRoutes = ({ product, cronSecret }) => [
	defineRoute({
		method: 'GET',
		path: '/cron/daily',
		auth: 'none',
		handler: async (ctx) => {
			if (!cronAuthorized(ctx.headers.get('authorization'), cronSecret))
				return problem('unauthorized', 'Cron secret required.');
			let heartbeat = true;
			try {
				await product.heartbeat();
			} catch {
				heartbeat = false; // the Portal may be unreachable; tomorrow's run (and every request) retries
			}
			return ok({ heartbeat });
		},
	}),
];
