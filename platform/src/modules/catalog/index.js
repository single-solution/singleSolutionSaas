/**
 * The `catalog` module: app registry for service products and element packs — registration handshake (Portal side),
 * signed pack bundles, manifest versions with diff and review, lifecycle, environments, app keys (`appKeys` port),
 * health, launches and the public catalog. See `service.js`.
 *
 * `createCatalogModule(options)` builds the definition with injected outbound I/O (development allowlist, DNS
 * resolver, HTTP client) for tests and local development; `catalogModule` is the production definition.
 * @module
 */
import { defineModule } from '../../infra/modules.js';
import { catalogRoutes } from './routes.js';
import { collections } from './schema.js';
import { createCatalogService } from './service.js';

/** @typedef {import('./service.js').CatalogOptions} CatalogOptions */
/** @typedef {import('./service.js').CatalogService} CatalogService */

export const REFRESH_JOB = 'catalog.refresh_manifests';
export const REFRESH_CRON = 'catalog_refresh';

/**
 * @param {CatalogOptions} [options]
 */
export const createCatalogModule = (options = {}) =>
	defineModule({
		name: 'catalog',
		collections,
		problems: {
			catalog_target_refused: { status: 422, title: 'Outbound target refused' },
			catalog_registration_failed: { status: 502, title: 'Registration handshake failed' },
			catalog_bundle_invalid: { status: 422, title: 'Invalid pack bundle' },
			catalog_launch_refused: { status: 422, title: 'Launch refused' },
		},
		service: (ctx) => createCatalogService(ctx, options),
		routes: (ctx) =>
			catalogRoutes(/** @type {CatalogService} */ (ctx.service('catalog')), {
				commerce: () => (ctx.moduleNames().includes('commerce') ? ctx.service('commerce') : null),
			}),
		jobs: (ctx) => ({
			[REFRESH_JOB]: async (_payload, { deadline, signal }) =>
				/** @type {CatalogService} */ (ctx.service('catalog')).refreshAll({ deadline, signal }),
		}),
		crons: (ctx) => ({
			// daily: enqueue the refresh job (deduplicated per UTC day); the drain cron runs it with retries
			[REFRESH_CRON]: async () => {
				const day = new Date(ctx.now()).toISOString().slice(0, 10);
				const { id, inserted } = await ctx.jobs.enqueue({ name: REFRESH_JOB, key: `${REFRESH_JOB}:${day}`, maxAttempts: 3 });
				return { jobId: id, enqueued: inserted };
			},
		}),
		ports: (ctx) => ({
			appKeys: (appId) => /** @type {CatalogService} */ (ctx.service('catalog')).appKeys(appId),
		}),
	});

export const catalogModule = createCatalogModule();
