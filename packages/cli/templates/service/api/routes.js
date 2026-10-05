/**
 * Route table: app-kit's standard resources (entitlement, config, events, strings, health, data export/anonymise,
 * the .well-known endpoints, /sso and — in development — the certification probes) plus the product's own routes.
 * Every product route is website-key authenticated and gated by its element: a disabled element answers
 * 403 element_disabled in all modes. POSTs require an Idempotency-Key (app-kit stores and replays the response).
 */
import { created, defineRoute, ok, paginate, problem, standardRoutes } from '@ss/app-kit';
import { toPublic } from '../core/notes.js';
import { notesRepositories } from '../adapters/db.js';
import { createEventHandlers } from './events.js';
import { createNotesHandlers } from './notes.js';
import { sessionView } from './session.js';

/** @typedef {import('./reply.js').Reply} Reply */

/**
 * @param {Reply} result
 */
export const toResponse = (result) => {
	if (result.kind === 'problem')
		return problem(result.code, result.detail, result.errors ? { errors: result.errors } : undefined);
	if (result.status === 201) return created(result.body);
	return ok(result.body, { status: result.status, ...(result.headers ? { headers: result.headers } : {}) });
};

/**
 * @param {any} product the app-kit product
 */
export const buildRoutes = (product) => {
	const repoFor = notesRepositories(product);
	const notes = createNotesHandlers({
		repoFor,
		publish: async (event) => {
			try {
				await product.portal.publishEvent(event);
			} catch {
				// publishing is best effort here; the note is stored either way
			}
		},
		recordUsage: (usage) => product.usage.record(usage),
	});
	/**
	 * @param {(ctx: import('./notes.js').NotesContext) => Promise<Reply>} handler
	 * @returns {(ctx: any) => Promise<unknown>}
	 */
	const adapt = (handler) => async (ctx) =>
		toResponse(
			await handler({
				websiteId: ctx.websiteId,
				config: product.entitlements.config(ctx.entitlement.doc, 'notes') ?? {},
				body: ctx.body,
				params: ctx.params,
				idempotencyKey: ctx.idempotencyKey,
			}),
		);
	const website = { auth: /** @type {const} */ ('website'), element: 'notes' };
	return [
		...standardRoutes(product),
		defineRoute({ method: 'GET', path: '/v1/session', auth: 'launch', handler: (ctx) => ok(sessionView(ctx.session)) }),
		defineRoute({
			method: 'GET',
			path: '/v1/notes',
			...website,
			handler: async (ctx) => {
				const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url });
				const items = await (await repoFor(ctx.websiteId)).list({ after: page.after, fetchLimit: page.fetchLimit });
				return page.respond(items.map(toPublic));
			},
		}),
		defineRoute({ method: 'POST', path: '/v1/notes', ...website, handler: adapt(notes.create) }),
		defineRoute({ method: 'GET', path: '/v1/notes/:id', ...website, handler: adapt(notes.get) }),
		defineRoute({ method: 'PATCH', path: '/v1/notes/:id', ...website, handler: adapt(notes.update) }),
		defineRoute({ method: 'DELETE', path: '/v1/notes/:id', ...website, handler: adapt(notes.remove) }),
	];
};

/**
 * Register event consumers (app-kit dedupes deliveries on the event id).
 * @param {any} product
 */
export const wireEvents = (product) => {
	for (const [type, handler] of Object.entries(createEventHandlers({ repoFor: notesRepositories(product) })))
		product.events.on(type, handler);
	return product;
};
