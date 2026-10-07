/**
 * The `system` module: the platform mail settings (staff, RBAC + CSRF + audit) and the audit log search. It is
 * the reference for module structure.
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
