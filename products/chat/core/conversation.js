/**
 * Conversations and messages (pure): the statuses Open, Awaiting visitor and Resolved with their moves, the guest
 * message limit, the page a chat started on, the channels of a reply alert, and the views each audience gets (visitors
 * never see internal notes, staff ids or the AI pause; staff see everything their features allow).
 * @module
 */
import { cardsOf } from './shop.js';
import { truncate } from './text.js';
import { MAX_MESSAGE_LENGTH, PAGE_KINDS } from './widgets.js';

export const STATUSES = Object.freeze(/** @type {const} */ (['open', 'awaiting_visitor', 'resolved']));
/** @typedef {(typeof STATUSES)[number]} Status */
/** @typedef {'visitor' | 'ai' | 'staff' | 'system'} Author */

/** @typedef {{ url: string, title: string, kind: string, productId: string | null, productName: string | null }} PageContext */
/** @typedef {{ key: string, name: string, type: string, size: number }} Attachment */
/**
 * @typedef {object} MessageRecord
 * @property {string} id
 * @property {string} conversationId
 * @property {number} seq
 * @property {Author} author
 * @property {string | null} staffId
 * @property {string | null} name staff name (or the bot name for AI replies)
 * @property {string} text
 * @property {'text' | 'markdown'} [format] how the text is written (C2: AI and staff messages are markdown; missing =
 *   text)
 * @property {boolean} internal an internal note
 * @property {string[]} [buttons] a flow question's buttons
 * @property {Attachment | null} attachment
 * @property {import('./shop.js').ProductCard[]} [cards] product cards under an AI answer (product cards)
 * @property {Date} createdAt
 */
/**
 * @typedef {object} ConversationRecord
 * @property {string} id
 * @property {{ kind: 'guest' | 'user', id: string }} visitor
 * @property {string[]} guestIds guests whose chats moved into this one (data rights)
 * @property {string | null} name
 * @property {string | null} email
 * @property {string | null} phone
 * @property {Status} status
 * @property {boolean} waiting waiting for a person (after handoff)
 * @property {Date | null} waitingSince
 * @property {boolean} aiPaused
 * @property {boolean} aiPending an AI reply is being prepared
 * @property {Date | null} [aiPendingSince] when the pending AI reply started (stale after `PENDING_STALE_MS`, RT-6)
 * @property {boolean} [aiRetried] the pending AI reply is the retry of one that went stale
 * @property {number} aiFailures AI failures in a row
 * @property {string | null} assignedTo staff id
 * @property {number} lastSeq
 * @property {number} visitorMessages
 * @property {number} unreadStaff visitor messages no staff member has opened
 * @property {number} unreadVisitor replies the visitor has not seen
 * @property {number} visitorSeenSeq
 * @property {number} staffSeenSeq
 * @property {boolean} alerted a new-message alert went out since staff last replied or opened it
 * @property {boolean} staffReplied
 * @property {Date | null} firstVisitorAt
 * @property {Date | null} firstStaffReplyAt
 * @property {number} aiReplies
 * @property {Date | null} handedOffAt
 * @property {PageContext | null} page the page the chat started on
 * @property {PageContext | null} [currentPage] the page of the visitor's latest message (C14)
 * @property {string} device
 * @property {Date | null} [visitorCheckedAt] the visitor's widget last read the conversation (C6)
 * @property {Date | null} [visitorAlertedAt] a reply alert went to the visitor (C6)
 * @property {{ kind: string, id: string, name: string } | null} [aiPausedBy] who paused the AI (C11)
 * @property {Date | null} [aiPausedAt]
 * @property {string | null} [aiPausedReason]
 * @property {string | null} [note] the single note (C11, notes mode `single`)
 * @property {boolean} [pendingHandoff] the AI answers the message that asked for a person first (C4)
 * @property {Record<string, string | number | boolean>} fields custom field values and flow answers
 * @property {{ id: string, step: number } | null} flow the running flow
 * @property {string[]} flowsRun
 * @property {string | null} summary
 * @property {{ score: number, comment: string | null, at: Date } | null} rating
 * @property {boolean} ratingRequested
 * @property {string} preview the last message, short
 * @property {Date} lastMessageAt
 * @property {Date} createdAt
 */

