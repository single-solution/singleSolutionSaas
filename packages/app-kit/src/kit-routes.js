/**
 * The routes the kit serves for every product (besides the dashboard API in `dashboard.js`):
 *
 * - `POST /.well-known/ss-connect` (none): the connect handshake (PLAN 0.4.12 row 1);
 * - `POST /.well-known/ss-events` (none, signed by the Portal): notices (0.4.12); `status.changed` drops the cached
 *   status and fetches it again right after the answer;
 * - `POST /v1/tickets` (server token): tickets for admin widgets (0.4.5);
 * - `POST /v1/data-rights/export` and `POST /v1/data-rights/delete` (server token, merchant database required, no
 *   feature): data rights for one end user (0.4.11);
 * - `GET /v1/widget/config` (browser token, Origin required) and `GET /v1/widget/admin/config` (ticket): what the
 *   product's `widget.js` needs for a website (0.4.10): widget texts, theme, custom CSS, the switched-on features and
 *   the product's own widget settings (`hooks.widgetConfig`). No feature gate; the status and the merchant database
 *   are checked as on every website route, so a stopped product or a missing database renders nothing.
 * @module
 */
import { validateDataRightsRequest } from '@ss/contracts';
import { NOTICE_PATH, isProtocolError, ticketOriginAllowed, verifyNotice } from '@ss/protocol';
import { defineRoute } from './http/routes.js';
import { noContent, problem } from './http/results.js';
import { isObject } from './util.js';

/** @typedef {import('./http/handler.js').RequestContext} RequestContext */
/** @typedef {{ id?: string, email?: string, phone?: string }} DataRightsUser */
/**
 * @typedef {object} ProductHooks
 * @property {(ctx: RequestContext, user: DataRightsUser) => Promise<Record<string, unknown>>} [exportUser] the user's
 *   records, by collection or kind
 * @property {(ctx: RequestContext, user: DataRightsUser) => Promise<{ deleted: number, anonymised: number }>} [deleteUser]
 * @property {(ctx: RequestContext) => Promise<Record<string, unknown>>} [widgetConfig] the settings the widgets need
 *   (for example limits), answered as `settings` by the widget config routes; never secrets
 */

/** Product database collections that hold per-website data (`website.deleted` removes them). */
const WEBSITE_COLLECTIONS = /** @type {const} */ ([
	'switches',
	'settings',
	'connections',
	'changes',
	'status',
	'business',
	'widget',
]);

/**
 * @param {import('./product.js').Kit} kit
 * @param {ProductHooks} hooks
 */
