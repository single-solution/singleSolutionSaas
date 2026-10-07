/**
 * The `delivery` module (PLAN §4 delivery plane): pack and widget asset storage, the per-website bundle compiler
 * (immutable versioned artefacts + atomically flipped alias), serving and snippets. See `service.js`.
 *
 * `createDeliveryModule(options)` builds the definition with injected I/O (asset storage, outbound fetch, DNS
 * resolver, runtime) for tests and local development; `deliveryModule` is the production definition.
 * @module
 */
import { defineModule } from '../../infra/modules.js';
import { deliveryRoutes } from './routes.js';
import { collections } from './schema.js';
import { COMPILE_JOB, createDeliveryService } from './service.js';

/** @typedef {import('./service.js').DeliveryOptions} DeliveryOptions */
/** @typedef {import('./service.js').DeliveryService} DeliveryService */

/**
 * @param {DeliveryOptions} [options]
 */
export const createDeliveryModule = (options = {}) =>
	defineModule({
		name: 'delivery',
		collections,
		problems: {
			delivery_asset_mismatch: { status: 422, title: 'Asset does not match the uploaded descriptor' },
		},
		service: (ctx) => createDeliveryService(ctx, options),
		routes: (ctx) => deliveryRoutes(/** @type {DeliveryService} */ (ctx.service('delivery'))),
		jobs: (ctx) => ({
			[COMPILE_JOB]: async (payload) => /** @type {DeliveryService} */ (ctx.service('delivery')).runCompileJob(payload),
		}),
	});

export const deliveryModule = createDeliveryModule();
