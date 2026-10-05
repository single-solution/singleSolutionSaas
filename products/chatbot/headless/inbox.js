/**
 * Mode B headless core of the `inbox`: the agent side of the chat for a merchant-built agent console (behind the
 * merchant's own server, which holds the `sk_` key) — the queue with filters, one open conversation with its
 * messages (polled with the same transport as the window), replies, canned replies, status / assignment changes and
 * internal notes (headless/notes.js). DOM-free.
 * @module
 */
import { mergeMessages, validateText } from '../core/conversation.js';
import { createNotesPanel } from './notes.js';
import { createTranslator } from './strings.js';
import { createTransport } from './transport.js';

/**
 * @typedef {object} InboxState
 * @property {'idle' | 'loading' | 'ready' | 'error'} status
 * @property {ReadonlyArray<Record<string, any>>} queue
 * @property {{ status?: string, assignee?: string, team?: string }} filter
 * @property {Record<string, any> | null} current
 * @property {ReadonlyArray<Record<string, any>>} messages
 * @property {ReadonlyArray<{ key: string, title: string, body: string }>} canned
 * @property {string} draft
 * @property {boolean} sending
 * @property {string | null} error
 */

/**
 * @param {{ config?: Record<string, any>, strings?: Record<string, string>, client: { request: (method: string, path: string, options?: Record<string, unknown>) => Promise<any> },
 *   identity?: unknown, emit?: (name: string, data: Record<string, unknown>) => void, agentId?: string | null,
 *   scheduler?: import('./transport.js').Scheduler, visibility?: import('./transport.js').Visibility | null }} options
 */
export const createInbox = ({
	config = {},
	strings = {},
	client,
	emit = () => {},
	agentId = null,
	scheduler = {
		setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
		clearTimeout: (h) => globalThis.clearTimeout(/** @type {any} */ (h)),
		now: Date.now,
	},
	visibility = null,
}) => {
	const t = createTranslator(strings);
	/** @type {Set<(state: InboxState) => void>} */
	const listeners = new Set();
	let destroyed = false;
	/** @type {string | null} */
	let etag = null;
	/** @type {ReturnType<typeof createNotesPanel> | null} */
	let notes = null;
	/** @type {InboxState} */
	let state = Object.freeze({
		status: 'idle',
		queue: [],
		filter: {},
		current: null,
		messages: [],
		canned: [],
		draft: '',
		sending: false,
		error: null,
	});
	/** @param {Partial<InboxState>} patch */
	const set = (patch) => {
		if (destroyed) return;
		state = Object.freeze({ ...state, ...patch });
		for (const listener of listeners) listener(state);
	};
	/** @param {any} result */
	const failed = (result) => {
		set({ error: t('inbox.error.request_failed') });
		return result;
	};
	const conv = (/** @type {string} */ id) => `/v1/conversations/${encodeURIComponent(id)}`;

	const pollCurrent = async () => {
		const id = state.current?.id;
		if (!id) return;
		const since = state.messages.at(-1)?.at;
		const result = await client.request('GET', `${conv(id)}/messages`, {
			query: since ? { since } : {},
			headers: etag ? { 'if-none-match': etag } : {},
		});
		if (!result.ok) return;
		etag = result.value.etag ?? null;
		set({
			messages: mergeMessages(/** @type {any[]} */ (state.messages), result.value.items ?? []),
			current: result.value.conversation ?? state.current,
		});
	};
	const transport = createTransport({
		intervalMs: Number(config.poll_interval_ms ?? 10_000),
		idleAfterMs: 300_000,
		idleIntervalMs: 30_000,
		stopAfterMs: 3_600_000,
		burstIntervalMs: 3_000,
		burstWindowMs: 30_000,
		onTick: pollCurrent,
		scheduler,
		visibility,
	});

	const actions = Object.freeze({
		/** @param {{ status?: string, assignee?: string, team?: string }} [filter] */
		load: async (filter = state.filter) => {
			set({ status: 'loading', filter, error: null });
			const query = Object.fromEntries(Object.entries(filter).filter(([, v]) => typeof v === 'string' && v));
			const [queue, canned] = await Promise.all([
				client.request('GET', '/v1/conversations', { query }),
				client.request('GET', '/v1/inbox/canned-replies'),
			]);
			if (!queue.ok) {
				set({ status: 'error' });
				return failed(queue);
			}
			set({ status: 'ready', queue: queue.value.items ?? [], canned: canned.ok ? (canned.value.items ?? []) : [] });
			return queue;
		},
		/** @param {string} id */
		select: async (id) => {
			transport.stop();
			etag = null;
			notes?.destroy();
			const result = await client.request('GET', `${conv(id)}/messages`);
			if (!result.ok) return failed(result);
			etag = result.value.etag ?? null;
			notes = createNotesPanel({ strings, client, conversationId: id, emit });
			set({ current: result.value.conversation ?? { id }, messages: result.value.items ?? [], draft: '' });
			transport.start();
			return result;
		},
		/** @param {string} text */
		setDraft: async (text) => {
			set({ draft: String(text ?? '') });
			transport.touch();
			return { ok: true, value: state.draft };
		},
		/** @param {string} key */
		useCanned: async (key) => {
			const id = state.current?.id;
			if (!id) return { ok: false, error: { code: 'no_conversation', status: 0 } };
			const result = await client.request('POST', '/v1/inbox/canned-replies:render', {
				body: { key, conversationId: id, ...(agentId ? { agentId } : {}) },
			});
			if (!result.ok) return failed(result);
			set({ draft: result.value.text ?? '' });
			return result;
		},
		reply: async () => {
			const id = state.current?.id;
			const checked = validateText(state.draft, { maxLength: Number(config.max_message_length ?? 8000) });
			if (!id || !checked.ok) return { ok: false, error: { code: 'validation_failed', status: 422 } };
			set({ sending: true, error: null });
			const result = await client.request('POST', `${conv(id)}/messages`, {
				body: { text: checked.text, author: 'agent', ...(agentId ? { agentId } : {}) },
			});
			set({ sending: false });
			if (!result.ok) return failed(result);
			set({
				draft: '',
				messages: mergeMessages(/** @type {any[]} */ (state.messages), [result.value.message]),
				current: result.value.conversation ?? state.current,
			});
			emit('replied', {});
			transport.expectReply();
			return result;
		},
		/** @param {Record<string, unknown>} patch status, assignee, team, priority, tags, snoozedUntil, aiPaused */
		update: async (patch) => {
			const id = state.current?.id;
			if (!id) return { ok: false, error: { code: 'no_conversation', status: 0 } };
			const result = await client.request('PATCH', conv(id), { body: patch });
			if (!result.ok) return failed(result);
			set({ current: result.value, queue: state.queue.map((c) => (c.id === id ? result.value : c)) });
			return result;
		},
		refresh: async () => {
			await pollCurrent();
			return { ok: true, value: state };
		},
	});

	return Object.freeze({
		/** @returns {InboxState} */
		state: () => state,
		actions,
		/** The notes panel of the selected conversation (null before `select`). */
		notes: () => notes,
		/** @param {(state: InboxState) => void} listener */
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		/** @param {unknown} input reply text */
		validate: (input) => {
			const checked = validateText(input, { maxLength: Number(config.max_message_length ?? 8000) });
			return checked.ok ? [] : checked.problems.map((p) => ({ ...p, message: t('window.form.invalid') }));
		},
		strings,
		t,
		destroy: () => {
			destroyed = true;
			transport.stop();
			notes?.destroy();
			listeners.clear();
		},
	});
};
