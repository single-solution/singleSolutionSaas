/**
 * The `connectors` module: client-owned resources (PLAN §1a). See `service.js` for the custody rules.
 *
 * `createConnectorsModule(options)` lets tests inject the DNS `lookup`, the MongoDB client factory, probes and the
 * development allowlist. The allowlist (exact hosts/IPs that may be private or plain-http/non-TLS) is honoured only
 * when `PORTAL_ENV` is `development` or `test`; by default it admits loopback in development and nothing elsewhere.
 * @module
 */
import { defineModule } from '../../infra/modules.js';
import { createProbes } from './adapters/probes.js';
import { allowlistFor } from './core/netguard.js';
import { connectorsRoutes } from './routes.js';
import { collections } from './schema.js';
import { createConnectorsService } from './service.js';

export const HEALTH_CRON = 'connectors-health';
export const HEALTH_JOB = 'connectors.health_check';
const MAX_ROUNDS = 30;
const DEV_LOOPBACK = Object.freeze(['localhost', '127.0.0.1', '::1']);

/**
 * @param {{ allowlist?: ReadonlyArray<string>, lookup?: import('./adapters/outbound.js').LookupFunction,
 *   connectMongo?: import('./adapters/probes.js').ConnectMongo, probes?: import('./adapters/probes.js').Probes,
 *   httpTimeoutMs?: number }} [options]
 */
export const createConnectorsModule = (options = {}) =>
	defineModule({
		name: 'connectors',
		collections,
		service: (ctx) => {
			const allowlist = allowlistFor(
				ctx.config.env,
				options.allowlist ?? (ctx.config.env === 'development' ? DEV_LOOPBACK : []),
			);
			const probes =
				options.probes ??
				createProbes({
					allowlist,
					now: ctx.now,
					randomBytes: ctx.randomBytes,
					...(options.lookup ? { lookup: options.lookup } : {}),
					...(options.connectMongo ? { connectMongo: options.connectMongo } : {}),
					...(options.httpTimeoutMs ? { httpTimeoutMs: options.httpTimeoutMs } : {}),
				});
			return createConnectorsService(ctx, { allowlist, probes });
		},
		routes: (ctx) => connectorsRoutes(ctx.service('connectors')),
		jobs: (ctx) => ({
			[HEALTH_JOB]: async (payload, { deadline, signal }) => {
				const result = await ctx.service('connectors').healthCheck({ deadline, signal });
				const round = Number(payload?.round ?? 0) + 1;
				// continue in a later drain (never spin inside this one), at most MAX_ROUNDS times per hour
				if (result.remaining && round <= MAX_ROUNDS) {
					await ctx.jobs.enqueue({
						name: HEALTH_JOB,
						key: `${HEALTH_JOB}:${payload?.hour ?? 'manual'}:${round}`,
						payload: { hour: payload?.hour ?? 'manual', round },
						runAt: ctx.now() + 60_000,
						maxAttempts: 3,
					});
				}
				return result;
			},
		}),
		crons: (ctx) => ({
			[HEALTH_CRON]: async () => {
				const hour = new Date(ctx.now()).toISOString().slice(0, 13);
				const { inserted } = await ctx.jobs.enqueue({
					name: HEALTH_JOB,
					key: `${HEALTH_JOB}:${hour}:0`,
					payload: { hour, round: 0 },
					maxAttempts: 3,
				});
				return { enqueued: inserted };
			},
		}),
	});

export const connectorsModule = createConnectorsModule();
