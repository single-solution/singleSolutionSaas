/**
 * The `website` module: the website settings (the facts every product of a website shares, kept once in the Portal and
 * delivered to every product on the website), their console routes, the product pull and the notice that a change
 * causes. See `service.js`.
 * @module
 */
import { defineModule } from '../../infra/modules.js';
import { websiteRoutes } from './routes.js';
import { collections } from './schema.js';
import { createWebsiteService } from './service.js';

/** @typedef {import('./service.js').WebsiteService} WebsiteService */

export const websiteModule = defineModule({
	name: 'website',
	collections,
	service: (ctx) => createWebsiteService(ctx),
	routes: (ctx) => websiteRoutes(/** @type {WebsiteService} */ (ctx.service('website'))),
});
