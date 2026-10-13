/**
 * The machinery behind Chat's routes (PLAN 0.8.3):
 *
 * - `site(ctx)`: the website of a request (merchant database store, switched-on features, settings and texts read
 *   once per request).
 * - `visitorOf(site)`: who is chatting — the Accounts user of a sign-in verified on this request (signed-in chat on),
 *   else the guest of the device's guest key (any key of 16–128 characters, so imported store cookies work); a device
 *   showing both moves the guest's chats to the account, merged by time into the account's own conversation when it has
 *   one, and with "claim by phone" guest chats whose captured phone is the verified phone move too (PLAN 0.8.10 C7).
 * - Views of a conversation for the visitor and for staff, attachment links, the queue position and office hours; the
 *   context panel's shop info from Ecommerce (pasted token) for a signed-in visitor.
 * - Messages through Notifications (pasted token): staff alerts and AI cost alerts through the kit's staff alerts (K6:
 *   e-mail, WhatsApp or SMS, C5), transcripts, and reply alerts to a visitor who left the chat (C6).
 * - AI token counts per day and month window, the caps and the monthly cost alert.
 * @module
 */
import { problem } from '@ss/app-kit';
import { createId } from '@ss/contracts';
import { capReached, windowKeys, alertCrossed } from '../core/caps.js';
import { customerOrdersPath, shopInfoOf } from '../core/shop.js';
import { excerptOf, iso, pendingStale, previewOf, staffMessageView, visitorMessageView } from '../core/conversation.js';
import { waitingView } from '../core/flows.js';
import { officeState, parseOfficeHours } from '../core/handoff.js';
import { zoneOr } from '../core/time.js';
import { plainOf } from '../core/markdown.js';
import { GUEST_HEADER, GUEST_KEY, SIGN_IN_HEADER } from '../core/widgets.js';
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
 * @property {() => Promise<Look>} format the website's Format and business time zone, with the formatters of text the
 *   server makes (K7)
 * @property {(name: import('../adapters/lists.js').ListName) => Promise<any[]>} list
 * @property {() => Promise<SignIn | null>} signIn the visitor's Accounts sign-in, verified on this request (signed-in chat on)
 */
/**
 * @typedef {{ token: string, user: { id: string, name?: string, email?: string, phone?: string } }} SignIn
 */
/** @typedef {Awaited<ReturnType<Product['format']>>} Look */
/**
 * @typedef {{ kind: 'user', id: string, name: string | null, email: string | null, phone: string | null }
 *   | { kind: 'guest', id: string, name: null, email: null, phone: null }} Visitor
 */
/** @typedef {{ kind: string, id: string, name: string, role?: string, email?: string }} Actor */

