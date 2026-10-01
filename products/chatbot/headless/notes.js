/**
 * Headless internal notes of one conversation (used by the inbox core and any merchant-built agent UI): list and add
 * team-only notes (`GET|POST /v1/conversations/{id}/notes`). DOM-free.
 * @module
 */
import { validateNote } from '../core/notes.js';
import { createTranslator } from './strings.js';

/**
 * @typedef {object} NotesState
 * @property {'idle' | 'loading' | 'ready' | 'error'} status
 * @property {ReadonlyArray<{ id: string, text: string, authorName: string | null, at: string }>} notes
 * @property {string} draft
 * @property {boolean} saving
 * @property {string | null} error
 */

/**
 * @param {{ strings?: Record<string, string>, client: { request: (method: string, path: string, options?: Record<string, unknown>) => Promise<any> },
 *   conversationId: string, emit?: (name: string, data: Record<string, unknown>) => void }} options
 */
export const createNotesPanel = ({ strings = {}, client, conversationId, emit = () => {} }) => {
	const t = createTranslator(strings);
	const path = `/v1/conversations/${encodeURIComponent(conversationId)}/notes`;
	/** @type {Set<(state: NotesState) => void>} */
	const listeners = new Set();
	let destroyed = false;
	/** @type {NotesState} */
	let state = Object.freeze({ status: 'idle', notes: [], draft: '', saving: false, error: null });
	/** @param {Partial<NotesState>} patch */
	const set = (patch) => {
		if (destroyed) return;
		state = Object.freeze({ ...state, ...patch });
		for (const listener of listeners) listener(state);
	};
	/** @param {any} item */
	const view = (item) => ({ id: item.id, text: item.text, authorName: item.authorName ?? null, at: item.at });
	const actions = Object.freeze({
		load: async () => {
			set({ status: 'loading', error: null });
			const result = await client.request('GET', path);
			if (!result.ok) {
				set({ status: 'error', error: t('inbox.error.request_failed') });
				return result;
			}
			set({ status: 'ready', notes: (result.value.items ?? []).map(view) });
			return result;
		},
		/** @param {string} text */
		setDraft: async (text) => {
			set({ draft: String(text ?? '') });
			return { ok: true, value: state.draft };
		},
		add: async () => {
			const problems = validateNote({ text: state.draft });
			if (problems.length > 0) {
				set({ error: t('window.form.required') });
				return { ok: false, error: { code: 'validation_failed', status: 422 } };
			}
			set({ saving: true, error: null });
			const result = await client.request('POST', path, { body: { text: state.draft.trim() } });
			set({ saving: false });
			if (!result.ok) {
				set({ error: t('inbox.error.request_failed') });
				return result;
			}
			set({ draft: '', notes: [...state.notes, view(result.value)] });
			emit('note_added', {});
			return result;
		},
	});
	return Object.freeze({
		/** @returns {NotesState} */
		state: () => state,
		actions,
		/** @param {(state: NotesState) => void} listener */
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		/** @param {unknown} input */
		validate: (input) => validateNote(input).map((p) => ({ ...p, message: t('window.form.invalid') })),
		strings,
		t,
		destroy: () => {
			destroyed = true;
			listeners.clear();
		},
	});
};
