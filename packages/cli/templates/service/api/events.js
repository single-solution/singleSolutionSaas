/**
 * Event consumers (Part E §9). Consumption is idempotent twice over: app-kit dedupes deliveries on the event `id`,
 * and the note created for an order carries `sourceEventId`, so even a re-processed event never creates a second note.
 */
import { createNote, newNoteId, noteFromOrder } from '../core/notes.js';

/**
 * @param {{ repoFor: (websiteId: string) => Promise<import('../adapters/db.js').NotesRepository>, now?: () => number, random?: () => string }} deps
 * @returns {Record<string, (event: { id: string, websiteId: string, data: any }) => Promise<void>>}
 */
export const createEventHandlers = ({ repoFor, now = Date.now, random = () => Math.random().toString(36).slice(2, 10) }) => ({
	'order.placed@1': async (event) => {
		const nowMs = now();
		const note = createNote({
			input: { text: noteFromOrder(event.data) },
			websiteId: event.websiteId,
			id: newNoteId(nowMs, random()),
			nowMs,
			sourceEventId: event.id,
		});
		await (await repoFor(event.websiteId)).insert(note);
	},
});
