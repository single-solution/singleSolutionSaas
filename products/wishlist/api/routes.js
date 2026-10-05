/**
 * Route table: app-kit's standard resources (entitlement, config, events, strings, health, data export/anonymise,
 * the .well-known endpoints, /sso and — in development — the certification probes) plus the Wishlist Mode C API and
 * the dashboard API (SSO sessions). Every product route is gated by its element: a disabled element answers 403
 * element_disabled in every mode. POSTs that move state require an Idempotency-Key (app-kit stores and replays the
 * response); handlers are thin — validation and rules live in core/, operations in api/lists.js and friends.
 */
import { createHash } from 'node:crypto';
import { created, defineRoute, ok, paginate, problem, standardRoutes } from '@ss/app-kit';
import { notificationView } from '../core/views.js';
import { liveDashboard } from './dashboard.js';
import { resolveOwner } from './owner.js';
import { createWishlist } from './service.js';
import { createEventHandlers } from './signals.js';
import { sessionView } from './session.js';
import { settingsForDoc } from './settings.js';

/** @typedef {import('./service.js').Wishlist} Wishlist */
/** @typedef {import('./lists.js').Outcome} Outcome */

export { createWishlist };

/**
 * An outcome → app-kit result.
 * @param {Outcome} outcome
 * @param {(body: any) => string | null} [location] of a created resource
 */
export const respond = (outcome, location) => {
	if (outcome.ok) {
		if (outcome.status !== 201) return ok(outcome.body);
		const where = location?.(outcome.body);
		return created(outcome.body, where ? { location: where } : undefined);
	}
	return problem(outcome.code, outcome.detail ?? outcome.code.replace(/_/g, ' '), {
		...(outcome.errors
			? { errors: outcome.errors.map((e) => ({ path: e.path, code: e.code, message: e.code.replace(/_/g, ' ') })) }
			: {}),
	});
};

/**
 * The visitor's IP (first X-Forwarded-For hop, as set by the hosting edge).
 * @param {Headers} headers
 */
export const ipOf = (headers) => headers.get('x-forwarded-for')?.split(',')[0]?.trim() || headers.get('x-real-ip') || 'unknown';

/**
 * Rate-limit subject of a write: the customer, else the guest token, else the IP — hashed, never stored as given.
 * @param {any} ctx
 */
export const writerOf = (ctx) => {
	const subject = ctx.identity?.subject
		? `c:${ctx.identity.subject}`
		: typeof ctx.body?.guest === 'string'
			? `g:${ctx.body.guest}`
			: `ip:${ipOf(ctx.headers)}`;
	return `${ctx.websiteId}|${createHash('sha256').update(subject).digest('base64url').slice(0, 24)}`;
};

/**
 * @param {Wishlist} wishlist
 */
