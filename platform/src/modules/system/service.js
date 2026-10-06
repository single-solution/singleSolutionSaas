/**
 * Public service of the `system` module (other modules reach it with `ctx.service('system')`).
 * @module
 */
import { MAIL_FROM, checkPortalUrl, checkPreviewUrl } from '../../infra/config.js';
import { problem } from '../../infra/http.js';
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
	/** @returns {import('../../infra/system.js').SystemStore} */
	const system = () => {
		if (!ctx.system) throw problem('unavailable', 'The Portal settings store is not available.');
		return ctx.system;
	};
	/**
	 * @param {Actor} actor
	 * @param {string} action
	 * @param {{ before?: unknown, after?: unknown, requestId: string, ip: string | null }} input
	 */
	const record = (actor, action, { before, after, requestId, ip }) =>
		ctx.audit.record({
			actor: { type: /** @type {'staff'} */ ('staff'), id: actor.id },
			action,
			target: { type: 'setting', id: action.split('.')[1] ?? 'settings' },
			before,
			after,
			requestId,
			ip,
		});

	/** The settings as the admin console shows them (never the mail password or key material). */
	const settings = async () => {
		const doc = await system().settings();
		return {
			portalUrl: doc?.portalUrl ?? null,
			previewUrl: doc?.previewUrl ?? null,
			mail: doc?.mail
				? {
						host: doc.mail.host,
						port: doc.mail.port,
						secure: doc.mail.secure,
						user: doc.mail.user,
						from: doc.mail.from,
						hasPassword: Boolean(doc.mail.passSealed),
					}
				: null,
			keys: await system().keyInfo(),
			version: doc?.version ?? 0,
			appliesWithinSeconds: 5,
		};
	};

	return {
		settings,
		/**
		 * Change the Portal URL (superadmin; re-confirmed and audited). It is the issuer/audience of every token and the
		 * consoles' CSRF origin: products keep working because they verify keys, not the URL — but launches and e-mail
		 * links use the new address from now on.
		 * @param {{ portalUrl: unknown, confirmation: unknown, actor: Actor, requestId: string, ip: string | null }} input
		 */
		setPortalUrl: async ({ portalUrl, confirmation, actor, requestId, ip }) => {
			const checked = checkPortalUrl(portalUrl, { production: ctx.config.isProduction });
			if (!checked.ok)
				throw problem('validation_failed', checked.message, { errors: [{ path: '/portalUrl', message: checked.message }] });
			if (confirmation !== portalUrl)
				throw problem('validation_failed', 'Type the new Portal URL again to confirm it.', {
					errors: [{ path: '/confirmation', message: 'must repeat portalUrl' }],
				});
			const before = (await system().settings())?.portalUrl ?? null;
			await system().update({ portalUrl: checked.url });
			await record(actor, 'system.portal_url_changed', { before, after: checked.url, requestId, ip });
			return settings();
		},
		/**
		 * Set or clear the dedicated preview origin (F.16).
		 * @param {{ previewUrl: unknown, actor: Actor, requestId: string, ip: string | null }} input
		 */
		setPreviewUrl: async ({ previewUrl, actor, requestId, ip }) => {
			/** @type {string | null} */
			let value = null;
			if (previewUrl !== null && previewUrl !== '') {
				const checked = checkPreviewUrl(previewUrl, { production: ctx.config.isProduction, portalUrl: ctx.config.portalUrl });
				if (!checked.ok)
					throw problem('validation_failed', checked.message, {
						errors: [{ path: '/previewUrl', message: checked.message }],
					});
				value = checked.url;
			}
			const before = (await system().settings())?.previewUrl ?? null;
			await system().update({ previewUrl: value });
			await record(actor, 'system.preview_url_set', { before, after: value, requestId, ip });
			return settings();
		},
		/**
		 * Set or clear the mailer. The password is sealed with the Portal's encryption key; omit it to keep the stored one.
		 * @param {{ mail: unknown, actor: Actor, requestId: string, ip: string | null }} input
		 */
		setMail: async ({ mail, actor, requestId, ip }) => {
			if (mail === null) {
				await system().update({ mail: null });
				await record(actor, 'system.mail_set', { after: null, requestId, ip });
				return settings();
			}
			const input = /** @type {Record<string, unknown>} */ (typeof mail === 'object' && mail !== null ? mail : {});
			/** @type {Array<{ path: string, message: string }>} */
			const errors = [];
			const host = typeof input.host === 'string' ? input.host.trim() : '';
			if (!/^[A-Za-z0-9.-]{1,253}$/.test(host)) errors.push({ path: '/host', message: 'must be a host name' });
			const port = Number(input.port ?? 587);
			if (!Number.isInteger(port) || port < 1 || port > 65_535) errors.push({ path: '/port', message: 'must be a port' });
			const secure = input.secure === true;
			const user = typeof input.user === 'string' && input.user.trim() !== '' ? input.user.trim().slice(0, 320) : null;
			const pass =
				input.password === undefined
					? undefined
					: typeof input.password === 'string' && input.password !== ''
						? input.password
						: null;
			if (typeof pass === 'string' && pass.length > 1024) errors.push({ path: '/password', message: 'is too long' });
			const from = typeof input.from === 'string' ? input.from.trim() : '';
			if (!MAIL_FROM.test(from)) errors.push({ path: '/from', message: 'must be `Name <address>` or an address' });
			if (errors.length > 0) throw problem('validation_failed', 'The mail settings are invalid.', { errors });
			await system().update({ mail: { host, port, secure, user, ...(pass === undefined ? {} : { pass }), from } });
			await record(actor, 'system.mail_set', {
				after: { host, port, secure, user, from, password: pass === undefined ? 'kept' : pass ? 'set' : 'removed' },
				requestId,
				ip,
			});
			return settings();
		},
		/**
		 * Rotate a generated key: a new one signs or seals from now on; the old ones stay published / able to open.
		 * @param {{ kind: string, actor: Actor, requestId: string, ip: string | null }} input
		 */
		rotateKey: async ({ kind, actor, requestId, ip }) => {
			if (kind !== 'signing' && kind !== 'website' && kind !== 'encryption')
				throw problem('not_found', 'Key kinds are signing, website and encryption.');
			const result = await system().rotate(kind);
			await record(actor, 'system.key_rotated', { after: result, requestId, ip });
			return result;
		},
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
