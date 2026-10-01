/**
 * Conversations and messages (pure): statuses and their transitions, message validation, guest limits, the
 * denormalised summary moved with every message, polling cursors / ETags, merge by id, and the public views for the
 * two audiences (customer: never internal notes or agent ids; team: everything). Ported from the ibrahimMobiles chat
 * types, inquiry status rules, guest limits, message pagination and poll helpers; messages live in their own
 * collection, never embedded.
 * @module
 */
import { truncate } from './text.js';

export const STATUSES = Object.freeze(/** @type {const} */ (['open', 'pending', 'snoozed', 'resolved', 'closed']));
export const AUTHORS = Object.freeze(/** @type {const} */ (['customer', 'bot', 'agent', 'system']));
export const PRIORITIES = Object.freeze(/** @type {const} */ (['low', 'normal', 'high', 'urgent']));
export const MESSAGE_KINDS = Object.freeze(/** @type {const} */ (['text', 'buttons', 'form', 'csat', 'event', 'note']));

/** @typedef {(typeof STATUSES)[number]} Status */
/** @typedef {(typeof AUTHORS)[number]} Author */
/**
 * @typedef {object} Conversation
 * @property {string} id
 * @property {Status} status
 * @property {string} channel
 * @property {string | null} customerId verified customer (website identity or sk_), null for guests
 * @property {string | null} visitorId guest visitor (marker token), null when identified only
 * @property {{ name: string | null, email: string | null, phone: string | null } | null} contact
 * @property {string} language
 * @property {string | null} subject
 * @property {string | null} assignee agent id
 * @property {string | null} team
 * @property {string} priority
 * @property {string[]} tags
 * @property {{ paused: boolean, reason: string | null, pausedAt: string | null, failures: number }} ai
 * @property {{ at: string, reason: string, team: string | null, offline: boolean } | null} handoff
 * @property {{ firstResponseDueAt: string | null, firstResponseAt: string | null, resolutionDueAt: string | null, breached: string[] } | null} sla
 * @property {{ messages: number, customer: number, unreadByCustomer: number, unreadByTeam: number }} counts
 * @property {{ at: string, author: Author, preview: string }} last
 * @property {number} tokens AI tokens used
 * @property {number} toolCalls
 * @property {import('./flows.js').FlowState | null} flow
 * @property {{ askedAt: string | null, score: number | null, comment: string | null, ratedAt: string | null } | null} csat
 * @property {{ page?: { url?: string, path?: string, title?: string }, referrer?: string } | null} context
 * @property {string | null} snoozedUntil
 * @property {string | null} resolvedAt
 * @property {string | null} closedAt
 * @property {string} openedAt
 * @property {Record<string, unknown>} [custom]
 * @property {number} version
 */
/**
 * @typedef {object} Message
 * @property {string} id
 * @property {string} conversationId
 * @property {string | null} customerId
 * @property {Author} author
 * @property {string | null} authorId
 * @property {string | null} authorName
 * @property {string} kind
 * @property {boolean} internal
 * @property {string} body
 * @property {Record<string, unknown> | null} payload buttons / form fields / csat scale
 * @property {string | null} language
 * @property {string} at ISO instant (ordering: at, id)
 */

/**
 * New conversation.
 * @param {{ id: string, at: string, customerId: string | null, visitorId: string | null, language: string,
 *   priority: string, context?: Conversation['context'], subject?: string | null, contact?: Conversation['contact'],
 *   custom?: Record<string, unknown> }} input
 * @returns {Conversation}
 */
export const newConversation = ({
	id,
	at,
	customerId,
	visitorId,
	language,
	priority,
	context = null,
	subject = null,
	contact = null,
	custom,
}) => ({
	id,
	status: 'open',
	channel: 'web',
	customerId,
	visitorId,
	contact,
	language,
	subject,
	assignee: null,
	team: null,
	priority,
	tags: [],
	ai: { paused: false, reason: null, pausedAt: null, failures: 0 },
	handoff: null,
	sla: null,
	counts: { messages: 0, customer: 0, unreadByCustomer: 0, unreadByTeam: 0 },
	last: { at, author: 'system', preview: '' },
	tokens: 0,
	toolCalls: 0,
	flow: null,
	csat: null,
	context,
	snoozedUntil: null,
	resolvedAt: null,
	closedAt: null,
	openedAt: at,
	...(custom ? { custom } : {}),
	version: 1,
});

