/**
 * The `connectors` module: client-owned resources (PLAN §1a). See `service.js` for the custody rules.
 *
 * Every outbound connection of a check follows one `@ss/net` outbound policy built from
 * `ctx.config.outbound.allowHosts` (`OUTBOUND_DEV_ALLOW_HOSTS`: exact hosts/IPs that may be private, plain http or
 * non-TLS — always empty in production). `createConnectorsModule(options)` lets tests inject the allowlist, the DNS
 * resolver of the policy, the MongoDB client factory and the probes.
 * @module
 */
import { createOutboundPolicy } from '@ss/net';
import { defineModule } from '../../infra/modules.js';
import { createProbes } from './adapters/probes.js';
import { connectorsRoutes } from './routes.js';
import { collections } from './schema.js';
import { createConnectorsService } from './service.js';

export const HEALTH_CRON = 'connectors-health';
export const HEALTH_JOB = 'connectors.health_check';
const MAX_ROUNDS = 30;
/** Response bodies of connection checks are read up to this size. */
export const CHECK_MAX_BYTES = 64 * 1024;

/**
 * @param {{ allowHosts?: ReadonlyArray<string>, resolve?: import('@ss/net').Resolver,
 *   connectMongo?: import('./adapters/probes.js').ConnectMongo, probes?: import('./adapters/probes.js').Probes,
 *   httpTimeoutMs?: number }} [options] `allowHosts` overrides `ctx.config.outbound.allowHosts` (ignored in production)
 */
export const createConnectorsModule = (options = {}) =>
	defineModule({
		name: 'connectors',
		collections,
		service: (ctx) => {
			const policy = createOutboundPolicy({
				allowHosts: ctx.config.isProduction ? [] : [...(options.allowHosts ?? ctx.config.outbound.allowHosts)],
				maxRedirects: 0,
				maxBytes: CHECK_MAX_BYTES,
				userAgent: 'ss-portal-connectors/1',
				...(options.resolve ? { resolve: options.resolve } : {}),
			});
			const probes =
				options.probes ??
				createProbes({
					policy,
					now: ctx.now,
					randomBytes: ctx.randomBytes,
					...(options.connectMongo ? { connectMongo: options.connectMongo } : {}),
					...(options.httpTimeoutMs ? { httpTimeoutMs: options.httpTimeoutMs } : {}),
				});
			return createConnectorsService(ctx, { policy, probes });
		},
		routes: (ctx) => connectorsRoutes(ctx.service('connectors')),
		jobs: (ctx) => ({
			[HEALTH_JOB]: async (payload, { deadline, signal }) => {
				const result = await ctx.service('connectors').healthCheck({ deadline, signal });
				const round = Number(payload?.round ?? 0) + 1;
				// continue in the next daily drain (never spin inside this one), at most MAX_ROUNDS times per run
				if (result.remaining && round <= MAX_ROUNDS) {
					await ctx.jobs.enqueue({
						name: HEALTH_JOB,
						key: `${HEALTH_JOB}:${payload?.hour ?? 'manual'}:${round}`,
						payload: { hour: payload?.hour ?? 'manual', round },
						runAt: ctx.now() + 60_000,
						maxAttempts: 3,
						daily: true,
					});
				}
				return result;
			},
		}),
		crons: (ctx) => ({
			// a step of the daily cron: check what is due within its deadline; what is left stays due for the next run
			// (connectors are also checked on demand: test, rotate, update, assign)
			[HEALTH_CRON]: async ({ deadline, signal }) => ctx.service('connectors').healthCheck({ deadline, signal }),
		}),
	});

export const connectorsModule = createConnectorsModule();
