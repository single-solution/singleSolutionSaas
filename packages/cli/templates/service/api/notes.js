/**
 * Mode C handlers of the `notes` resource (thin: validation and rules live in core/). `websiteId` always comes from the
 * verified website key and `config` from the signed entitlement document — never from the path or body. Listing is
 * paginated by app-kit in `api/routes.js` (`paginate(...).respond`).
 */
import { applyPatch, canAddNote, createNote, newNoteId, resolveConfig, toPublic, validateNoteInput } from '../core/notes.js';
import { fail, reply } from './reply.js';

/** @typedef {import('./reply.js').Reply} Reply */
/** @typedef {import('../adapters/db.js').NotesRepository} NotesRepository */
/**
 * @typedef {object} NotesDeps
 * @property {(websiteId: string) => Promise<NotesRepository>} repoFor
 * @property {(event: { websiteId: string, type: string, data: Record<string, unknown>, idempotencyKey: string }) => Promise<unknown>} [publish]
 * @property {(usage: { websiteId: string, unit: string, quantity: number, idempotencyKey: string }) => unknown} [recordUsage]
 * @property {() => number} [now]
 * @property {() => string} [random]
 * @property {string} [eventType] product event published on create
 */
/**
 * @typedef {{ websiteId: string, config?: Record<string, unknown>, body?: unknown, params?: Record<string, string>, idempotencyKey?: string }} NotesContext
 */

/**
 * @param {ReturnType<typeof validateNoteInput>} problems
 * @returns {Reply}
 */
const invalid = (problems) =>
	fail(
		'validation_failed',
		'The note is not valid.',
		problems.map((problem) => ({ path: problem.path, code: problem.code, message: problem.code.replace(/_/g, ' ') })),
	);

/**
 * @param {NotesDeps} deps
 */
export const createNotesHandlers = ({
	repoFor,
	publish,
	recordUsage,
	now = Date.now,
	random = () => Math.random().toString(36).slice(2, 10),
	eventType = '{{namespace}}.note_created@1',
}) =>
	Object.freeze({
		/** @param {NotesContext} ctx @returns {Promise<Reply>} */
		create: async ({ websiteId, config, body, idempotencyKey }) => {
			const settings = resolveConfig(config);
			const problems = validateNoteInput(body, settings);
			if (problems.length > 0) return invalid(problems);
			const repo = await repoFor(websiteId);
			if (!canAddNote(await repo.count(), settings))
				return fail('conflict', `A website can keep at most ${settings.max_notes} notes.`);
			const nowMs = now();
			const note = createNote({
				input: /** @type {{ text: string, pinned?: boolean }} */ (body),
				websiteId,
				id: newNoteId(nowMs, random()),
				nowMs,
			});
			await repo.insert(note);
			const key = `note_created:${idempotencyKey ?? note.id}`;
			await recordUsage?.({ websiteId, unit: 'note_created', quantity: 1, idempotencyKey: key });
			await publish?.({ websiteId, type: eventType, data: { noteId: note.id }, idempotencyKey: key });
			return reply(toPublic(note), { status: 201 });
		},

		/** @param {NotesContext} ctx @returns {Promise<Reply>} */
		get: async ({ websiteId, params = {} }) => {
			const note = await (await repoFor(websiteId)).get(params.id ?? '');
			return note ? reply(toPublic(note)) : fail('not_found', 'No such note.');
		},

		/** @param {NotesContext} ctx @returns {Promise<Reply>} */
		update: async ({ websiteId, config, params = {}, body }) => {
			const problems = validateNoteInput(body, resolveConfig(config), { partial: true });
			if (problems.length > 0) return invalid(problems);
			const repo = await repoFor(websiteId);
			const note = await repo.get(params.id ?? '');
			if (!note) return fail('not_found', 'No such note.');
			const updated = applyPatch(note, /** @type {{ text?: string, pinned?: boolean }} */ (body), now());
			await repo.save(updated);
			return reply(toPublic(updated));
		},

		/** @param {NotesContext} ctx @returns {Promise<Reply>} */
		remove: async ({ websiteId, params = {} }) => {
			const removed = await (await repoFor(websiteId)).remove(params.id ?? '', new Date(now()).toISOString());
			return removed ? reply({ id: params.id, deleted: true }) : fail('not_found', 'No such note.');
		},
	});
