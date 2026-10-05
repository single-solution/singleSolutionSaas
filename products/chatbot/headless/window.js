/**
 * Mode B headless core of the chat `window` (Part E §4): state, actions, subscribe, validate, strings, destroy.
 * DOM-free and framework-agnostic: the default renderer (ui/window.js) and any merchant UI use exactly this core.
 *
 * - The conversation is created lazily with the first message (or resumed from the visitor's latest open one).
 * - New messages arrive by polling with the transport (visible only, idle back-off and stop, a fast burst after the
 *   customer sends) using a `since` cursor and the server's ETag (304 = unchanged).
 * - Quick replies, flow buttons and forms, the lead form and the CSAT survey are part of the state.
 *
 * `client` is the element's Mode C client: an `@ss/web/element` API (`request`) or a ready chat client.
 * @module
 */
import { mergeMessages, validateText } from '../core/conversation.js';
import { validateField } from '../core/leads.js';
import { createChatClient } from './chatClient.js';
import { createTranslator } from './strings.js';
import { createTransport } from './transport.js';

/** @typedef {import('./chatClient.js').ChatClient} ChatClient */
/** @typedef {import('./chatClient.js').Problem} Problem */
/** @typedef {import('./transport.js').Scheduler} Scheduler */
/** @typedef {import('./transport.js').Visibility} Visibility */
/**
 * @typedef {object} MessageView
 * @property {string} id
 * @property {string} author customer | bot | agent | system
 * @property {string | null} authorName
 * @property {string} kind
 * @property {string} text
 * @property {Record<string, any>} [payload]
 * @property {string} at
 * @property {boolean} [grouped] same author as the previous message, within the grouping window
 * @property {string} [label] resolved author label
 */
/**
 * @typedef {object} WindowState
 * @property {'idle' | 'loading' | 'ready' | 'error'} status
 * @property {boolean} open
 * @property {string | null} conversationId
 * @property {Record<string, any> | null} conversation customer view of the conversation
 * @property {ReadonlyArray<MessageView>} messages
 * @property {boolean} hasMoreOlder
 * @property {boolean} loadingOlder
 * @property {string} draft
 * @property {boolean} sending
 * @property {boolean} typing
 * @property {number} unread
 * @property {ReadonlyArray<{ label: string, value: string, url?: string }>} quickReplies
 * @property {{ messageId: string, kind: 'flow' | 'lead', text: string, fields: ReadonlyArray<Record<string, any>> } | null} form
 * @property {{ messageId: string, scale: number, comment: boolean } | null} survey
 * @property {boolean} rated
 * @property {boolean} humanRequested
 * @property {boolean} guestLimitReached
 * @property {string | null} error user-facing message
 * @property {string | null} errorCode
 */

/** Problem codes → string keys. */
const ERRORS = Object.freeze({
	guest_limit_reached: 'window.error.guest_limit',
	rate_limited: 'window.error.rate_limited',
	validation_failed: 'window.error.too_long',
	message_rejected: 'window.error.rejected',
	conversation_closed: 'window.error.closed',
	identity_required: 'window.error.identity_required',
});

/**
 * @param {{ config?: Record<string, any>, strings?: Record<string, string>, client: any, identity?: { token: () => string | null | undefined } | null,
 *   emit?: (name: string, data: Record<string, unknown>) => void, scheduler?: Scheduler, visibility?: Visibility | null,
 *   storage?: import('./chatClient.js').TokenStorage, page?: () => Record<string, unknown> | null }} options
 */
