/**
 * The machinery behind Chat's routes (PLAN 0.8.3):
 *
 * - `site(ctx)`: the website of a request (merchant database store, switched-on features, settings and texts read
 *   once per request).
 * - `visitorOf(site)`: who is chatting — the Accounts user of a verified sign-in (signed-in chat on), else the guest of
 *   the device's guest key; a device showing both moves the guest's chats to the account.
 * - Views of a conversation for the visitor and for staff, attachment links, the queue position and office hours.
 * - Messages through Notifications (pasted token): staff alerts, AI cost alerts and transcripts.
 * - AI token counts per day and month window, the caps and the monthly cost alert.
 * @module
 */
import { problem } from '@ss/app-kit';
import { createId } from '@ss/contracts';
import { capReached, windowKeys, alertCrossed } from '../core/caps.js';
import { iso, previewOf, staffMessageView, visitorMessageView } from '../core/conversation.js';
import { waitingView } from '../core/flows.js';
import { backAtText, officeState, parseOfficeHours } from '../core/handoff.js';
import { zoneOr } from '../core/time.js';
import { GUEST_HEADER, SIGN_IN_HEADER } from '../core/widgets.js';
import { randomSecret, sha256 } from '../adapters/crypto.js';
import { createStore } from '../adapters/store.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('../adapters/store.js').Store} Store */
/** @typedef {import('../core/conversation.js').ConversationRecord} ConversationRecord */
/** @typedef {import('../core/conversation.js').MessageRecord} MessageRecord */
/** @typedef {import('../core/conversation.js').Author} Author */
/**
 * @typedef {object} Site
 * @property {string} websiteId
 * @property {string | null} merchantId
 * @property {Store} store
 * @property {string[]} on switched-on features
 * @property {any} ctx the request
 * @property {(feature: string) => Promise<Record<string, any>>} values a feature's settings (read once per request)
 * @property {() => Promise<Record<string, string>>} texts the widget texts
 * @property {() => Promise<{ name: string, email?: string, phone?: string, address?: string, timeZone: string }>} business
 * @property {(name: import('../adapters/lists.js').ListName) => Promise<any[]>} list
 */
/**
 * @typedef {{ kind: 'user', id: string, name: string | null, email: string | null, phone: string | null }
 *   | { kind: 'guest', id: string, name: null, email: null, phone: null }} Visitor
 */
/** @typedef {{ kind: string, id: string, name: string, email?: string }} Actor */

/** How long an attachment link lasts (seconds). */
const LINK_SECONDS = 600;
/** Presence: someone whose inbox has not checked in for this long is Offline. */
export const PRESENCE_MS = 5 * 60_000;
/** Longest transcript value Notifications accepts (characters). */
const TRANSCRIPT_MAX = 1000;

/** @param {unknown} value */
export const bodyOf = (value) =>
	typeof value === 'object' && value !== null && !Array.isArray(value) ? /** @type {any} */ (value) : {};

/**
 * A 422 with the check's messages.
 * @param {string[]} errors
 */
export const invalid = (errors) =>
	problem('validation_failed', errors[0] ?? 'Not valid.', { errors: errors.map((message) => ({ path: '', message })) });

/**
 * @param {Product} product
 */
