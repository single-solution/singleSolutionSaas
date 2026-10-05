/**
 * The `system` module: public service information, an authenticated "who am I" probe that exercises every auth
 * mode, the staff-managed console notice (RBAC + CSRF + audit), and the staff operations reads (platform health,
 * audit log search and chain verification). It is the reference for module structure.
 * @module
 */
import { defineModule } from '../../infra/modules.js';
import { collections, SETTINGS } from './schema.js';
import { systemRoutes } from './routes.js';
import { createSystemService } from './service.js';

export const systemModule = defineModule({
	name: 'system',
	collections,
	migrations: [
		{
			id: '202610010000-system-notice-default',
			description: 'Create the empty console notice setting.',
			plan: async () => [`upsert ${SETTINGS} { _id: 'notice', value: null } if absent`],
			up: async ({ db }) => {
				await db
					.collection(SETTINGS)
					.updateOne(
						{ _id: /** @type {any} */ ('notice') },
						{ $setOnInsert: { value: null, updatedBy: 'migration', createdAt: new Date(), updatedAt: new Date() } },
						{ upsert: true },
					);
			},
		},
	],
	service: (ctx) => createSystemService(ctx),
	routes: (ctx) => systemRoutes(ctx.service('system')),
});
