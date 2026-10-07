/**
 * The `integration` module: Event Hub (website and product events, dedupe, fan-out, signed deliveries with
 * retries) and Portal control events. See `service.js` for the flow.
 * @module
 */
import { defineModule } from '../../infra/modules.js';
import { collections } from './schema.js';
import { integrationRoutes } from './routes.js';
import { DELIVER_JOB, createIntegrationService } from './service.js';

/**
 * Build the module (options are for development allow-lists and tests).
 * @param {import('./service.js').IntegrationOptions} [options]
 */
export const createIntegrationModule = (options = {}) =>
	defineModule({
		name: 'integration',
		collections,
		service: (ctx) => createIntegrationService(ctx, options),
		routes: (ctx) => integrationRoutes(ctx.service('integration')),
		jobs: (ctx) => ({
			[DELIVER_JOB]: (payload, { job, signal }) => ctx.service('integration').runDelivery(payload, { job, signal }),
		}),
		ports: (ctx) => ({
			// a product calling the Portal (entitlements, usage, any product API) retries its due deliveries
			productCalled: (appId) => ctx.service('integration').deliverDueFor(appId),
		}),
	});

export const integrationModule = createIntegrationModule();