export const createService = (product) => {
	const { now } = product;

	/**
	 * The website of a request.
	 * @param {any} ctx
	 * @returns {Promise<Site>}
	 */
	const site = async (ctx) => {
		const websiteId = /** @type {string} */ (ctx.websiteId);
		const store = createStore(await ctx.data(), { now });
		const on = await product.featuresOn(websiteId);
		/** @type {Map<string, Promise<any>>} */
		const memo = new Map();
		/** @template T @param {string} key @param {() => Promise<T>} load @returns {Promise<T>} */
		const once = (key, load) => {
			if (!memo.has(key)) memo.set(key, load());
			return /** @type {Promise<T>} */ (memo.get(key));
		};
		return {
			websiteId,
			merchantId: ctx.merchantId ?? null,
			store,
			on,
			ctx,
			values: (feature) => once(`v:${feature}`, () => product.settings.values(websiteId, feature)),
			texts: () => once('texts', () => product.settings.texts(websiteId)),
			business: () =>
				once('business', async () => {
					const found = /** @type {any} */ (await product.business(websiteId));
					return { ...found, name: String(found.name), timeZone: zoneOr(found.timeZone) };
				}),
			list: (name) => once(`l:${name}`, () => product.lists.get(websiteId, name)),
		};
	};

	// ------------------------------------------------------------------------------------------------- visitors

	/**
	 * Who is chatting. A sign-in that does not verify counts as no sign-in (the visitor may still chat as a guest).
	 * @param {Site} s
	 * @returns {Promise<Visitor | null>}
	 */
	const visitorOf = async (s) => {
		const headers = s.ctx.headers;
		const signIn = headers.get(SIGN_IN_HEADER);
		/** @type {Visitor | null} */
		let user = null;
		if (signIn && s.on.includes('signed_in_chat')) {
			const verified = await product.accounts.verify({ websiteId: s.websiteId, token: signIn });
			if (verified.ok)
				user = {
					kind: 'user',
					id: verified.user.id,
					name: verified.user.name ?? null,
					email: verified.user.email ?? null,
					phone: verified.user.phone ?? null,
				};
		}
		const key = headers.get(GUEST_HEADER);
		const guest = key && key.length >= 20 && key.length <= 100 ? await s.store.guests.byKey(sha256(key)) : null;
		if (user && guest) await s.store.conversations.moveGuest(guest.id, user.id);
		if (user) return user;
		return guest ? { kind: 'guest', id: guest.id, name: null, email: null, phone: null } : null;
	};

	/**
	 * A new guest for this device: the key is answered once and kept only as a hash.
	 * @param {Site} s
	 */
	const newGuest = async (s) => {
		const { rememberDays } = await s.values('guest_chat');
		const key = `g_${randomSecret(24)}`;
		const { id } = await s.store.guests.create(sha256(key), new Date(now() + Number(rememberDays) * 86_400_000));
		return { key, visitor: /** @type {Visitor} */ ({ kind: 'guest', id, name: null, email: null, phone: null }) };
	};

	// ---------------------------------------------------------------------------------------------- messages

	/**
	 * Append a message (and move the conversation's counters).
	 * @param {Site} s
	 * @param {ConversationRecord} c
	 * @param {{ author: Author, text: string, name?: string | null, staffId?: string | null, internal?: boolean,
	 *   buttons?: string[], attachment?: import('../core/conversation.js').Attachment | null }} input
	 * @param {{ set?: Record<string, unknown>, inc?: Record<string, number> }} [change] more changes with it
	 * @returns {Promise<{ message: MessageRecord, conversation: ConversationRecord }>}
	 */
	const append = async (s, c, input, change = {}) => {
		const internal = input.internal === true;
		const visible = !internal;
		const fromVisitor = input.author === 'visitor';
		const bumped = await s.store.conversations.update(c.id, {
			set: {
				...(visible
					? { lastMessageAt: new Date(now()), preview: previewOf(input.text || input.attachment?.name || '') }
					: {}),
				...change.set,
			},
			inc: {
				lastSeq: 1,
				...(fromVisitor ? { visitorMessages: 1, unreadStaff: 1 } : {}),
				...(visible && !fromVisitor ? { unreadVisitor: 1 } : {}),
				...change.inc,
			},
		});
		const conversation = /** @type {ConversationRecord} */ (bumped);
		/** @type {MessageRecord} */
		const message = {
			id: createId('msg'),
			conversationId: c.id,
			seq: conversation.lastSeq,
			author: input.author,
			staffId: input.staffId ?? null,
			name: input.name ?? null,
			text: input.text,
			internal,
			...(input.buttons ? { buttons: input.buttons } : {}),
			attachment: input.attachment ?? null,
			createdAt: new Date(now()),
		};
		await s.store.messages.insert(message);
		return { message, conversation };
	};

	/**
	 * A bot message (flows, handoff, office hours, the AI-unavailable message), signed with the bot name.
	 * @param {Site} s
	 * @param {ConversationRecord} c
	 * @param {string} text
	 * @param {{ buttons?: string[] }} [extra]
	 */
	const botMessage = async (s, c, text, extra = {}) => {
		const { botName } = await s.values('visitor_chat');
		return append(s, c, { author: 'system', text, name: String(botName), ...extra });
	};

	// ------------------------------------------------------------------------------------------------- views

	/**
	 * A link to an attachment for 10 minutes (PDFs as downloads), or null without storage.
	 * @param {Site} s
	 */
	const linker = async (s) => {
		const storage = s.on.includes('attachments') ? await product.connections.storage(s.websiteId) : null;
		return (/** @type {import('../core/conversation.js').Attachment} */ attachment) =>
			storage
				? storage.presignGet({
						key: attachment.key,
						expiresIn: LINK_SECONDS,
						...(attachment.type === 'application/pdf' ? { downloadName: attachment.name } : {}),
					}).url
				: null;
	};

	/**
	 * Office hours now (handoff on), else null.
	 * @param {Site} s
	 */
	const officeHours = async (s) => {
		if (!s.on.includes('handoff')) return null;
		const { officeHours: lines } = await s.values('handoff');
		const { timeZone } = await s.business();
		const state = officeState(parseOfficeHours(lines), now(), timeZone);
		return {
			open: state.open,
			backAt: state.backAt === null ? null : iso(new Date(state.backAt)),
			backAtMs: state.backAt,
			timeZone,
		};
	};

	/**
	 * The office-closed text with the time staff are back.
	 * @param {Site} s
	 * @param {{ backAtMs: number | null, timeZone: string }} hours
	 */
	const closedText = async (s, hours) =>
		(await s.texts())['chat.officeClosed']?.replace(
			'{time}',
			hours.backAtMs === null ? '—' : backAtText(hours.backAtMs, hours.timeZone),
		) ?? '';

	/**
	 * The visitor's view of the chat.
	 * @param {Site} s
	 * @param {Visitor | null} visitor
	 * @param {ConversationRecord | null} c
	 */
	const chatView = async (s, visitor, c) => {
		const receipts = s.on.includes('typing_receipts');
		const guestChat = s.on.includes('guest_chat');
		const limit = visitor?.kind !== 'user' && guestChat ? Number((await s.values('guest_chat')).messageLimit) : 0;
		/** @type {Record<string, unknown> | null} */
		let conversation = null;
		if (c) {
			const hours = await officeHours(s);
			const queue =
				s.on.includes('presence_queue') &&
				(await s.values('presence_queue')).queuePosition &&
				c.waiting &&
				c.assignedTo === null &&
				c.status !== 'resolved'
					? await s.store.conversations.queuePosition(c)
					: null;
			const flow = c.flow ? (await s.list('flows')).find((f) => f.id === c.flow?.id) : null;
			conversation = {
				id: c.id,
				status: c.status,
				waiting: c.waiting,
				unread: c.unreadVisitor,
				aiPending: receipts ? c.aiPending : false,
				staffSeenSeq: receipts ? c.staffSeenSeq : null,
				queuePosition: queue,
				officeHours: hours ? { open: hours.open, backAt: hours.backAt } : null,
				rating: c.rating ? { score: c.rating.score, comment: c.rating.comment } : null,
				ratingRequested: c.ratingRequested,
				flow:
					flow && c.flow ? { id: flow.id, step: waitingView(flow.steps[c.flow.step], await s.list('custom_fields')) } : null,
				contactNeeded: c.waiting && c.visitor.kind === 'guest' && !c.email && !c.phone,
				createdAt: iso(c.createdAt),
				lastMessageAt: iso(c.lastMessageAt),
			};
		}
		return {
			conversation,
			visitor: visitor
				? { kind: visitor.kind, name: c?.name ?? visitor.name, email: visitor.email ?? c?.email ?? null }
				: { kind: 'none', name: null, email: null },
			guestLimit: limit > 0 ? { limit, used: c?.visitorMessages ?? 0 } : null,
			lastSeq: c?.lastSeq ?? 0,
		};
	};

	/**
	 * Messages for the visitor.
	 * @param {Site} s
	 * @param {MessageRecord[]} messages
	 */
	const visitorMessages = async (s, messages) => {
		const urlOf = await linker(s);
		return messages.map((m) => visitorMessageView(m, urlOf));
	};

	/**
	 * Staff's view of a conversation (what their features allow).
	 * @param {Site} s
	 * @param {ConversationRecord} c
	 * @param {{ full?: boolean, staff?: Map<string, string> }} [options]
	 */
	const inboxView = async (s, c, { full = false, staff } = {}) => {
		const names = staff ?? new Map((await s.store.staff.list()).map((m) => [m.id, m.name]));
		return {
			id: c.id,
			visitor: { kind: c.visitor.kind, id: c.visitor.id, name: c.name, email: c.email, phone: c.phone },
			status: c.status,
			waiting: c.waiting,
			aiPaused: c.aiPaused,
			assignedTo: c.assignedTo ? { id: c.assignedTo, name: names.get(c.assignedTo) ?? c.assignedTo } : null,
			unread: c.unreadStaff,
			preview: c.preview,
			lastMessageAt: iso(c.lastMessageAt),
			createdAt: iso(c.createdAt),
			...(s.on.includes('typing_receipts') ? { visitorSeenSeq: c.visitorSeenSeq } : {}),
			...(full
				? {
						fields: c.fields,
						...(s.on.includes('ai_summary') ? { summary: c.summary } : {}),
						...(s.on.includes('ratings')
							? { rating: c.rating ? { score: c.rating.score, comment: c.rating.comment } : null }
							: {}),
						...(s.on.includes('context_panel')
							? {
									context: {
										name: c.name,
										email: c.email,
										phone: c.phone,
										page: c.page,
										device: c.device,
										conversations: await s.store.conversations.countOf(c.visitor),
									},
								}
							: {}),
					}
				: {}),
		};
	};

	/**
	 * Messages for staff (internal notes only with that feature on).
	 * @param {Site} s
	 * @param {MessageRecord[]} messages
	 */
	const staffMessages = async (s, messages) => {
		const urlOf = await linker(s);
		return messages.map((m) => staffMessageView(m, urlOf));
	};

	// ------------------------------------------------------------------------------------------ notifications

	/**
	 * Send one template through Notifications (e-mail).
	 * @param {Site} s
	 * @param {string} template
	 * @param {string} email
	 * @param {Record<string, string | number>} values
	 * @returns {Promise<'sent' | 'not_connected' | 'failed'>}
	 */
	const notify = async (s, template, email, values) => {
		const business = (await s.business()).name;
		const answer = await product.callProduct(s.websiteId, 'notifications', '/v1/messages/email', {
			method: 'POST',
			body: { template, to: { email }, values: { ...values, business } },
		});
		if (!answer.ok) return answer.reason === 'not_connected' ? 'not_connected' : 'failed';
		const status = bodyOf(answer.body).status;
		return status === 'failed' || status === 'skipped' ? 'failed' : 'sent';
	};

	/**
	 * The staff alert recipients plus the assigned person's e-mail.
	 * @param {Site} s
	 * @param {ConversationRecord | null} c
	 */
	const recipients = async (s, c) => {
		const { recipients: list } = await s.values('staff_alerts');
		const assigned = c?.assignedTo ? await s.store.staff.get(c.assignedTo) : null;
		return [...new Set([...list, ...(assigned?.email ? [assigned.email] : [])].map((e) => String(e).toLowerCase()))];
	};

	/**
	 * A staff alert (`new_message`: at most once until staff reply or open it; `needs_you`: on handoff), after the
	 * answer.
	 * @param {Site} s
	 * @param {ConversationRecord} c
	 * @param {'new_message' | 'needs_you'} kind
	 */
	const staffAlert = async (s, c, kind) => {
		if (!s.on.includes('staff_alerts')) return;
		if (kind === 'new_message') {
			const claimed = await s.store.conversations.update(c.id, { set: { alerted: true }, unless: { alerted: false } });
			if (!claimed) return;
		}
		const to = await recipients(s, c);
		if (to.length === 0) return;
		const { inboxUrl } = await s.values('staff_alerts');
		const link = inboxUrl ? `${inboxUrl}${String(inboxUrl).includes('?') ? '&' : '?'}conversation=${c.id}` : '';
		const values = { visitor: c.name ?? c.email ?? c.phone ?? 'Guest', preview: c.preview, link, conversationId: c.id };
		s.ctx.after(async () => {
			for (const email of to) await notify(s, `chat.${kind}`, email, values);
		});
	};

	/**
	 * A transcript by e-mail: the most recent part that fits Notifications' value limit.
	 * @param {Site} s
	 * @param {ConversationRecord} c
	 * @param {string} email
	 */
	const sendTranscript = async (s, c, email) => {
		const texts = await s.texts();
		const { botName } = await s.values('visitor_chat');
		const messages = await s.store.messages.list(c.id, { limit: 500, internal: false });
		const lines = messages.map((m) => {
			const who =
				m.author === 'visitor'
					? texts['transcript.you']
					: m.author === 'staff'
						? (m.name ?? texts['transcript.team'])
						: (m.name ?? botName);
			return `${who}: ${m.text || m.attachment?.name || ''}`;
		});
		let transcript = lines.join('\n');
		if (transcript.length > TRANSCRIPT_MAX) transcript = `…${transcript.slice(-(TRANSCRIPT_MAX - 1))}`;
		const date = iso(c.createdAt)?.slice(0, 10) ?? '';
		const outcome = await notify(s, 'chat.transcript', email, { transcript, date });
		if (outcome === 'not_connected')
			throw problem('notifications_not_connected', 'Notifications not connected: paste its token in Connections.');
		if (outcome === 'failed') throw problem('not_sent', 'The transcript could not be sent. Try again later.');
	};

	// ------------------------------------------------------------------------------------------------ tokens

	/**
	 * Whether an AI cap stops AI replies now (AI token caps on).
	 * @param {Site} s
	 */
	const capped = async (s) => {
		if (!s.on.includes('ai_caps')) return false;
		const { timeZone } = await s.business();
		const keys = windowKeys(now(), timeZone);
		const used = await s.store.usage.get([keys.day, keys.month]);
		const caps = await s.values('ai_caps');
		return capReached(
			{ day: Number(used[keys.day]), month: Number(used[keys.month]) },
			{ dailyTokens: Number(caps.dailyTokens), monthlyTokens: Number(caps.monthlyTokens) },
		);
	};

	/**
	 * Count AI tokens in the day and month windows; one cost alert per month when the share is crossed.
	 * @param {Site} s
	 * @param {number} tokens
	 */
	const spend = async (s, tokens) => {
		if (tokens <= 0) return;
		const { timeZone } = await s.business();
		const keys = windowKeys(now(), timeZone);
		const before = await s.store.usage.add([keys.day, keys.month], tokens);
		if (!s.on.includes('ai_cost_alerts') || !s.on.includes('ai_caps')) return;
		const { monthlyTokens } = await s.values('ai_caps');
		const { alertPercent } = await s.values('ai_cost_alerts');
		const month = Number(before[keys.month]);
		const crossed = alertCrossed({
			before: month,
			after: month + tokens,
			monthlyTokens: Number(monthlyTokens),
			percent: Number(alertPercent),
		});
		if (!crossed || !(await s.store.usage.markAlerted(keys.month))) return;
		const to = await recipients(s, null);
		s.ctx.after(async () => {
			for (const email of to)
				await notify(s, 'chat.cost_alert', email, {
					used: month + tokens,
					cap: Number(monthlyTokens),
					percent: Number(alertPercent),
				});
		});
	};

	/**
	 * Record a staff action in the activity log (copied to Accounts when its token is pasted).
	 * @param {Site} s
	 * @param {Actor} actor
	 * @param {string} action
	 * @param {string} target
	 */
	const log = (s, actor, action, target) =>
		product.activity.record(s.ctx, { actor: { kind: actor.kind, id: actor.id, name: actor.name }, action, target });

	return Object.freeze({
		site,
		visitorOf,
		newGuest,
		append,
		botMessage,
		chatView,
		visitorMessages,
		inboxView,
		staffMessages,
		officeHours,
		closedText,
		notify,
		staffAlert,
		sendTranscript,
		capped,
		spend,
		log,
	});
};

/** @typedef {ReturnType<typeof createService>} Service */
