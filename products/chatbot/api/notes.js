/**
 * Internal-note handler shared by the server (`sk_`) and dashboard routes: validates the note (core/notes.js), stores
 * it through the service (team-only message + `chatbot.note_created@1`) and answers with the team view.
 */
import { created } from '@ss/app-kit';
import { messageView } from '../core/conversation.js';
import { validateNote } from '../core/notes.js';
import { invalid } from './reply.js';

/**
 * @param {{ service: import('./service.js').ChatbotService }} deps
 */
export const createNoteHandler =
	({ service }) =>
	/**
	 * @param {any} ctx
	 * @param {import('./service.js').Site} site
	 * @param {import('../core/conversation.js').Conversation} conversation
	 * @param {import('./service.js').Actor} actor
	 * @param {string | null} agentId
	 */
	async (ctx, site, conversation, actor, agentId) => {
		const problems = validateNote(ctx.body);
		if (problems.length > 0) return invalid(problems);
		const note = await service.note(site, conversation, {
			text: ctx.body.text,
			mentions: ctx.body.mentions,
			key: ctx.idempotencyKey,
			actor,
			agentId,
		});
		return created(messageView(note, 'team'));
	};