export const buildRoutes = (wishlist) => {
	const { product, lists, shares, siteOf, state, guestToken, app } = wishlist;
	/** @param {any} ctx */
	const site = (ctx) => siteOf(ctx.websiteId, ctx.entitlement.doc);
	/** @param {any} ctx */
	const settingsOf = (ctx) => settingsForDoc(product, ctx.entitlement.doc);
	/**
	 * Website-key route options of an element (customer identity optional for browser keys).
	 * @param {string} element
	 * @param {{ sk?: boolean }} [options] `sk`: server keys only
	 */
	const website = (element, { sk = false } = {}) => ({
		auth: /** @type {const} */ ('website'),
		element,
		...(sk ? { keyKind: /** @type {const} */ ('sk') } : { identity: /** @type {const} */ ('optional') }),
	});
	/** Writes per customer / guest per minute (`lists.max_writes_per_minute`); server keys are not limited. */
	const writes = {
		limit: (/** @type {any} */ ctx) => (ctx.website?.kind === 'sk' ? Infinity : settingsOf(ctx).lists.writesPerMinute),
		windowMs: 60_000,
		key: writerOf,
		bucket: 'writes',
	};
	/**
	 * Run an operation for the request's owner.
	 * @param {any} ctx
	 * @param {(site: import('./lists.js').Site, owner: import('../adapters/db.js').Owner | null, resolved: any) => Promise<Outcome>} run
	 * @param {{ guest?: 'allow' | 'deny', requireOwner?: boolean }} [options] `requireOwner`: a server key must name the customer
	 */
	const asOwner = async (ctx, run, { guest = 'allow', requireOwner = false } = {}) => {
		const s = await site(ctx);
		const resolved = resolveOwner({ ctx, site: s, tokens: app.tokens, guest });
		if (!resolved.ok) return respond(resolved);
		if (requireOwner && !resolved.owner)
			return respond({
				ok: false,
				code: 'validation_failed',
				detail: 'Name the customer (customerId) when using a server key.',
				errors: [{ path: '/customerId', code: 'required' }],
			});
		return run(s, resolved.owner, resolved).then((outcome) => respond(outcome));
	};
	/** @param {any} body */
	const listLocation = (body) => (typeof body?.id === 'string' ? `/v1/lists/${body.id}` : null);

	return [
		...standardRoutes(product),
		defineRoute({ method: 'GET', path: '/v1/session', auth: 'launch', handler: (ctx) => ok(sessionView(ctx.session)) }),

		// ── lists ───────────────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/lists',
			...website('lists'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const resolved = resolveOwner({ ctx, site: s, tokens: app.tokens, guest: 'deny' });
				if (!resolved.ok) return respond(resolved);
				const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url });
				const items = await lists.page(s, resolved.owner, { after: page.after, fetchLimit: page.fetchLimit });
				return page.respond(items, (/** @type {any} */ list) => [list.createdAt, list.id]);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/lists',
			...website('lists'),
			rateLimit: writes,
			handler: async (ctx) => {
				const s = await site(ctx);
				const resolved = resolveOwner({ ctx, site: s, tokens: app.tokens });
				if (!resolved.ok) return respond(resolved);
				if (!resolved.owner)
					return respond({
						ok: false,
						code: 'validation_failed',
						detail: 'Name the customer (customerId) when using a server key.',
						errors: [{ path: '/customerId', code: 'required' }],
					});
				return respond(await lists.create(s, resolved.owner, ctx.body ?? {}), listLocation);
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/lists/:id',
			...website('lists'),
			handler: (ctx) => asOwner(ctx, (s, owner) => lists.get(s, owner, ctx.params.id), { guest: 'deny' }),
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/lists/:id',
			...website('lists'),
			rateLimit: writes,
			handler: (ctx) =>
				asOwner(ctx, (s, owner, resolved) =>
					lists.update(s, owner, ctx.params.id, ctx.body ?? {}, { email: resolved.email }),
				),
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/lists/:id',
			...website('lists'),
			rateLimit: writes,
			handler: (ctx) => asOwner(ctx, (s, owner) => lists.remove(s, owner, ctx.params.id)),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/lists/:id/items',
			...website('lists'),
			rateLimit: writes,
			handler: async (ctx) => {
				const s = await site(ctx);
				const resolved = resolveOwner({ ctx, site: s, tokens: app.tokens });
				if (!resolved.ok) return respond(resolved);
				const outcome = await lists.addItem(s, resolved.owner, ctx.params.id, ctx.body ?? {});
				return respond(outcome, (body) => `/v1/lists/${body.list.id}/items/${body.entryId}`);
			},
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/lists/:id/items/:entryId',
			...website('lists'),
			rateLimit: writes,
			handler: (ctx) => asOwner(ctx, (s, owner) => lists.removeItem(s, owner, ctx.params.id, ctx.params.entryId)),
		}),

		// ── guests ──────────────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'POST',
			path: '/v1/guests',
			...website('guest_merge'),
			rateLimit: {
				limit: (/** @type {any} */ ctx) => (ctx.website?.kind === 'sk' ? Infinity : settingsOf(ctx).guests.perIpPerHour),
				windowMs: 3_600_000,
				key: (/** @type {any} */ ctx) => `${ctx.websiteId}|${ipOf(ctx.headers)}`,
			},
			handler: async (ctx) => {
				const token = guestToken(await site(ctx));
				return created(token);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/guests:merge',
			...website('guest_merge'),
			rateLimit: writes,
			handler: (ctx) =>
				asOwner(
					ctx,
					async (s, owner) => {
						const from = app.tokens.verifyGuest(ctx.body?.guest, s.websiteId);
						if (!from) return { ok: false, code: 'guest_invalid', detail: 'The guest token is invalid or has expired.' };
						return lists.merge(s, /** @type {import('../adapters/db.js').Owner} */ (owner), {
							kind: 'guest',
							id: from.guestId,
						});
					},
					{ guest: 'deny', requireOwner: true },
				),
		}),

		// ── share links ─────────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'POST',
			path: '/v1/shares',
			...website('share'),
			rateLimit: writes,
			handler: (ctx) => asOwner(ctx, (s, owner) => shares.create(s, owner, ctx.body?.listId)),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/shares:revoke',
			...website('share'),
			rateLimit: writes,
			handler: (ctx) => asOwner(ctx, (s, owner) => shares.revoke(s, owner, ctx.body?.listId)),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/shares/:token',
			auth: 'website',
			element: 'share',
			handler: async (ctx) => respond(await shares.view(await site(ctx), ctx.params.token)),
		}),

		// ── price-drop hook ─────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/notifications',
			...website('price_drop_hook', { sk: true }),
			handler: async (ctx) => {
				const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url });
				const records = await (await site(ctx)).repos.notifications.page({ after: page.after, fetchLimit: page.fetchLimit });
				return page.respond(records.map(notificationView), (/** @type {any} */ record) => [record.at, record.id]);
			},
		}),

		// ── widgets ─────────────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'POST',
			path: '/v1/wishlist',
			...website('widgets'),
			idempotent: false,
			rateLimit: {
				limit: (/** @type {any} */ ctx) => (ctx.website?.kind === 'sk' ? Infinity : settingsOf(ctx).widgets.loadsPerMinute),
				windowMs: 60_000,
				key: (/** @type {any} */ ctx) => `${ctx.websiteId}|${ipOf(ctx.headers)}`,
			},
			handler: async (ctx) => respond(await state(await site(ctx), ctx)),
		}),

		// ── dashboard (SSO session) ─────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/dashboard/overview',
			auth: 'launch',
			element: 'lists',
			handler: async (ctx) => {
				if (!ctx.websiteId || !ctx.entitlement) return problem('bad_request', 'Open the dashboard for a website.');
				return ok(await liveDashboard({ site: await site(ctx) }).overview());
			},
		}),
	];
};

/**
 * Register the event consumers (app-kit dedupes deliveries on the event id).
 * @param {Wishlist} wishlist
 */
export const wireEvents = (wishlist) => {
	for (const [type, handler] of Object.entries(createEventHandlers({ signals: wishlist.signals, siteFor: wishlist.siteFor })))
		wishlist.product.events.on(type, handler);
	return wishlist;
};