/** How long an attachment link lasts (seconds). */
const LINK_SECONDS = 600;
/** Presence: someone whose inbox has not checked in for this long is Offline. */
export const PRESENCE_MS = 5 * 60_000;
/** The window of the new-guest limit per network address (CH-15). */
const NEW_GUESTS_WINDOW_MS = 15 * 60_000;
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
			format: () => once('format', () => product.format(websiteId)),
			list: (name) => once(`l:${name}`, () => product.lists.get(websiteId, name)),
			signIn: () =>
				once('signIn', async () => {
					const token = ctx.headers.get(SIGN_IN_HEADER);
					if (!token || !on.includes('signed_in_chat')) return null;
					const verified = await product.accounts.verify({ websiteId, token });
					return verified.ok ? { token, user: verified.user } : null;
				}),
		};
	};

	// ------------------------------------------------------------------------------------------------- visitors

	/**
	 * Move a guest's conversations to an account: merged by time into the account's latest conversation when it has
	 * one, else moved as they are (C7); the name, e-mail and phone they lack come from the sign-in at once (CH-7).
	 * @param {Site} s
	 * @param {ConversationRecord[]} guestConversations
	 * @param {Visitor & { kind: 'user' }} user
	 */
	const claim = async (s, guestConversations, user) => {
		if (guestConversations.length === 0) return;
		const contact = { name: user.name, email: user.email, phone: user.phone };
		const own = await s.store.conversations.current({ kind: 'user', id: user.id });
		if (own) await s.store.conversations.merge(own, guestConversations, contact);
		else
			for (const guestId of new Set(guestConversations.map((c) => c.visitor.id)))
				await s.store.conversations.moveGuest(guestId, user.id, contact);
	};

	/**
	 * Who is chatting. A sign-in that does not verify counts as no sign-in (the visitor may still chat as a guest).
	 * `claim`: also move guest chats whose captured phone is the verified phone (claim by phone on; the first read and
	 * sends, not every check).
	 * @param {Site} s
	 * @param {{ claim?: boolean }} [options]
	 * @returns {Promise<Visitor | null>}
	 */
	const visitorOf = async (s, { claim: byPhone = false } = {}) => {
		const signIn = await s.signIn();
		/** @type {(Visitor & { kind: 'user' }) | null} */
		const user = signIn
			? {
					kind: 'user',
					id: signIn.user.id,
					name: signIn.user.name ?? null,
					email: signIn.user.email ?? null,
					phone: signIn.user.phone ?? null,
				}
			: null;
		const key = s.ctx.headers.get(GUEST_HEADER);
		const guest = key && GUEST_KEY.test(key) ? await s.store.guests.byKey(sha256(key)) : null;
		if (user && guest) await claim(s, await s.store.conversations.ofGuest(guest.id), user);
		if (user && byPhone && user.phone && (await s.values('signed_in_chat')).claimByPhone)
			await claim(s, await s.store.conversations.guestsByPhone(user.phone), user);
		if (user) return user;
		return guest ? { kind: 'guest', id: guest.id, name: null, email: null, phone: null } : null;
	};

	/**
	 * A new guest for this device: the key is answered once and kept only as a hash. At most `newGuestsPerNetwork` new
	 * guests per network address in 15 minutes, so a client that drops its key cannot start a new guest, conversation
	 * and AI reply with every message (CH-15).
	 * @param {Site} s
	 */
	const newGuest = async (s) => {
		const { rememberDays, newGuestsPerNetwork } = await s.values('guest_chat');
		const limit = Number(newGuestsPerNetwork ?? 0);
		const ip = String(s.ctx.clientIp ?? 'unknown');
		if (limit > 0 && ip !== 'unknown') {
			const { count } = await product.counters.hit(`chat-guest|${s.websiteId}|${ip}`, NEW_GUESTS_WINDOW_MS, now());
			if (count > limit) throw problem('rate_limited', 'Too many new chats from this network. Try again in a few minutes.');
		}
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
	 *   buttons?: string[], attachment?: import('../core/conversation.js').Attachment | null,
	 *   cards?: import('../core/shop.js').ProductCard[], format?: 'text' | 'markdown' }} input
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
					? {
							lastMessageAt: new Date(now()),
							preview: previewOf(
								(input.format === 'markdown' ? plainOf(input.text) : input.text) || input.attachment?.name || '',
							),
						}
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
			...(input.format === 'markdown' ? { format: 'markdown' } : {}),
			internal,
			...(input.buttons ? { buttons: input.buttons } : {}),
			...(input.cards && input.cards.length > 0 ? { cards: input.cards } : {}),
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
	 * A link to an attachment for 10 minutes (images open; PDFs and staff files are downloads), or null without storage.
	 * @param {Site} s
	 */
	const linker = async (s) => {
		const storage = s.on.includes('attachments') ? await product.connections.storage(s.websiteId) : null;
		return (/** @type {import('../core/conversation.js').Attachment} */ attachment) =>
			storage
				? storage.presignGet({
						key: attachment.key,
						expiresIn: LINK_SECONDS,
						...(attachment.type.startsWith('image/') ? {} : { downloadName: attachment.name }),
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
	 * The office-closed text with the time staff are back, in the website's Format and business time zone.
	 * @param {Site} s
	 * @param {{ backAtMs: number | null }} hours
	 */
	const closedText = async (s, hours) => {
		const time = hours.backAtMs === null ? '—' : (await s.format()).date(hours.backAtMs, 'datetime');
		return (await s.texts())['chat.officeClosed']?.replace('{time}', time) ?? '';
	};

	/**
	 * The visitor's view of the chat.
	 * @param {Site} s
	 * @param {Visitor | null} visitor
	 * @param {ConversationRecord | null} c
	 */
	const chatView = async (s, visitor, c) => {
		const receipts = s.on.includes('typing_receipts') ? await s.values('typing_receipts') : null;
		const { showPaused } = await s.values('visitor_chat');
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
				aiPending: receipts?.showTyping ? c.aiPending && !pendingStale(c, now()) : false,
				staffSeenSeq: receipts?.showSeen ? c.staffSeenSeq : null,
				paused: showPaused === true && c.aiPaused === true && c.status !== 'resolved',
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
			guestMessagesLeft: limit > 0 ? Math.max(0, limit - (c?.visitorMessages ?? 0)) : null,
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
		const cards = s.on.includes('product_cards');
		return messages.map((m) => visitorMessageView(m, urlOf, { cards }));
	};

	/**
	 * Staff's view of a conversation (what their features allow).
	 * @param {Site} s
	 * @param {ConversationRecord} c
	 * @param {{ full?: boolean, staff?: Map<string, string> }} [options]
	 */
	const inboxView = async (s, c, { full = false, staff } = {}) => {
		const names = staff ?? new Map((await s.store.staff.list()).map((m) => [m.id, m.name]));
		const seen = s.on.includes('typing_receipts') && (await s.values('typing_receipts')).showSeen;
		const single = s.on.includes('internal_notes') && (await s.values('internal_notes')).mode === 'single';
		return {
			id: c.id,
			visitor: { kind: c.visitor.kind, id: c.visitor.id, name: c.name, email: c.email, phone: c.phone },
			status: c.status,
			waiting: c.waiting,
			aiPaused: c.aiPaused,
			...(c.aiPaused
				? {
						aiPausedBy: c.aiPausedBy ?? null,
						aiPausedAt: iso(c.aiPausedAt ?? null),
						aiPausedReason: c.aiPausedReason ?? null,
					}
				: {}),
			assignedTo: c.assignedTo ? { id: c.assignedTo, name: names.get(c.assignedTo) ?? c.assignedTo } : null,
			unread: c.unreadStaff,
			preview: c.preview,
			lastMessageAt: iso(c.lastMessageAt),
			createdAt: iso(c.createdAt),
			...(seen ? { visitorSeenSeq: c.visitorSeenSeq } : {}),
			handedOffAt: iso(c.handedOffAt),
			waitingSince: iso(c.waitingSince),
			...(full
				? {
						fields: c.fields,
						...(single ? { note: c.note ?? '' } : {}),
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
										currentPage: c.currentPage ?? null,
										device: c.device,
										conversations: await s.store.conversations.countOf(c.visitor),
										shop: await shopInfo(s, c),
									},
								}
							: {}),
					}
				: {}),
		};
	};

	/**
	 * The context panel's shop info: the signed-in visitor's last orders and loyalty points from Ecommerce (pasted
	 * token); null for a guest, without the token, or when Ecommerce cannot answer.
	 * @param {Site} s
	 * @param {ConversationRecord} c
	 * @returns {Promise<import('../core/shop.js').ShopInfo | null>}
	 */
	const shopInfo = async (s, c) => {
		if (c.visitor.kind !== 'user') return null;
		const answer = await product.callProduct(s.websiteId, 'ecommerce', customerOrdersPath(c.visitor.id));
		return answer.ok ? shopInfoOf(answer.body, await s.format()) : null;
	};

	/**
	 * Messages for staff (internal notes only with that feature on).
	 * @param {Site} s
	 * @param {MessageRecord[]} messages
	 */
	const staffMessages = async (s, messages) => {
		const urlOf = await linker(s);
		const cards = s.on.includes('product_cards');
		return messages.map((m) => staffMessageView(m, urlOf, { cards }));
	};

	// ------------------------------------------------------------------------------------------ notifications

	/**
	 * Send one template through Notifications.
	 * @param {Site} s
	 * @param {string} template
	 * @param {{ email: string } | { phone: string }} to e-mail, or WhatsApp to a phone
	 * @param {Record<string, string | number>} values
	 * @returns {Promise<'sent' | 'not_connected' | 'failed'>}
	 */
	const notify = async (s, template, to, values) => {
		const business = (await s.business()).name;
		const channel = 'phone' in to ? 'whatsapp' : 'email';
		const answer = await product.callProduct(s.websiteId, 'notifications', `/v1/messages/${channel}`, {
			method: 'POST',
			body: { template, to, values: { ...values, business } },
		});
		if (!answer.ok) return answer.reason === 'not_connected' ? 'not_connected' : 'failed';
		const status = bodyOf(answer.body).status;
		return status === 'failed' || status === 'skipped' ? 'failed' : 'sent';
	};

	/**
	 * The link of an alert: the Inbox address setting with the conversation id.
	 * @param {Site} s
	 * @param {string} conversationId
	 */
	const inboxLink = async (s, conversationId) => {
		const { inboxUrl } = await s.values('staff_alerts');
		return inboxUrl ? `${inboxUrl}${String(inboxUrl).includes('?') ? '&' : '?'}conversation=${conversationId}` : '';
	};

	/**
	 * A staff alert through the kit's staff alerts (K6; the recipients setting with e-mail addresses and phones, Accounts
	 * staff with the permission setting, and the assigned person): `new_message` on a visitor message — with frequency
	 * `first_unanswered` at most once until staff reply or open it, with `every_message` every time — and `needs_you`
	 * on handoff. Besides the short `preview`, the values carry the visitor's `name` and latest `message` (up to 500
	 * characters with its line breaks), and their `phone` with the setting `includePhone` (CH-9). Sent after the answer.
	 * @param {Site} s
	 * @param {ConversationRecord} c
	 * @param {'new_message' | 'needs_you'} kind
	 */
	const staffAlert = async (s, c, kind) => {
		if (!s.on.includes('staff_alerts')) return;
		const settings = await s.values('staff_alerts');
		if (kind === 'new_message' && settings.frequency !== 'every_message') {
			const claimed = await s.store.conversations.update(c.id, { set: { alerted: true }, unless: { alerted: false } });
			if (!claimed) return;
		}
		const assigned = c.assignedTo ? await s.store.staff.get(c.assignedTo) : null;
		const recent = await s.store.messages.list(c.id, { limit: 20, internal: false });
		const latest = [...recent].reverse().find((m) => m.author === 'visitor');
		await product.staffAlerts.send(s.ctx, {
			feature: 'staff_alerts',
			event: kind,
			values: {
				visitor: c.name ?? c.email ?? c.phone ?? 'Guest',
				name: c.name ?? '',
				...(settings.includePhone === true ? { phone: c.phone ?? '' } : {}),
				preview: c.preview,
				message: excerptOf(latest ? latest.text || latest.attachment?.name || '' : ''),
				link: await inboxLink(s, c.id),
				conversationId: c.id,
				business: (await s.business()).name,
			},
			assignee: assigned?.email ? { email: assigned.email } : null,
		});
	};

	/**
	 * A reply alert to the visitor (C6, reply alerts on): when staff reply to a visitor with a phone or e-mail who has
	 * not checked the conversation for the away time, `chat.staff_reply` goes by WhatsApp to the phone, else by e-mail;
	 * once until the visitor checks again. Sent after the answer.
	 * @param {Site} s
	 * @param {ConversationRecord} c the conversation after the reply
	 * @param {{ staff: string, text: string }} reply
	 */
	const visitorAlert = async (s, c, reply) => {
		if (!s.on.includes('visitor_alerts') || (!c.phone && !c.email)) return;
		const { awaySeconds } = await s.values('visitor_alerts');
		const checked = c.visitorCheckedAt ? new Date(c.visitorCheckedAt).getTime() : 0;
		if (now() - checked < Number(awaySeconds) * 1000) return;
		if (c.visitorAlertedAt && new Date(c.visitorAlertedAt).getTime() >= checked) return;
		const claimed = await s.store.conversations.update(c.id, {
			set: { visitorAlertedAt: new Date(now()) },
			unless: { visitorAlertedAt: c.visitorAlertedAt ?? null },
		});
		if (!claimed) return;
		/** @type {{ email: string } | { phone: string }} */
		const to = c.phone ? { phone: c.phone } : { email: /** @type {string} */ (c.email) };
		const values = {
			name: c.name ?? '',
			staff: reply.staff,
			preview: previewOf(plainOf(reply.text)),
			link: c.currentPage?.url || c.page?.url || '',
		};
		s.ctx.after(() => notify(s, 'chat.staff_reply', to, values));
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
			return `${who}: ${(m.format === 'markdown' ? plainOf(m.text) : m.text) || m.attachment?.name || ''}`;
		});
		let transcript = lines.join('\n');
		if (transcript.length > TRANSCRIPT_MAX) transcript = `…${transcript.slice(-(TRANSCRIPT_MAX - 1))}`;
		const date = (await s.format()).date(c.createdAt, 'date');
		const outcome = await notify(s, 'chat.transcript', { email }, { transcript, date });
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
		await product.staffAlerts.send(s.ctx, {
			feature: 'staff_alerts',
			event: 'cost_alert',
			values: {
				used: month + tokens,
				cap: Number(monthlyTokens),
				percent: Number(alertPercent),
				business: (await s.business()).name,
			},
		});
	};

	/**
	 * Record a staff action in the activity log (copied to Accounts when its token is pasted): who (with the acting
	 * user's role), what, on what, its label (a name or title) and a short detail, never message contents.
	 * @param {Site} s
	 * @param {Actor} actor
	 * @param {string} action
	 * @param {string} target
	 * @param {{ label?: string, detail?: string }} [about]
	 */
	const log = (s, actor, action, target, { label, detail } = {}) =>
		product.activity.record(s.ctx, {
			actor: { kind: actor.kind, id: actor.id, name: actor.name, ...(actor.role ? { role: actor.role } : {}) },
			action,
			target,
			...(label ? { label } : {}),
			...(detail ? { detail } : {}),
		});

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
		visitorAlert,
		sendTranscript,
		capped,
		spend,
		log,
	});
};

/** @typedef {ReturnType<typeof createService>} Service */
