/**
 * The product's routes (the kit adds its own: connect, notices, tickets, data rights, `/sso` and the dashboard API).
 * Every browser-token, server-token and ticket route belongs to one feature; `openapi.json` is generated from these
 * definitions (`ss app assets`), so `method`, `path`, `auth`, `feature` and `permission` stay string literals.
 * Public entry `./routes` of this package: `product.handler(createRoutes(product))`.
 * @module
 */
import { created, defineRoute, paginate, problem } from '@ss/app-kit';
import { checkNote, noteView } from '../core/notes.js';
import { createNotesStore } from '../adapters/notes-store.js';
import { renderDocs } from './docs.js';
import { WIDGET_SCRIPT } from './widget-script.js';

/** @typedef {import('../adapters/product.js').Product} Product */

/** Problem detail per note error (the widget shows its own texts). */
const NOTE_ERRORS = Object.freeze({
	empty: 'Write a note.',
	too_long: 'The note is too long.',
	bad_email: 'The e-mail address is not valid.',
});

/**
 * Notes of the request's website, newest first, one page (`?cursor=&limit=`).
 * @param {any} ctx
 */
const listNotes = async (ctx) => {
	const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url }, { defaultLimit: 20 });
	const rows = await createNotesStore(await ctx.data()).list({ after: page.after, limit: page.fetchLimit });
	return page.respond(rows.map(noteView), (note) => [note.createdAt, note.id]);
};

/**
 * @param {Product} product
 */
export const createRoutes = (product) => [
	// the widgets' script: public and the same for every website (no token, no Origin needed). With data-token it
	// fetches the website's widget config from the kit (GET /v1/widget/config); admin pages call
	// window.SS<Product>.admin({ getTicket })
	defineRoute({
		method: 'GET',
		path: '/widget.js',
		auth: 'none',
		handler: () =>
			new Response(WIDGET_SCRIPT, {
				headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=300' },
			}),
	}),
	// a visitor leaves a note (browser token, from the website or a local page)
	defineRoute({
		method: 'POST',
		path: '/v1/notes',
		auth: 'browser',
		feature: 'notes',
		idempotent: true,
		rateLimit: [
			{ limit: 120, windowSeconds: 60, per: 'website' },
			{ limit: 5, windowSeconds: 60, per: 'visitor' },
		],
		handler: async (ctx) => {
			const { maxLength } = await product.settings.values(/** @type {string} */ (ctx.websiteId), 'notes');
			const checked = checkNote(ctx.body, { maxLength });
			if (!checked.ok)
				return problem('validation_failed', NOTE_ERRORS[checked.error], {
					errors: [{ path: `/${checked.field}`, message: NOTE_ERRORS[checked.error], code: checked.error }],
				});
			const note = await createNotesStore(await ctx.data()).add(checked.value);
			return created({ id: note.id, createdAt: noteView(note).createdAt });
		},
	}),
	// the merchant's server reads the notes (server token)
	defineRoute({ method: 'GET', path: '/v1/notes', auth: 'server', feature: 'notes', handler: listNotes }),
	// the admin widget reads the notes (ticket with notes.read, from the ticket's origin)
	defineRoute({ method: 'GET', path: '/v1/admin/notes', auth: 'ticket', permission: 'notes.read', handler: listNotes }),
	// public docs: no sign-in, no tokens
	defineRoute({
		method: 'GET',
		path: '/docs',
		auth: 'none',
		handler: (ctx) =>
			new Response(renderDocs({ base: new URL(ctx.request.url).origin }), {
				headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' },
			}),
	}),
];