/**
 * Status after a message, as in the ibrahimMobiles inbox: a customer message reopens a resolved, pending or snoozed
 * conversation; a team (agent) message moves an open one to pending (awaiting the customer). Bot messages keep it.
 * Closed conversations never move (a new conversation is started instead).
 * @param {Status} current
 * @param {Author} author
 * @returns {Status}
 */
export const statusAfter = (current, author) => {
	if (current === 'closed') return current;
	if (author === 'customer') return current === 'open' ? current : 'open';
	if (author === 'agent') return current === 'open' ? 'pending' : current;
	return current;
};

/** Allowed manual transitions (dashboard / API). */
const TRANSITIONS = Object.freeze({
	open: ['pending', 'snoozed', 'resolved', 'closed'],
	pending: ['open', 'snoozed', 'resolved', 'closed'],
	snoozed: ['open', 'pending', 'resolved', 'closed'],
	resolved: ['open', 'closed'],
	closed: [],
});

/**
 * @param {Status} from
 * @param {string} to
 */
export const canTransition = (from, to) => from === to || /** @type {readonly string[]} */ (TRANSITIONS[from]).includes(to);

/**
 * Summary fields moved together with appended messages.
 * @param {Conversation} conversation
 * @param {Message[]} messages appended (oldest first)
 * @returns {Pick<Conversation, 'status' | 'counts' | 'last'> & { firstResponseAt?: string }}
 */
export const summaryAfter = (conversation, messages) => {
	let status = conversation.status;
	const counts = { ...conversation.counts };
	let last = conversation.last;
	/** @type {string | undefined} */
	let firstResponseAt;
	for (const message of messages) {
		if (message.internal) continue;
		status = statusAfter(status, message.author);
		counts.messages += 1;
		if (message.author === 'customer') {
			counts.customer += 1;
			counts.unreadByTeam += 1;
		} else if (message.author === 'agent' || message.author === 'bot') {
			counts.unreadByCustomer += 1;
			if (message.author === 'agent') counts.unreadByTeam = 0;
			if (message.author === 'agent' && !conversation.sla?.firstResponseAt && conversation.handoff)
				firstResponseAt = message.at;
		}
		last = { at: message.at, author: message.author, preview: truncate(message.body.replace(/\s+/g, ' '), 140) };
	}
	return { status, counts, last, ...(firstResponseAt ? { firstResponseAt } : {}) };
};

/**
 * Validate a customer or agent message body.
 * @param {unknown} body
 * @param {{ maxLength: number }} options
 * @returns {{ ok: true, text: string } | { ok: false, problems: Array<{ path: string, code: string }> }}
 */
export const validateText = (body, { maxLength }) => {
	if (typeof body !== 'string') return { ok: false, problems: [{ path: '/text', code: 'required' }] };
	const text = body.replace(/\r\n?/g, '\n').trim();
	if (!text) return { ok: false, problems: [{ path: '/text', code: 'empty' }] };
	if ([...text].length > maxLength) return { ok: false, problems: [{ path: '/text', code: 'too_long' }] };
	// control characters other than newline and tab are refused
	if (
		[...text].some((ch) => {
			const code = ch.charCodeAt(0);
			return (code < 0x20 && ch !== '\n' && ch !== '\t') || code === 0x7f;
		})
	)
		return { ok: false, problems: [{ path: '/text', code: 'invalid_characters' }] };
	return { ok: true, text };
};

/**
 * Guests must sign in after `limit` messages (0 = no limit); identified customers never.
 * @param {Conversation} conversation
 * @param {number} limit
 */
