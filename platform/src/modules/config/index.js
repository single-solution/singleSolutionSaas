/**
 * The `config` module: layered configuration overrides (platform policy, merchant defaults, website overrides, admin
 * overrides) with immutable versions, rollback, staff locks, templates, scheduled changes, experiments and dry-run
 * previews. Commerce resolves the layers with `@ss/entitlements` (`layersFor`). Scheduled changes are applied when the
 * merchant's configuration is read at or after their time (F.19: no job, no timer).
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
