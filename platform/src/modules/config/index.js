/**
 * The `config` module: layered configuration overrides (platform policy, website overrides, admin overrides) with
 * immutable versions, rollback, staff locks and dry-run previews. Commerce resolves the layers with `@ss/entitlements`
 * (`layersFor`).
 * @module
 */
import { defineModule } from '../../infra/modules.js';
import { configRoutes } from './routes.js';
import { collections } from './schema.js';
import { createConfigService } from './service.js';

export const configModule = defineModule({
	name: 'config',
	collections,
	service: (ctx) => createConfigService(ctx),
	routes: (ctx) => configRoutes(ctx.service('config')),
});
