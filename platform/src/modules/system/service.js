/**
 * Public service of the `system` module (other modules reach it with `ctx.service('system')`).
 * @module
 */
import { buildInfo } from './core/info.js';
import { createOps } from './ops.js';
import { createSystemRepo } from './repo.js';
import { SETTINGS } from './schema.js';

/** @typedef {import('../../infra/modules.js').ModuleContext} ModuleContext */
/** @typedef {import('./core/info.js').Notice} Notice */
/** @typedef {import('../../infra/rbac.js').Actor} Actor */

/**
 * @param {ModuleContext} ctx
 */
export const createSystemService = (ctx) => {
	const repo = createSystemRepo(ctx.collection(SETTINGS));
	return {
		...createOps(ctx),
		info: async () =>
			buildInfo({
				portalUrl: ctx.config.portalUrl,
				version: ctx.config.version,
				env: ctx.config.env,
				modules: ctx.moduleNames(),
				notice: await repo.getNotice(),
				now: ctx.now(),
			}),
		notice: () => repo.getNotice(),
		/**
		 * Set or clear the console notice (audited).
		 * @param {{ notice: Notice | null, actor: Actor, requestId: string, ip: string | null }} input
		 */
		setNotice: async ({ notice, actor, requestId, ip }) => {
			const before = await repo.setNotice(notice, actor.id);
			await ctx.audit.record({
				actor: { type: /** @type {'staff'} */ ('staff'), id: actor.id },
				action: 'system.notice_set',
				target: { type: 'setting', id: 'notice' },
				before,
				after: notice,
				requestId,
				ip,
			});
			return notice;
		},
	};
};
/** @typedef {ReturnType<typeof createSystemService>} SystemService */
