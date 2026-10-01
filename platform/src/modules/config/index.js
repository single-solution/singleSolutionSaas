/**
 * The `config` module: layered configuration overrides (platform policy, merchant defaults, website overrides, admin
 * overrides) with immutable versions, rollback, staff locks, templates, scheduled changes, experiments and dry-run
 * previews. Commerce resolves the layers with `@ss/entitlements` (`layersFor`).
 * @module
 */
import { defineModule } from '../../infra/modules.js';
import { permanentFailure } from '../../infra/jobs.js';
import { configRoutes } from './routes.js';
import { collections } from './schema.js';
import { APPLY_SCHEDULED_JOB, createConfigService } from './service.js';

export const configModule = defineModule({
	name: 'config',
	collections,
	service: (ctx) => createConfigService(ctx),
	routes: (ctx) => configRoutes(ctx.service('config')),
	jobs: (ctx) => ({
		[APPLY_SCHEDULED_JOB]: async (payload) => {
			if (typeof payload?.scheduleId !== 'string' || typeof payload?.merchantId !== 'string')
				throw permanentFailure('config.apply_scheduled needs { scheduleId, merchantId }');
			return ctx.service('config').applyScheduled(payload);
		},
	}),
});
