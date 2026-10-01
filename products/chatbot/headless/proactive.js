/**
 * Mode B headless core of `proactive` messages: asks the product which message (if any) to show for the visitor's
 * context (`POST /v1/proactive:evaluate`, frequency caps enforced server-side), waits the rule's delay, shows it,
 * remembers dismissals (`POST /v1/proactive:dismiss`) and can hand over to the chat window.
 * @module
 */
import { createChatClient } from './chatClient.js';
import { createTranslator } from './strings.js';

/**
 * @typedef {object} ProactiveState
 * @property {'idle' | 'loading' | 'waiting' | 'shown' | 'dismissed' | 'none' | 'error'} status
 * @property {{ ruleId: string, message: string, openWindow: boolean, delaySeconds: number } | null} message
 * @property {string | null} error
 */

/**
 * @param {{ config?: Record<string, any>, strings?: Record<string, string>, client: any, identity?: { token: () => string | null | undefined } | null,
 *   emit?: (name: string, data: Record<string, unknown>) => void, storage?: import('./chatClient.js').TokenStorage,
 *   window?: { actions: { open: () => Promise<unknown> } } | null, visitor?: { id: string | null, sessionId: string | null },
 *   scheduler?: { setTimeout: (fn: () => void, ms: number) => unknown, clearTimeout: (handle: unknown) => void } }} options
 */
export const createProactive = ({
	strings = {},
	client,
	identity = null,
	emit = () => {},
	storage,
	window: chatWindow = null,
	visitor = { id: null, sessionId: null },
	scheduler = {
		setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
		clearTimeout: (h) => globalThis.clearTimeout(/** @type {any} */ (h)),
	},
}) => {
	const t = createTranslator(strings);
	const chat =
		client && typeof client.proactive === 'function'
			? client
			: createChatClient({ api: client, ...(storage ? { storage } : {}), identity });
	/** @type {Set<(state: ProactiveState) => void>} */
	const listeners = new Set();
	let destroyed = false;
	/** @type {unknown} */
	let timer = null;
	/** @type {ProactiveState} */
	let state = Object.freeze({ status: 'idle', message: null, error: null });
	/** @param {Partial<ProactiveState>} patch */
	const set = (patch) => {
		if (destroyed) return;
		state = Object.freeze({ ...state, ...patch });
		for (const listener of listeners) listener(state);
	};

	const actions = Object.freeze({
		/** @param {Record<string, unknown>} context page / visitor / cart signals */
		evaluate: async (context) => {
			set({ status: 'loading', error: null });
			const result = await chat.proactive({ context, visitorId: visitor.id, sessionId: visitor.sessionId });
			if (!result.ok) {
				set({ status: 'error', error: t('window.error.request_failed') });
				return result;
			}
			const message = result.value.message ?? null;
			if (!message) {
				set({ status: 'none', message: null });
				return result;
			}
			set({ status: 'waiting', message });
			if (timer !== null) scheduler.clearTimeout(timer);
			timer = scheduler.setTimeout(
				() => {
					timer = null;
					set({ status: 'shown' });
					emit('shown', { ruleId: message.ruleId });
					if (message.openWindow) void chatWindow?.actions.open();
				},
				Math.max(0, Number(message.delaySeconds ?? 0)) * 1000,
			);
			return result;
		},
		dismiss: async () => {
			const message = state.message;
			if (!message) return { ok: false, error: { code: 'nothing_shown', status: 0 } };
			set({ status: 'dismissed' });
			emit('dismissed', { ruleId: message.ruleId });
			return chat.dismissProactive({ ruleId: message.ruleId, visitorId: visitor.id });
		},
		reply: async () => {
			const message = state.message;
			if (!message) return { ok: false, error: { code: 'nothing_shown', status: 0 } };
			set({ status: 'dismissed' });
			emit('replied', { ruleId: message.ruleId });
			await chatWindow?.actions.open();
			return { ok: true, value: message };
		},
	});

	return Object.freeze({
		/** @returns {ProactiveState} */
		state: () => state,
		actions,
		/** @param {(state: ProactiveState) => void} listener */
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		/** @returns {Array<{ path: string, code: string, message: string }>} */
		validate: () => [],
		strings,
		t,
		destroy: () => {
			destroyed = true;
			if (timer !== null) scheduler.clearTimeout(timer);
			listeners.clear();
		},
	});
};
