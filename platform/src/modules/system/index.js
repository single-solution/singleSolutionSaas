/**
 * The `system` module: Settings (e-mail sending, branding, support contact, security), the public branding and logo,
 * Activity and the admin Overview. It is the reference for module structure.
 * @module
 */
import { defineModule } from '../../infra/modules.js';
import { systemRoutes } from './routes.js';
import { createSystemService } from './service.js';

export const systemModule = defineModule({
	name: 'system',
	service: (ctx) => createSystemService(ctx),
	routes: (ctx) => systemRoutes(ctx.service('system')),
});