export const createWindow = ({
	config = {},
	strings = {},
	client,
	identity = null,
	emit = () => {},
	scheduler = {
		setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
		clearTimeout: (h) => globalThis.clearTimeout(/** @type {any} */ (h)),
		now: Date.now,
	},
	visibility = null,
	storage,
	page = () => null,
}) => {
	const t = createTranslator(strings);
	/** @type {ChatClient} */
	const chat =
		client && typeof client.start === 'function'
			? client
			: createChatClient({ api: client, ...(storage ? { storage } : {}), identity });
	const maxLength = Number(config.max_message_length ?? 2000);
	const groupMs = Number(config.group_messages_within_seconds ?? 60) * 1000;
	const pageSize = Number(config.history_page_size ?? 20);
	/** @type {Set<(state: WindowState) => void>} */
	const listeners = new Set();
	let destroyed = false;
	/** @type {string | null} */
	let etag = null;

	const initialQuick = (/** @type {unknown} */ list) =>
		(Array.isArray(list) ? list : []).filter((q) => typeof q === 'string' && q).map((q) => ({ label: q, value: q }));

	/** @type {WindowState} */
	let state = Object.freeze({
		status: 'idle',
		open: false,
		conversationId: null,
		conversation: null,
		messages: [],
		hasMoreOlder: false,
		loadingOlder: false,
		draft: '',
		sending: false,
		typing: false,
		unread: 0,
		quickReplies: initialQuick(config.quick_replies),
		form: null,
		survey: null,
		rated: false,
		humanRequested: false,
		guestLimitReached: false,
		error: null,
		errorCode: null,
	});
	/** @param {Partial<WindowState>} patch */
	const set = (patch) => {
		if (destroyed) return;
		state = Object.freeze({ ...state, ...patch });
		for (const listener of listeners) listener(state);
	};
	/** @param {Problem} problem */
	const fail = (problem) => {
		const code = problem.code ?? 'request_failed';
		set({
			error: t(/** @type {Record<string, string>} */ (ERRORS)[code] ?? 'window.error.request_failed'),
			errorCode: code,
			...(code === 'guest_limit_reached' ? { guestLimitReached: true } : {}),
		});
		return /** @type {const} */ ({ ok: false, error: problem });
	};

	/** Author labels and grouping. @param {ReadonlyArray<Record<string, any>>} list */
	const decorate = (list) =>
		list.map((m, index) => {
			const previous = list[index - 1];
			const grouped =
				Boolean(previous) &&
				previous?.author === m.author &&
				groupMs > 0 &&
				Date.parse(m.at) - Date.parse(previous?.at) <= groupMs &&
				m.kind === 'text';
			return /** @type {MessageView} */ ({
				...m,
				grouped,
				label: m.authorName || t(`window.author.${m.author}`),
			});
		});

	/** Derived interactive parts from the last messages. @param {ReadonlyArray<MessageView>} messages */
	const interactive = (messages) => {
		const last = [...messages].reverse().find((m) => m.author !== 'customer');
		const lastCustomerAt = [...messages].reverse().find((m) => m.author === 'customer')?.at ?? '';
		const pending = last && last.at >= lastCustomerAt ? last : null;
		/** @type {Pick<WindowState, 'quickReplies' | 'form' | 'survey'>} */
		const out = { quickReplies: messages.length === 0 ? initialQuick(config.quick_replies) : [], form: null, survey: null };
		if (!pending?.payload) return out;
		if (pending.kind === 'buttons' && Array.isArray(pending.payload.buttons))
			out.quickReplies = pending.payload.buttons.map((/** @type {any} */ b) => ({
				label: b.label,
				value: b.value ?? b.label,
				...(b.url ? { url: b.url } : {}),
			}));
		if (pending.kind === 'form' && Array.isArray(pending.payload.fields))
			out.form = {
				messageId: pending.id,
				kind: pending.payload.lead ? 'lead' : 'flow',
				text: pending.text,
				fields: pending.payload.fields,
			};
		if (pending.kind === 'csat' && !state.rated)
			out.survey = {
				messageId: pending.id,
				scale: Number(pending.payload.scale ?? 5),
				comment: pending.payload.comment !== false,
			};
		return out;
	};

	/**
	 * @param {ReadonlyArray<Record<string, any>>} incoming
	 * @param {Record<string, any> | null | undefined} conversation
	 * @param {{ older?: boolean, hasMoreOlder?: boolean }} [options]
	 */
	const absorb = (incoming, conversation, { older = false, hasMoreOlder } = {}) => {
		const known = new Set(state.messages.map((m) => m.id));
		const merged = decorate(mergeMessages(/** @type {any[]} */ (state.messages), /** @type {any[]} */ (incoming)));
		const fresh = incoming.filter((m) => !known.has(m.id) && m.author !== 'customer');
		const conv = conversation ?? state.conversation;
		set({
			status: 'ready',
			messages: merged,
			conversation: conv,
			conversationId: conv?.id ?? state.conversationId,
			humanRequested: Boolean(conv?.humanRequested),
			guestLimitReached: Boolean(conv?.guestLimitReached),
			unread: state.open ? 0 : state.unread + (older ? 0 : fresh.length),
			...(hasMoreOlder === undefined ? {} : { hasMoreOlder }),
			...interactive(merged),
		});
		if (fresh.length > 0 && !older) {
			transport.settleReply();
			transport.touch();
			emit('message_received', { count: fresh.length });
		}
	};

	const poll = async () => {
		const id = state.conversationId;
		if (!id) return;
		const last = state.messages.at(-1)?.at ?? null;
		const result = await chat.messages(id, { since: last, etag, limit: pageSize });
		if (!result.ok) {
			if (result.error.status === 304) return;
			throw result.error;
		}
		etag = result.value.etag ?? null;
		absorb(result.value.items ?? [], result.value.conversation);
		if (state.open && (result.value.conversation?.unread ?? 0) > 0) void chat.read(id);
	};

	const transport = createTransport({
		intervalMs: Number(config.poll_interval_ms ?? 10_000),
		idleAfterMs: Number(config.poll_idle_after_ms ?? 300_000),
		idleIntervalMs: Number(config.poll_idle_interval_ms ?? 20_000),
		stopAfterMs: Number(config.poll_stop_after_ms ?? 900_000),
		burstIntervalMs: Number(config.poll_burst_interval_ms ?? 3_000),
		burstWindowMs: Number(config.poll_burst_window_ms ?? 45_000),
		onTick: poll,
		onError: () => {},
		scheduler,
		visibility,
	});

	/** Resume the visitor's latest open conversation. */
	const resume = async () => {
		if (state.conversationId || !chat.hasIdentity()) return { ok: true, value: null };
		set({ status: 'loading' });
		const listed = await chat.list({ status: 'open' });
		if (!listed.ok) {
			set({ status: 'ready' });
			return listed.error.code === 'identity_required' ? { ok: true, value: null } : fail(listed.error);
		}
		const latest = (listed.value.items ?? [])[0];
		if (!latest) {
			set({ status: 'ready' });
			return { ok: true, value: null };
		}
		set({ conversationId: latest.id, conversation: latest });
		const page1 = await chat.messages(latest.id, { limit: pageSize });
		if (!page1.ok) return fail(page1.error);
		etag = page1.value.etag ?? null;
		absorb(page1.value.items ?? [], page1.value.conversation ?? latest, { hasMoreOlder: Boolean(page1.value.hasMoreOlder) });
		return { ok: true, value: latest };
	};

	/** @param {Record<string, any>} value send / start response */
	const afterSend = (value) => {
		const items = [...(value.messages ?? []), ...(value.message ? [value.message] : []), ...(value.replies ?? [])];
		absorb(items, value.conversation);
		if (value.conversation?.humanRequested || value.conversation?.aiPaused) transport.expectReply();
		transport.touch();
	};

	/** @param {{ text?: string, action?: Record<string, any> }} body */
	const post = async (body) => {
		if (state.sending) return { ok: false, error: { code: 'busy', status: 0 } };
		set({ sending: true, typing: Boolean(config.typing_indicator ?? true), error: null, errorCode: null });
		const result = state.conversationId
			? await chat.send(state.conversationId, body)
			: await chat.start({ ...body, context: { page: page() ?? undefined } });
		set({ sending: false, typing: false });
		if (!result.ok) return fail(result.error);
		if (!state.conversationId && result.value.conversation?.id) {
			set({ conversationId: result.value.conversation.id });
			emit('started', { conversationId: result.value.conversation.id });
			if (state.open) transport.start();
		}
		afterSend(result.value);
		emit('message_sent', { kind: body.action ? body.action.kind : 'text' });
		return result;
	};

	const actions = Object.freeze({
		open: async () => {
			if (state.open) return { ok: true, value: state };
			set({ open: true, unread: 0 });
			emit('opened', {});
			const resumed = await resume();
			if (state.conversationId) {
				transport.start();
				transport.pollNow();
				if ((state.conversation?.unread ?? 0) > 0) void chat.read(state.conversationId);
			}
			return resumed.ok ? { ok: true, value: state } : resumed;
		},
		close: async () => {
			set({ open: false });
			transport.stop();
			emit('closed', {});
			return { ok: true, value: state };
		},
		toggle: async () => (state.open ? actions.close() : actions.open()),
		/** @param {string} text */
		setDraft: async (text) => {
			set({ draft: typeof text === 'string' ? text : '' });
			transport.touch();
			return { ok: true, value: state.draft };
		},
		/** @param {string} [text] defaults to the draft */
		send: async (text) => {
			const checked = validateText(text ?? state.draft, { maxLength });
			if (!checked.ok) return fail({ code: 'validation_failed', status: 422, errors: checked.problems });
			const result = await post({ text: checked.text });
			if (result.ok) set({ draft: '' });
			return result;
		},
		/** @param {{ label: string, value: string, url?: string }} reply */
		choose: async (reply) => {
			if (reply.url) {
				emit('link_opened', { url: reply.url });
				return { ok: true, value: { url: reply.url } };
			}
			const last = [...state.messages].reverse().find((m) => m.author !== 'customer');
			return last?.kind === 'buttons'
				? post({ text: reply.label, action: { kind: 'button', value: reply.value } })
				: post({ text: reply.value });
		},
		/** @param {Record<string, unknown>} values @param {{ consent?: boolean }} [options] */
		submitForm: async (values, { consent } = {}) => {
			const form = state.form;
			if (!form) return fail({ code: 'no_form', status: 0 });
			const problems = validateForm(form.fields, values);
			if (problems.length > 0) return fail({ code: 'validation_failed', status: 422, errors: problems });
			if (form.kind === 'lead') {
				const result = await chat.lead({
					conversationId: state.conversationId ?? undefined,
					fields: values,
					consent: consent === true,
				});
				if (!result.ok) return fail(result.error);
				emit('lead_submitted', {});
				set({ form: null });
				await poll().catch(() => {});
				return result;
			}
			return post({ action: { kind: 'form', values } });
		},
		loadOlder: async () => {
			const first = state.messages[0];
			if (!state.conversationId || !state.hasMoreOlder || state.loadingOlder || !first)
				return { ok: false, error: { code: 'no_more', status: 0 } };
			set({ loadingOlder: true });
			const result = await chat.messages(state.conversationId, { before: first.id, limit: pageSize });
			set({ loadingOlder: false });
			if (!result.ok) return fail(result.error);
			absorb(result.value.items ?? [], result.value.conversation, {
				older: true,
				hasMoreOlder: Boolean(result.value.hasMoreOlder),
			});
			return result;
		},
		refresh: async () => {
			try {
				await poll();
				return { ok: true, value: state };
			} catch (error) {
				return fail(/** @type {Problem} */ (error));
			}
		},
		/** @param {number} score @param {string} [comment] */
		rate: async (score, comment) => {
			if (!state.conversationId) return fail({ code: 'no_conversation', status: 0 });
			const result = await chat.rate({ conversationId: state.conversationId, score, ...(comment ? { comment } : {}) });
			if (!result.ok) return fail(result.error);
			set({ rated: true, survey: null });
			emit('rated', { score });
			return result;
		},
		requestHuman: async () => {
			if (!state.conversationId) return fail({ code: 'no_conversation', status: 0 });
			const result = await chat.handoff({ conversationId: state.conversationId });
			if (!result.ok) return fail(result.error);
			set({ humanRequested: true });
			transport.expectReply();
			await poll().catch(() => {});
			return result;
		},
		newConversation: async () => {
			transport.stop();
			etag = null;
			set({
				conversationId: null,
				conversation: null,
				messages: [],
				hasMoreOlder: false,
				rated: false,
				humanRequested: false,
				...interactive([]),
			});
			return { ok: true, value: state };
		},
		/** Link guest history to the signed-in customer (call after the site's login). */
		claim: async () => {
			const result = await chat.claim();
			return result.ok ? result : fail(result.error);
		},
	});

	return Object.freeze({
		/** @returns {WindowState} */
		state: () => state,
		actions,
		/** @param {(state: WindowState) => void} listener */
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		/**
		 * Field problems of a message or form input.
		 * @param {unknown} input string (message) or `{ fields, values }`
		 */
		validate: (input) => {
			if (typeof input === 'string') {
				const checked = validateText(input, { maxLength });
				return checked.ok
					? []
					: checked.problems.map((p) => ({
							...p,
							message: t(p.code === 'too_long' ? 'window.error.too_long' : 'window.form.required'),
						}));
			}
			const i = /** @type {any} */ (input);
			return validateForm(Array.isArray(i?.fields) ? i.fields : (state.form?.fields ?? []), i?.values ?? {}).map((p) => ({
				...p,
				message: t(p.code === 'required' ? 'window.form.required' : 'window.form.invalid'),
			}));
		},
		strings,
		t,
		transport,
		destroy: () => {
			destroyed = true;
			transport.stop();
			listeners.clear();
		},
	});
};

/**
 * @param {ReadonlyArray<Record<string, any>>} fields
 * @param {Record<string, unknown>} values
 */
const validateForm = (fields, values) =>
	fields
		.map((field) => ({ path: `/${field.name}`, code: validateField(/** @type {any} */ (field), values?.[field.name]) }))
		.filter((p) => p.code !== null)
		.map((p) => ({ path: p.path, code: /** @type {string} */ (p.code) }));
