/**
 * The `catalog` module: connected products (Add product, Reconnect, active/inactive), launches into product
 * dashboards, notices to products, the directory and the websites list of the Product ↔ Portal contract, and the
 * `productKeys` and `productCalled` ports. See `service.js`.
 *
 * `createCatalogModule(options)` builds the definition with injected outbound I/O (allowed hosts, DNS resolver, HTTP
 * client) for tests; `catalogModule` is the production definition.
 * @module
 */
import { defineModule } from '../../infra/modules.js';
import { catalogRoutes } from './routes.js';
import { collections } from './schema.js';
import { createCatalogService } from './service.js';

/** @typedef {import('./service.js').CatalogOptions} CatalogOptions */
/** @typedef {import('./service.js').CatalogService} CatalogService */

/**
 * @param {CatalogOptions} [options]
 */
export const createCatalogModule = (options = {}) =>
	defineModule({
		name: 'catalog',
		collections,
		problems: {
			catalog_target_refused: { status: 422, title: 'Outbound target refused' },
			catalog_launch_refused: { status: 422, title: 'Launch refused' },
		},
		service: (ctx) => createCatalogService(ctx, options),
		routes: (ctx) => catalogRoutes(/** @type {CatalogService} */ (ctx.service('catalog')), () => ctx.service('commerce')),
		ports: (ctx) => ({
			productKeys: (productId) => /** @type {CatalogService} */ (ctx.service('catalog')).productKeys(productId),
			productCalled: (productId) => /** @type {CatalogService} */ (ctx.service('catalog')).deliverNotices(productId),
		}),
	});

export const catalogModule = createCatalogModule();