/**
 * The status after a message: a visitor message reopens a resolved conversation; a staff reply moves an open one to
 * Awaiting visitor. AI replies change nothing.
 * @param {Status} current
 * @param {Author} author
 * @returns {Status}
 */
export const statusAfter = (current, author) => {
	if (author === 'visitor' && current === 'resolved') return 'open';
	if (author === 'staff' && current === 'open') return 'awaiting_visitor';
	return current;
};

/**
 * How long an AI reply may stay pending (ms): longer than any answer can take (its 45 s deadline, then a provider call
 * already running, main and backup). A reply still pending after it was cut short (the function stopped) or failed
 * (RT-6): it shows no typing, and the visitor's next check starts it again once.
 */
const PENDING_STALE_MS = 2 * 60_000;

/**
 * Whether a conversation's pending AI reply went stale (judged when read).
 * @param {{ aiPending: boolean, aiPendingSince?: Date | null }} c
 * @param {number} now
 */
export const pendingStale = (c, now) =>
	c.aiPending && now - (c.aiPendingSince ? new Date(c.aiPendingSince).getTime() : 0) > PENDING_STALE_MS;

/**
 * Whether a guest has used the messages of the guest limit (0 = no limit).
 * @param {{ visitorMessages: number } | null} conversation
 * @param {number} limit
 */
export const guestLimitReached = (conversation, limit) => limit > 0 && (conversation?.visitorMessages ?? 0) >= limit;

/** @typedef {'email' | 'sms' | 'whatsapp'} AlertChannel */

/**
 * Where a reply alert (C6) may go, in the merchant's order (the setting "Channels, in order"): each channel once, with
 * the visitor's address on it (an email address for email, a phone for SMS and WhatsApp); a channel the visitor has
 * no address for is left out.
 * @param {unknown} channels the setting's value
 * @param {{ email?: string | null, phone?: string | null }} contact
 * @returns {Array<{ channel: AlertChannel, to: { email: string } | { phone: string } }>}
 */
export const alertRoutes = (channels, { email, phone }) => {
	/** @type {Array<{ channel: AlertChannel, to: { email: string } | { phone: string } }>} */
	const routes = [];
	for (const channel of new Set(Array.isArray(channels) ? channels : [])) {
		if (channel === 'email' && email) routes.push({ channel, to: { email } });
		else if ((channel === 'sms' || channel === 'whatsapp') && phone) routes.push({ channel, to: { phone } });
	}
	return routes;
};

/**
 * What a guest at the limit is offered: sign in (signed-in chat on and a sign-in page), leave contact (lead capture
 * on), else nothing.
 * @param {{ signedInChat: boolean, signInUrl: string, leads: boolean }} input
 * @returns {'sign_in' | 'lead' | 'none'}
 */
export const limitNext = ({ signedInChat, signInUrl, leads }) => {
	if (signedInChat && signInUrl) return 'sign_in';
	return leads ? 'lead' : 'none';
};

/**
 * A message text: trimmed, 1–`MAX_MESSAGE_LENGTH` characters (an attachment may come without text).
 * @param {unknown} value
 * @param {{ allowEmpty?: boolean }} [options]
 * @returns {string | null}
 */
export const messageText = (value, { allowEmpty = false } = {}) => {
	if (value === undefined && allowEmpty) return '';
	if (typeof value !== 'string') return null;
	const text = value.trim();
	if (text.length === 0) return allowEmpty ? '' : null;
	return [...text].length <= MAX_MESSAGE_LENGTH ? text : null;
};

/** @param {unknown} value @param {number} max */
const short = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);

