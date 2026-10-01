/**
 * Maintenance job (Vercel cron → `GET /cron/maintenance` with `Authorization: Bearer $CRON_SECRET`, every 5 minutes):
 * flushes the metered `quote` usage queue to the Portal (exactly once: the kit's queue is keyed by idempotency key and
 * the Portal dedupes) and sends the heartbeat. Expired quotes need no job — a TTL index removes them.
 */
import { timingSafeEqual } from 'node:crypto';
import { defineRoute, ok, problem } from '@ss/app-kit';

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
 * Run one maintenance pass; each step is independent (a failing heartbeat never blocks the usage flush).
 * @param {{ usage: { flush: (options?: { maxBatches?: number }) => Promise<Record<string, number>> }, heartbeat: () => Promise<unknown> }} product
 * @param {{ maxBatches?: number }} [options]
 */
export const runMaintenance = async (product, { maxBatches = 20 } = {}) => {
	/** @type {Record<string, unknown>} */
	const out = {};
	try {
		out.usage = await product.usage.flush({ maxBatches });
	} catch {
		out.usage = { error: 'failed' };
	}
	try {
		await product.heartbeat();
		out.heartbeat = 'sent';
	} catch {
		out.heartbeat = 'failed';
	}
	return out;
};

/**
 * The cron route.
 * @param {{ app: { cronSecret: string | null }, product: any }} deals
 */
export const cronRoutes = ({ app, product }) => [
	defineRoute({
		method: 'GET',
		path: '/cron/maintenance',
		auth: 'none',
		handler: async (ctx) => {
			if (!cronAuthorized(ctx.headers.get('authorization'), app.cronSecret))
				return problem('unauthorized', 'Cron secret required.');
			return ok(await runMaintenance(product));
		},
	}),
];
