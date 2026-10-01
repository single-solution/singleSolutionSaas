/**
 * Mode B headless core of `csat`: the rating scale, the selected score, an optional comment and submission
 * (`POST /v1/ratings`, once per conversation).
 * @module
 */
import { createChatClient } from './chatClient.js';
import { createTranslator } from './strings.js';

/**
 * @typedef {object} CsatState
 * @property {'idle' | 'submitting' | 'submitted' | 'error'} status
 * @property {number} scale
 * @property {ReadonlyArray<{ score: number, label: string }>} options
 * @property {number | null} score
 * @property {string} comment
 * @property {boolean} commentEnabled
 * @property {string | null} error
 */

/**
 * @param {{ config?: Record<string, any>, strings?: Record<string, string>, client: any, identity?: { token: () => string | null | undefined } | null,
 *   emit?: (name: string, data: Record<string, unknown>) => void, storage?: import('./chatClient.js').TokenStorage, conversationId: string }} options
 */
export const createCsat = ({ config = {}, strings = {}, client, identity = null, emit = () => {}, storage, conversationId }) => {
	const t = createTranslator(strings);
	const chat =
		client && typeof client.rate === 'function'
			? client
			: createChatClient({ api: client, ...(storage ? { storage } : {}), identity });
	const scale = [2, 3, 5, 10].includes(Number(config.scale)) ? Number(config.scale) : 5;
	const maxComment = Number(config.comment_max_length ?? 1000);
	/** @type {Set<(state: CsatState) => void>} */
	const listeners = new Set();
	let destroyed = false;
	/** @type {CsatState} */
	let state = Object.freeze({
		status: 'idle',
		scale,
		options: Array.from({ length: scale }, (_, i) => ({
			score: i + 1,
			label: t('window.csat.score', { score: i + 1, scale }),
		})),
		score: null,
		comment: '',
		commentEnabled: config.follow_up !== false,
		error: null,
	});
	/** @param {Partial<CsatState>} patch */
	const set = (patch) => {
		if (destroyed) return;
		state = Object.freeze({ ...state, ...patch });
		for (const listener of listeners) listener(state);
	};
	/** @param {{ score?: unknown, comment?: unknown }} input */
	const problems = (input) => {
		/** @type {Array<{ path: string, code: string, message: string }>} */
		const out = [];
		if (!Number.isInteger(input.score) || Number(input.score) < 1 || Number(input.score) > scale)
			out.push({ path: '/score', code: 'out_of_range', message: t('window.form.required') });
		if (typeof input.comment === 'string' && [...input.comment].length > maxComment)
			out.push({ path: '/comment', code: 'too_long', message: t('window.form.invalid') });
		return out;
	};
	const actions = Object.freeze({
		/** @param {number} score */
		select: async (score) => {
			set({ score });
			return { ok: true, value: score };
		},
		/** @param {string} comment */
		setComment: async (comment) => {
			set({ comment: String(comment ?? '') });
			return { ok: true, value: state.comment };
		},
		submit: async () => {
			const found = problems({ score: state.score, comment: state.comment });
			if (found.length > 0) {
				set({ status: 'error', error: found[0]?.message ?? null });
				return { ok: false, error: { code: 'validation_failed', status: 422 } };
			}
			set({ status: 'submitting', error: null });
			const result = await chat.rate({
				conversationId,
				score: /** @type {number} */ (state.score),
				...(state.commentEnabled && state.comment.trim() ? { comment: state.comment.trim() } : {}),
			});
			if (!result.ok) {
				set({ status: 'error', error: t('csat.error.request_failed') });
				return result;
			}
			set({ status: 'submitted' });
			emit('rated', { score: state.score });
			return result;
		},
	});
	return Object.freeze({
		/** @returns {CsatState} */
		state: () => state,
		actions,
		/** @param {(state: CsatState) => void} listener */
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		/** @param {unknown} input */
		validate: (input) => problems(/** @type {any} */ (input) ?? {}),
		strings,
		t,
		destroy: () => {
			destroyed = true;
			listeners.clear();
		},
	});
};