/**
 * The page a visitor message came from (`SSChat.setPage` or the URL and title); unknown fields are dropped.
 * @param {unknown} raw
 * @returns {PageContext | null}
 */
export const pageContext = (raw) => {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
	const page = /** @type {Record<string, unknown>} */ (raw);
	const url = short(page.url, 500);
	return {
		url: url && /^https?:\/\//.test(url) ? url : '',
		title: short(page.title, 200) ?? '',
		kind: PAGE_KINDS.includes(/** @type {any} */ (page.kind)) ? String(page.kind) : 'other',
		productId: short(page.productId, 100),
		productName: short(page.productName, 200),
	};
};

/**
 * A short device description from the User-Agent (context panel).
 * @param {string | null} userAgent
 */
export const deviceOf = (userAgent) => {
	const ua = userAgent ?? '';
	const kind = /iPad|Tablet/i.test(ua) ? 'Tablet' : /Mobi|Android|iPhone/i.test(ua) ? 'Phone' : 'Computer';
	const browser = /Edg\//.test(ua)
		? 'Edge'
		: /Firefox\//.test(ua)
			? 'Firefox'
			: /Chrome\//.test(ua)
				? 'Chrome'
				: /Safari\//.test(ua)
					? 'Safari'
					: 'Browser';
	return `${kind} · ${browser}`;
};

/** @param {Date | null | undefined} date */
const iso = (date) => (date ? new Date(date).toISOString() : null);

/**
 * A message as the visitor sees it (never internal notes: callers filter them out). Product cards only while that
 * feature is on. An attachment says whether it opens in the browser (`inline`: images, and PDFs with `pdfInline`,
 * CH-8) or is a download.
 * @param {MessageRecord} m
 * @param {(attachment: Attachment) => string | null} urlOf
 * @param {{ cards?: boolean, pdfInline?: boolean }} [options]
 */
export const visitorMessageView = (m, urlOf, { cards = false, pdfInline = false } = {}) => ({
	id: m.id,
	seq: m.seq,
	author: m.author,
	name: m.author === 'visitor' ? null : m.name,
	text: m.text,
	format: m.format === 'markdown' ? 'markdown' : 'text',
	...(m.buttons && m.buttons.length > 0 ? { buttons: m.buttons } : {}),
	...(m.attachment
		? {
				attachment: {
					name: m.attachment.name,
					type: m.attachment.type,
					size: m.attachment.size,
					url: urlOf(m.attachment),
					inline: m.attachment.type.startsWith('image/') || (pdfInline && m.attachment.type === 'application/pdf'),
				},
			}
		: {}),
	...(cards && m.cards && m.cards.length > 0 ? { cards: cardsOf(m.cards) } : {}),
	createdAt: iso(m.createdAt),
});

/**
 * A message as staff see it: a staff message also carries who wrote it (`staffId`: the ticket's user, the acting user
 * of a server call, or `server` for the team).
 * @param {MessageRecord} m
 * @param {(attachment: Attachment) => string | null} urlOf
 * @param {{ cards?: boolean, pdfInline?: boolean }} [options]
 */
export const staffMessageView = (m, urlOf, options = {}) => ({
	...visitorMessageView(m, urlOf, options),
	name: m.author === 'visitor' ? null : m.name,
	...(m.author === 'staff' ? { staffId: m.staffId ?? null } : {}),
	internal: m.internal,
});

/**
 * A message for alerts (CH-9): up to `max` characters with its line breaks (more than one empty line becomes one).
 * @param {string} text
 * @param {number} [max]
 */
export const excerptOf = (text, max = 500) =>
	truncate(
		text
			.replace(/\r\n?/g, '\n')
			.replace(/[ \t]+\n/g, '\n')
			.replace(/\n{3,}/g, '\n\n')
			.trim(),
		max,
	);

/**
 * The first characters of a message for lists and alerts.
 * @param {string} text
 * @param {number} [max]
 */
export const previewOf = (text, max = 140) => {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export { iso };
