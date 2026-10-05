/**
 * Mode B headless core of the `notes` element: state, actions, subscribe, validate, strings, destroy (Part E §4).
 * Framework-agnostic, DOM-free. `client` is the element's Mode C client (REST for service products, the Website Graph
 * for element packs), already scoped to the website key and entitlement by the runtime.
 */
import { canAddNote, resolveConfig, sortNotes, validateNoteInput } from '../core/notes.js';
import { createTranslator } from './strings.js';

/** @typedef {import('../core/notes.js').NoteProblem} NoteProblem */
/** @typedef {{ id: string, text: string, pinned: boolean, createdAt: string, updatedAt: string }} PublicNote */
/** @typedef {{ type?: string, title?: string, status?: number, detail?: string, code?: string }} Problem */
/**
 * @template T
 * @typedef {{ ok: true, value: T } | { ok: false, problem: Problem }} Result
 */
/**
 * @typedef {object} NotesClient
 * @property {() => Promise<Result<{ items: PublicNote[] }>>} list
 * @property {(input: { text: string, pinned?: boolean }) => Promise<Result<PublicNote>>} create
 * @property {(id: string, patch: { text?: string, pinned?: boolean }) => Promise<Result<PublicNote>>} update
 * @property {(id: string) => Promise<Result<{ id: string }>>} remove
 */
/**
 * @typedef {object} NotesState
 * @property {'idle' | 'loading' | 'ready' | 'error'} status
 * @property {readonly PublicNote[]} notes
 * @property {string} draft
 * @property {boolean} canAdd
 * @property {boolean} showTimestamps
 * @property {string | null} error resolved, user-facing message
 */

/** Problem codes → string keys (all keys live in strings/en.json). */
export const PROBLEM_STRINGS = Object.freeze({
	text_required: 'notes.error.text_required',
	text_too_long: 'notes.error.text_too_long',
	text_invalid: 'notes.error.text_invalid',
	pinned_invalid: 'notes.error.text_invalid',
	unknown_field: 'notes.error.text_invalid',
	limit_reached: 'notes.error.limit_reached',
	request_failed: 'notes.error.request_failed',
});

/**
 * @param {{ config?: Record<string, unknown>, strings?: Record<string, string>, client: NotesClient,
 *   identity?: unknown, emit?: (name: string, data: Record<string, unknown>) => void }} options
 */
export const createNotes = ({ config = {}, strings = {}, client, emit = () => {} }) => {
	const settings = resolveConfig(config);
	const t = createTranslator(strings);
	/** @type {Set<(state: NotesState) => void>} */
	const listeners = new Set();
	let destroyed = false;
	/** @type {NotesState} */
	let state = Object.freeze({
		status: 'idle',
		notes: [],
		draft: '',
		canAdd: true,
		showTimestamps: settings.show_timestamps,
		error: null,
	});

	/** @param {Partial<NotesState>} patch */
	const set = (patch) => {
		if (destroyed) return;
		const notes = patch.notes === undefined ? state.notes : sortNotes(patch.notes);
		state = Object.freeze({ ...state, ...patch, notes, canAdd: canAddNote(notes.length, settings) });
		for (const listener of listeners) listener(state);
	};

	/** @param {string} code */
	const message = (code) =>
		t(
			Object.hasOwn(PROBLEM_STRINGS, code)
				? PROBLEM_STRINGS[/** @type {keyof typeof PROBLEM_STRINGS} */ (code)]
				: PROBLEM_STRINGS.request_failed,
			{
				max: code === 'limit_reached' ? settings.max_notes : settings.max_length,
			},
		);

	/**
	 * @template T
	 * @param {Result<T>} result
	 * @returns {Result<T>}
	 */
	const failed = (result) => {
		if (!result.ok) set({ status: 'error', error: message(result.problem.code ?? 'request_failed') });
		return result;
	};

	/**
	 * Pure input validation with resolved messages.
	 * @param {unknown} input
	 * @returns {(NoteProblem & { message: string })[]}
	 */
	const validate = (input) =>
		validateNoteInput(input, settings).map((problem) => ({ ...problem, message: message(problem.code) }));

	const actions = Object.freeze({
		/** @returns {Promise<Result<{ items: PublicNote[] }>>} */
		load: async () => {
			set({ status: 'loading', error: null });
			const result = await client.list();
			if (result.ok) set({ status: 'ready', notes: result.value.items });
			return failed(result);
		},
		/**
		 * @param {string} text
		 * @returns {Promise<Result<string>>}
		 */
		setDraft: async (text) => {
			set({ draft: text, error: null });
			return { ok: true, value: text };
		},
		/** @returns {Promise<Result<PublicNote>>} */
		add: async () => {
			const problems = validate({ text: state.draft });
			if (problems.length > 0) {
				const first = /** @type {NoteProblem & { message: string }} */ (problems[0]);
				set({ error: first.message });
				return { ok: false, problem: { code: first.code, detail: first.message } };
			}
			if (!state.canAdd) {
				set({ error: message('limit_reached') });
				return { ok: false, problem: { code: 'limit_reached' } };
			}
			const result = await client.create({ text: state.draft });
			if (result.ok) {
				set({ status: 'ready', notes: [...state.notes, result.value], draft: '', error: null });
				emit('notes.added', { id: result.value.id });
			}
			return failed(result);
		},
		/**
		 * @param {string} id
		 * @returns {Promise<Result<PublicNote>>}
		 */
		togglePin: async (id) => {
			const note = state.notes.find((candidate) => candidate.id === id);
			if (!note) return { ok: false, problem: { code: 'not_found' } };
			const result = await client.update(id, { pinned: !note.pinned });
			if (result.ok) set({ notes: state.notes.map((candidate) => (candidate.id === id ? result.value : candidate)) });
			return failed(result);
		},
		/**
		 * @param {string} id
		 * @returns {Promise<Result<{ id: string }>>}
		 */
		remove: async (id) => {
			const result = await client.remove(id);
			if (result.ok) {
				set({ notes: state.notes.filter((candidate) => candidate.id !== id) });
				emit('notes.removed', { id });
			}
			return failed(result);
		},
	});

	return Object.freeze({
		/** @returns {NotesState} immutable snapshot */
		state: () => state,
		actions,
		/**
		 * @param {(state: NotesState) => void} listener
		 * @returns {() => void} unsubscribe
		 */
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		validate,
		strings,
		t,
		destroy: () => {
			destroyed = true;
			listeners.clear();
		},
	});
};