export const createKitRoutes = (kit, hooks) => {
	const { store, manifest, now } = kit;
	/** @type {Map<string, string>} */
	const featureOfPermission = new Map(
		manifest.permissions.map((/** @type {{ key: string, feature: string }} */ p) => [p.key, p.feature]),
	);

	/** @param {RequestContext} ctx */
	const notice = async (ctx) => {
		if (!kit.connection.connected()) return problem('unavailable', 'This product is not connected to a Portal yet.');
		/** @type {import('@ss/protocol').Notice} */
		let body;
		try {
			body = await verifyNotice({
				headers: ctx.headers,
				rawBody: ctx.rawBody,
				keyResolver: kit.connection.active().portalKeys,
				replayStore: { seen: store.seen },
				now,
			});
		} catch (error) {
			if (!isProtocolError(error)) throw error;
			return problem('unauthorized', 'The notice does not verify.');
		}
		if (body.type === 'status.changed') {
			const websiteId = body.websiteId;
			await kit.status.drop(websiteId);
			// and fetched again right after answering (a removed product turns its switches off then)
			ctx.after(async () => {
				await kit.status.lookup(websiteId, { fresh: true });
			});
		}
		if (body.type === 'token.revoked') {
			try {
				await kit.status.syncRevocations();
			} catch {
				return problem('portal_unreachable', 'The revocation list cannot be fetched right now.');
			}
		}
		if (body.type === 'sessions.revoked') await kit.dashboard.endSessions(body.subject);
		if (body.type === 'website.deleted') {
			const websiteId = body.websiteId;
			await Promise.all(WEBSITE_COLLECTIONS.map((collection) => store.deleteWhere(collection, { websiteId })));
			await kit.dashboard.endWebsiteSessions(websiteId);
		}
		return noContent();
	};

	/** @param {RequestContext} ctx */
	const tickets = async (ctx) => {
		const body = isObject(ctx.body) ? ctx.body : {};
		const { user, permissions, origin } = body;
		if (!ticketOriginAllowed(origin))
			return problem('validation_failed', '`origin` must be an https origin, or a local one for testing.');
		if (!Array.isArray(permissions) || permissions.some((key) => typeof key !== 'string' || !featureOfPermission.has(key)))
			return problem('validation_failed', '`permissions` must list permissions of this product.');
		const { on } = await kit.reports.switches(/** @type {string} */ (ctx.websiteId));
		const kept = [...new Set(permissions)].filter((key) => on.includes(/** @type {string} */ (featureOfPermission.get(key))));
		try {
			return await kit.tickets.issue({
				websiteId: /** @type {string} */ (ctx.websiteId),
				user: /** @type {{ id: string, name: string, email: string }} */ (user),
				origin: /** @type {string} */ (origin),
				permissions: kept,
				tokenId: /** @type {import('@ss/protocol').TokenClaims} */ (ctx.token).jti,
			});
		} catch (error) {
			if (!isProtocolError(error)) throw error;
			return problem('validation_failed', '`user` needs id, name and email.');
		}
	};

	/**
	 * Staff records the kit keeps for a user (merchant database).
	 * @param {RequestContext} ctx
	 * @param {DataRightsUser} user
	 */
	const staffFilter = (ctx, user) => {
		const or = [...(user.id ? [{ id: user.id }] : []), ...(user.email ? [{ email: user.email }] : [])];
		return or.length > 0 ? { websiteId: ctx.websiteId, $or: or } : null;
	};

	/**
	 * @param {'export' | 'delete'} kind
	 * @returns {(ctx: RequestContext) => Promise<unknown>}
	 */
	const dataRights = (kind) => async (ctx) => {
		const checked = validateDataRightsRequest(ctx.body);
		if (!checked.ok)
			return problem('validation_failed', 'Send { user: { id?, email?, phone? } } with at least one.', {
				errors: [...checked.problems],
			});
		const { user } = checked.value;
		const staff = (await ctx.data()).collection('staff');
		const filter = staffFilter(ctx, user);
		if (kind === 'export') {
			const records = hooks.exportUser ? await hooks.exportUser(ctx, user) : {};
			const rows = filter
				? await staff.find(filter, { projection: { _id: 0, id: 1, name: 1, email: 1, lastSeenAt: 1 } }).toArray()
				: [];
			return { records: rows.length > 0 && !Object.hasOwn(records, 'staff') ? { ...records, staff: rows } : records };
		}
		const result = hooks.deleteUser ? await hooks.deleteUser(ctx, user) : { deleted: 0, anonymised: 0 };
		const removed = filter ? (await staff.deleteMany(filter)).deletedCount : 0;
		return { deleted: result.deleted + removed, anonymised: result.anonymised };
	};

	/**
	 * Widget config of the request's website.
	 * @param {RequestContext} ctx
	 */
	const widgetConfig = async (ctx) => {
		const websiteId = /** @type {string} */ (ctx.websiteId);
		const [texts, { theme }, { on }, settings] = await Promise.all([
			kit.settings.texts(websiteId),
			kit.settings.themeOf(websiteId),
			kit.reports.switches(websiteId),
			hooks.widgetConfig ? hooks.widgetConfig(ctx) : {},
		]);
		const { customCss, ...look } = theme;
		return { texts, theme: look, customCss, features: on, settings };
	};

	return [
		defineRoute({ method: 'GET', path: '/v1/widget/config', auth: 'browser', handler: widgetConfig }),
		defineRoute({ method: 'GET', path: '/v1/widget/admin/config', auth: 'ticket', handler: widgetConfig }),
		defineRoute({
			method: 'POST',
			path: '/.well-known/ss-connect',
			auth: 'none',
			rawBody: true,
			maxBodyBytes: 64 * 1024,
			rateLimit: { limit: 30, windowSeconds: 60, per: 'visitor' },
			handler: (ctx) => kit.connection.handleConnect({ headers: ctx.headers, rawBody: ctx.rawBody }),
		}),
		defineRoute({ method: 'POST', path: NOTICE_PATH, auth: 'none', rawBody: true, maxBodyBytes: 16 * 1024, handler: notice }),
		defineRoute({ method: 'POST', path: '/v1/tickets', auth: 'server', database: false, handler: tickets }),
		defineRoute({ method: 'POST', path: '/v1/data-rights/export', auth: 'server', handler: dataRights('export') }),
		defineRoute({ method: 'POST', path: '/v1/data-rights/delete', auth: 'server', handler: dataRights('delete') }),
	];
};