export const guestLimitReached = (conversation, limit) =>
	limit > 0 && !conversation.customerId && conversation.counts.customer >= limit;

/**
 * Page context from untrusted client input: only a path, an https/http URL and a title, sanitised and capped.
 * @param {unknown} raw
 * @returns {Conversation['context']}
 */
export const sanitiseContext = (raw) => {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const r = /** @type {Record<string, any>} */ (raw);
	const page = r.page && typeof r.page === 'object' ? r.page : {};
	/** @type {{ url?: string, path?: string, title?: string }} */
	const out = {};
	if (typeof page.url === 'string' && /^https?:\/\//i.test(page.url) && page.url.length <= 2048) out.url = page.url;
	if (typeof page.path === 'string' && page.path.startsWith('/') && page.path.length <= 1024) out.path = page.path;
	else if (out.url) {
		try {
			out.path = new URL(out.url).pathname;
		} catch {
			// keep without a path
		}
	}
	if (typeof page.title === 'string') out.title = truncate(page.title.replace(/\s+/g, ' ').trim(), 200);
	const referrer =
		typeof r.referrer === 'string' && /^https?:\/\//i.test(r.referrer) && r.referrer.length <= 2048 ? r.referrer : undefined;
	return Object.keys(out).length > 0 || referrer
		? { ...(Object.keys(out).length > 0 ? { page: out } : {}), ...(referrer ? { referrer } : {}) }
		: null;
};

/**
 * Weak ETag of a conversation's message stream (changes with every visible message, read state and status).
 * @param {Conversation} conversation
 * @param {'customer' | 'team'} audience
 */
export const streamEtag = (conversation, audience) =>
	`W/"${conversation.last.at}.${conversation.counts.messages}.${conversation.status}.${audience === 'team' ? conversation.counts.unreadByTeam : conversation.counts.unreadByCustomer}.${conversation.ai.paused ? 1 : 0}"`;

/**
 * Merge message lists by id, ordered by (at, id) — the client-side merge of polls and older pages.
 * @template {{ id: string, at: string }} T
 * @param {readonly T[]} existing
 * @param {readonly T[]} incoming
 * @returns {T[]}
 */
export const mergeMessages = (existing, incoming) => {
	const byId = new Map(existing.map((m) => [m.id, m]));
	for (const m of incoming) byId.set(m.id, m);
	return [...byId.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
};

/**
 * Message as an audience sees it (null = hidden from that audience).
 * @param {Message} message
 * @param {'customer' | 'team'} audience
 */
export const messageView = (message, audience) => {
	if (audience === 'customer' && message.internal) return null;
	return {
		id: message.id,
		conversationId: message.conversationId,
		author: message.author,
		authorName: message.authorName ?? null,
		...(audience === 'team' ? { authorId: message.authorId ?? null, internal: message.internal } : {}),
		kind: message.kind,
		text: message.body,
		...(message.payload ? { payload: message.payload } : {}),
		...(message.language ? { language: message.language } : {}),
		at: message.at,
	};
};

/**
 * Conversation as an audience sees it.
 * @param {Conversation} c
 * @param {'customer' | 'team'} audience
 * @param {{ guestLimit?: number }} [options]
 */
export const conversationView = (c, audience, { guestLimit = 0 } = {}) => {
	const base = {
		id: c.id,
		status: c.status,
		channel: c.channel,
		language: c.language,
		subject: c.subject,
		lastMessageAt: c.last.at,
		lastMessagePreview: c.last.preview,
		lastMessageAuthor: c.last.author,
		messageCount: c.counts.messages,
		humanRequested: Boolean(c.handoff),
		aiPaused: c.ai.paused,
		csat: c.csat ? { asked: Boolean(c.csat.askedAt), score: c.csat.score } : null,
		openedAt: c.openedAt,
		closedAt: c.closedAt,
	};
	if (audience === 'customer')
		return {
			...base,
			unread: c.counts.unreadByCustomer,
			identified: Boolean(c.customerId),
			guestLimitReached: guestLimitReached(c, guestLimit),
		};
	return {
		...base,
		customerId: c.customerId,
		visitorId: c.visitorId,
		contact: c.contact,
		assignee: c.assignee,
		team: c.team,
		priority: c.priority,
		tags: c.tags,
		unreadByTeam: c.counts.unreadByTeam,
		unreadByCustomer: c.counts.unreadByCustomer,
		customerMessages: c.counts.customer,
		ai: c.ai,
		handoff: c.handoff,
		sla: c.sla,
		tokens: c.tokens,
		toolCalls: c.toolCalls,
		flow: c.flow ? { flowId: c.flow.flowId, node: c.flow.node, waiting: c.flow.waiting } : null,
		csat: c.csat,
		context: c.context,
		snoozedUntil: c.snoozedUntil,
		resolvedAt: c.resolvedAt,
		...(c.custom ? { custom: c.custom } : {}),
	};
};

/**
 * Validate a team-side patch `{ status, assignee, team, priority, tags, snoozedUntil, aiPaused, subject, custom }`.
 * @param {unknown} body
 * @param {{ allowedTags: string[], teams: string[], snoozeMaxMs: number, now: number }} options
 * @returns {Array<{ path: string, code: string }>}
 */
export const validatePatch = (body, { allowedTags, teams, snoozeMaxMs, now }) => {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return [{ path: '', code: 'object_required' }];
	const b = /** @type {Record<string, any>} */ (body);
	/** @type {Array<{ path: string, code: string }>} */
	const problems = [];
	const known = ['status', 'assignee', 'team', 'priority', 'tags', 'snoozedUntil', 'aiPaused', 'subject', 'custom'];
	for (const key of Object.keys(b)) if (!known.includes(key)) problems.push({ path: `/${key}`, code: 'unknown_field' });
	if (b.status !== undefined && !STATUSES.includes(b.status)) problems.push({ path: '/status', code: 'invalid' });
	if (b.assignee !== undefined && b.assignee !== null && (typeof b.assignee !== 'string' || b.assignee.length > 64))
		problems.push({ path: '/assignee', code: 'invalid' });
	if (b.team !== undefined && b.team !== null && !teams.includes(b.team)) problems.push({ path: '/team', code: 'unknown_team' });
	if (b.priority !== undefined && !PRIORITIES.includes(b.priority)) problems.push({ path: '/priority', code: 'invalid' });
	if (b.tags !== undefined) {
		if (!Array.isArray(b.tags) || b.tags.length > 50 || b.tags.some((t) => typeof t !== 'string' || !t || t.length > 40))
			problems.push({ path: '/tags', code: 'invalid' });
		else if (allowedTags.length > 0 && b.tags.some((t) => !allowedTags.includes(t)))
			problems.push({ path: '/tags', code: 'unknown_tag' });
	}
	if (b.status === 'snoozed' || b.snoozedUntil !== undefined) {
		const until = Date.parse(String(b.snoozedUntil ?? ''));
		if (b.status === 'snoozed' && Number.isNaN(until)) problems.push({ path: '/snoozedUntil', code: 'required' });
		else if (!Number.isNaN(until) && (until <= now || until - now > snoozeMaxMs))
			problems.push({ path: '/snoozedUntil', code: 'out_of_range' });
	}
	if (b.aiPaused !== undefined && typeof b.aiPaused !== 'boolean') problems.push({ path: '/aiPaused', code: 'invalid' });
	if (b.subject !== undefined && b.subject !== null && (typeof b.subject !== 'string' || b.subject.length > 200))
		problems.push({ path: '/subject', code: 'invalid' });
	if (
		b.custom !== undefined &&
		(typeof b.custom !== 'object' || b.custom === null || Array.isArray(b.custom) || JSON.stringify(b.custom).length > 8000)
	)
		problems.push({ path: '/custom', code: 'invalid' });
	return problems;
};
