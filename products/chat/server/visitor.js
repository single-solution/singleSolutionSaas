/**
 * The visitor API (browser token; PLAN 0.8.3 Visitor chat, Guests and signed-in visitors): the chat state and new
 * messages (older ones by sequence, PLAN 0.8.10 C8), sending (with the AI reply in the same request, `?wait=1`, C10),
 * read receipts, ending a chat, asking for a person, guest contact details, leads, flows, ratings, transcripts and
 * attachment uploads. One ongoing conversation per visitor: a message reopens a resolved one. Every message keeps the
 * page it came from as the conversation's current page (C14), and every read marks when the visitor last checked the
 * chat (reply alerts, C6).
 * @module
 */
import { created, noContent, problem } from '@ss/app-kit';
import {
	deviceOf,
	guestLimitReached,
	limitNext,
	messageText,
	pageContext,
	ratingScale,
	statusAfter,
	verifiedIdentity,
} from '../core/conversation.js';
import { checkFieldValue, checkLead } from '../core/fields.js';
import { answerStep, pageFlowMatches } from '../core/flows.js';
import { moderateInbound } from '../core/moderation.js';
import { uploadLimits } from '../core/uploads.js';
import { STAFF_ATTACHMENT_MAX_BYTES, STAFF_ATTACHMENT_TYPES } from '../core/limits.js';
import { EXTENSIONS, MAX_ATTACHMENT_BYTES, PAGE_MAX } from '../core/widgets.js';
import { labelsOf } from './reply.js';
import { bodyOf, invalid, phoneCodeOf } from './service.js';

/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./service.js').Visitor} Visitor */
/** @typedef {import('../core/conversation.js').ConversationRecord} ConversationRecord */

/** A visitor's check is written at most this often (ms; reply alerts, C6). */
const CHECKED_EVERY_MS = 15_000;

/**
 * The paging of a messages read: `after` (newer than a seq), `before` (older than a seq, C8) and `limit` (1–50 with
 * `before`).
 * @param {Record<string, unknown>} query
 * @param {{ latest: number, newer: number }} limits the page without `before` / `after`, and with `after`
 */
export const pagingOf = (query, limits) => {
	const seq = (/** @type {unknown} */ value) => (/^\d{1,9}$/.test(String(value ?? '')) ? Number(value) : null);
	const after = seq(query.after);
	const before = after === null ? seq(query.before) : null;
	const asked = seq(query.limit);
	const limit =
		after !== null
			? limits.newer
			: before !== null
				? Math.max(1, Math.min(PAGE_MAX, asked ?? PAGE_MAX))
				: asked !== null
					? Math.max(1, Math.min(limits.latest, asked))
					: limits.latest;
	return { after, before, limit };
};

/**
 * A new conversation record.
 * @param {Visitor} visitor
 * @param {{ page: import('../core/conversation.js').PageContext | null, device: string, now: number }} input
 * @returns {Omit<ConversationRecord, 'id'>}
 */
const newConversation = (visitor, { page, device, now }) => ({
	visitor: { kind: visitor.kind, id: visitor.id },
	guestIds: [],
	name: visitor.name,
	email: visitor.email,
	phone: visitor.phone,
	status: 'open',
	waiting: false,
	waitingSince: null,
	aiPaused: false,
	aiPending: false,
	aiFailures: 0,
	assignedTo: null,
	lastSeq: 0,
	visitorMessages: 0,
	unreadStaff: 0,
	unreadVisitor: 0,
	visitorSeenSeq: 0,
	staffSeenSeq: 0,
	alerted: false,
	staffReplied: false,
	firstVisitorAt: null,
	firstStaffReplyAt: null,
	aiReplies: 0,
	handedOffAt: null,
	page,
	device,
	fields: {},
	flow: null,
	flowsRun: [],
	tags: [],
	topic: null,
	priority: null,
	summary: null,
	rating: null,
	ratingRequested: false,
	preview: '',
	lastMessageAt: new Date(now),
	createdAt: new Date(now),
});

/**
 * @param {import('../adapters/product.js').Product} product
 * @param {import('./service.js').Service} service
 * @param {import('./reply.js').Reply} reply
 */
export const createVisitorApi = (product, service, reply) => {
	const { now } = product;

	/**
	 * The request's site and visitor (none yet: null).
	 * @param {any} ctx
	 */
	const who = async (ctx) => {
		const s = await service.site(ctx);
		return { s, visitor: await service.visitorOf(s) };
	};

	/**
	 * The visitor, or a new guest for this device (guest chat on), or `sign_in_required`.
	 * @param {Site} s
	 * @param {Visitor | null} visitor
	 * @returns {Promise<{ visitor: Visitor, guestKey: string | null }>}
	 */
	const visitorOrGuest = async (s, visitor) => {
		const look = await s.values('visitor_chat');
		const hasLegacyWho = s.on.includes('guest_chat') || s.on.includes('signed_in_chat');
		const allowGuests = hasLegacyWho ? s.on.includes('guest_chat') : look.allowGuests !== false;
		const allowSignedIn = hasLegacyWho ? s.on.includes('signed_in_chat') : look.allowSignedIn !== false;
		if (visitor && visitor.kind === 'user') {
			if (!allowSignedIn) throw problem('sign_in_required', 'Signed-in chat is not enabled.');
			return { visitor, guestKey: null };
		}
		if (visitor && visitor.kind === 'guest' && allowGuests) return { visitor, guestKey: null };
		if (!allowGuests) throw problem('sign_in_required', 'Sign in to chat.');
		const guest = await service.newGuest(s);
		return { visitor: guest.visitor, guestKey: guest.key };
	};

	/**
	 * The visitor's conversation, made when there is none.
	 * @param {Site} s
	 * @param {Visitor} visitor
	 * @param {unknown} page
	 */
	const conversationOf = async (s, visitor, page) => {
		const found = await s.store.conversations.current(visitor);
		if (found) return found;
		return s.store.conversations.create(
			newConversation(visitor, {
				page: pageContext(page, await s.list('page_types')),
				device: deviceOf(s.ctx.headers.get('user-agent')),
				now: now(),
			}),
		);
	};

	/**
	 * The visitor's existing conversation, else 404.
	 * @param {any} ctx
	 */
	const existing = async (ctx) => {
		const { s, visitor } = await who(ctx);
		const c = visitor ? await s.store.conversations.current(visitor) : null;
		if (!visitor || !c) throw problem('not_found', 'There is no chat yet.');
		return { s, visitor, c };
	};

	/**
	 * The visitor checked the conversation (reply alerts, C6): written at most every 15 s.
	 * @param {Site} s
	 * @param {ConversationRecord} c
	 */
	const checked = async (s, c) => {
		const last = c.visitorCheckedAt ? new Date(c.visitorCheckedAt).getTime() : 0;
		if (now() - last < CHECKED_EVERY_MS) return c;
		return (await s.store.conversations.update(c.id, { set: { visitorCheckedAt: new Date(now()) } })) ?? c;
	};

	/** @param {any} ctx */
	const state = async (ctx) => {
		const paging = pagingOf(ctx.query, { latest: 50, newer: 100 });
		const s = await service.site(ctx);
		// the first read (no paging) may claim guest chats by phone (C7)
		const visitor = await service.visitorOf(s, { claim: paging.after === null && paging.before === null });
		const found = visitor ? await s.store.conversations.current(visitor) : null;
		// a reply that went stale starts again (RT-6)
		const c = found ? await reply.resume(s, await checked(s, found)) : null;
		const messages = c ? await s.store.messages.list(c.id, { ...paging, internal: false }) : [];
		const first = messages[0];
		return {
			...(await service.chatView(s, visitor, c)),
			messages: await service.visitorMessages(s, messages),
			...(paging.after === null
				? { earlier: c && first ? await s.store.messages.earlier(c.id, first.seq, false) : false }
				: {}),
		};
	};

	/** @param {any} ctx */
	const unread = async (ctx) => {
		const { s, visitor } = await who(ctx);
		const c = visitor ? await s.store.conversations.current(visitor) : null;
		return { unread: c?.unreadVisitor ?? 0 };
	};

	/**
	 * A visitor attachment: allowed by the setting, an allowed type and size, uploaded under this website's chat prefix.
	 * @param {Site} s
	 * @param {Visitor} visitor
	 * @param {unknown} raw
	 */
	const visitorAttachment = async (s, visitor, raw) => {
		if (raw === undefined || raw === null) return null;
		const look = await s.values('visitor_chat');
		const attachmentsOn = s.on.includes('attachments') || (look.visitorUploads && look.visitorUploads !== 'off');
		if (!attachmentsOn) throw problem('feature_off', 'Attachments are off.');
		const settings = s.on.includes('attachments')
			? await s.values('attachments')
			: { visitorUploads: look.visitorUploads ?? 'off' };
		if (settings.visitorUploads === 'off' || (settings.visitorUploads === 'signed_in' && visitor.kind !== 'user'))
			throw problem('forbidden', 'Visitors cannot attach files here.');
		const a = bodyOf(raw);
		if (typeof a.key !== 'string' || !a.key.startsWith(`chat/${visitor.kind}-${visitor.id}/`))
			throw invalid(['Upload the file first.']);
		return checkUpload(a, { ...settings, uploadTypes: await s.list('upload_types') });
	};

	/** @param {any} ctx */
	const send = async (ctx) => {
		const body = bodyOf(ctx.body);
		const wait = ctx.query.wait === '1' || ctx.query.wait === 'true';
		let text = messageText(body.text, { allowEmpty: body.attachment !== undefined && body.attachment !== null });
		if (text === null) throw invalid(['Write a message (up to 4000 characters).']);
		const s = await service.site(ctx);
		const known = await service.visitorOf(s, { claim: true });
		const { visitor, guestKey } = await visitorOrGuest(s, known);
		const attachment = await visitorAttachment(s, visitor, body.attachment);
		let c = await conversationOf(s, visitor, body.page);
		const look = await s.values('visitor_chat');
		const hasLegacyWho = s.on.includes('guest_chat') || s.on.includes('signed_in_chat');
		const allowGuests = hasLegacyWho ? s.on.includes('guest_chat') : look.allowGuests !== false;
		const allowSignedIn = hasLegacyWho ? s.on.includes('signed_in_chat') : look.allowSignedIn !== false;
		if (visitor.kind === 'guest' && allowGuests) {
			const guestsSettings = s.on.includes('guest_chat') ? await s.values('guest_chat') : {};
			const effectiveLimit =
				hasLegacyWho && guestsSettings.messageLimit !== undefined ? guestsSettings.messageLimit : (look.messageLimit ?? 5);
			if (guestLimitReached(c, await service.guestLimit(s.websiteId, { messageLimit: effectiveLimit }))) {
				const next = limitNext({
					signedInChat: allowSignedIn,
					signInUrl: (await s.ctx.website()).pages.signIn,
					leads: s.on.includes('leads_flows'),
				});
				throw problem('guest_limit_reached', 'The guest message limit is reached.', { extensions: { next } });
			}
		}
		if (s.on.includes('moderation') && text) {
			const { email, phone } = await s.business();
			const moderated = moderateInbound(text, await service.moderation(s), labelsOf(await s.texts()), {
				email,
				phone,
			});
			if (!moderated.ok) throw problem('message_rejected', 'This message cannot be sent.');
			text = moderated.text;
		}
		const page = body.page ? pageContext(body.page, await s.list('page_types')) : null;
		// what the sign-in vouches for, kept apart from the typed contact details: alerts go only to it (SR-6-3)
		const verified = visitor.kind === 'user' ? verifiedIdentity(await s.signIn()) : null;
		const firstPage = c.visitorMessages === 0 && page ? { page } : {};
		const appended = await service.append(
			s,
			c,
			{ author: 'visitor', text, attachment },
			{
				set: {
					status: statusAfter(c.status, 'visitor'),
					...firstPage,
					...(page ? { currentPage: page } : {}),
					visitorCheckedAt: new Date(now()),
					...(c.firstVisitorAt ? {} : { firstVisitorAt: new Date(now()) }),
					...(visitor.kind === 'user'
						? {
								name: c.name ?? visitor.name,
								email: c.email ?? visitor.email,
								phone: c.phone ?? visitor.phone,
								verifiedEmail: verified?.email ?? null,
								verifiedPhone: verified?.phone ?? null,
							}
						: {}),
				},
			},
		);
		c = await reply.afterVisitorMessage(s, appended.conversation, text, { inline: wait });
		const [message] = await service.visitorMessages(s, [appended.message]);
		// with `?wait=1` the AI reply came within the request: the messages after the visitor's (C10); a reply that needs
		// longer is still pending (`replyPending`) and comes with the next checks (CH-1)
		const replies = wait
			? await service.visitorMessages(
					s,
					await s.store.messages.list(c.id, { after: appended.message.seq, limit: 20, internal: false }),
				)
			: null;
		return created({
			message,
			...(replies ? { replies, replyPending: c.aiPending } : {}),
			...(guestKey ? { guestKey } : {}),
			chat: await service.chatView(s, visitor, c),
		});
	};

	/** @param {any} ctx */
	const read = async (ctx) => {
		const { s, c } = await existing(ctx);
		await s.store.conversations.update(c.id, {
			set: { visitorSeenSeq: c.lastSeq, unreadVisitor: 0, visitorCheckedAt: new Date(now()) },
		});
		return noContent();
	};

	/** @param {any} ctx */
	const end = async (ctx) => {
		const { s, visitor, c } = await existing(ctx);
		const ratings = s.on.includes('ratings') ? await s.values('ratings') : null;
		const ask =
			ratings && !c.rating && (ratings.askWhen === 'on_resolve' || (ratings.askWhen === 'after_staff' && c.staffReplied));
		const updated = await s.store.conversations.update(c.id, {
			set: { status: 'resolved', flow: null, aiPending: false, waiting: false, ...(ask ? { ratingRequested: true } : {}) },
		});
		return { chat: await service.chatView(s, visitor, updated) };
	};

	/** @param {any} ctx */
	const handoff = async (ctx) => {
		const { s, visitor, c } = await existing(ctx);
		return { chat: await service.chatView(s, visitor, await reply.handOff(s, c)) };
	};

	/**
	 * Save contact details on the conversation (and as a lead when lead capture is on).
	 * @param {any} ctx
	 */
	const contact = async (ctx) => {
		const body = bodyOf(ctx.body);
		const { s, visitor: known } = await who(ctx);
		const { visitor, guestKey } = await visitorOrGuest(s, known);
		/** @type {Record<string, string>} */
		const set = {};
		/** @type {string[]} */
		const errors = [];
		for (const [field, type] of /** @type {const} */ ([
			['name', 'text'],
			['email', 'email'],
			['phone', 'phone'],
		])) {
			if (body[field] === undefined || body[field] === '') continue;
			const checked = checkFieldValue(
				{ key: field, label: field, type, options: [] },
				body[field],
				type === 'phone' ? await phoneCodeOf(s) : '',
			);
			if (checked.ok) set[field] = String(checked.value).slice(0, 200);
			else errors.push(`${field} is not valid.`);
		}
		if (errors.length === 0 && !set.email && !set.phone) errors.push('Leave an email address or a phone number.');
		if (errors.length > 0) throw invalid(errors);
		const c = await conversationOf(s, visitor, body.page);
		const updated = await s.store.conversations.update(c.id, { set });
		if (s.on.includes('leads_flows'))
			await s.store.leads.insert({
				conversationId: c.id,
				name: set.name ?? null,
				email: set.email ?? null,
				phone: set.phone ?? null,
				message: null,
				custom: {},
				page: c.page,
			});
		return { ...(guestKey ? { guestKey } : {}), chat: await service.chatView(s, visitor, updated) };
	};

	/** @param {any} ctx */
	const lead = async (ctx) => {
		const { s, visitor: known } = await who(ctx);
		const settings = await s.values('leads_flows');
		const checked = checkLead(ctx.body, {
			fields: settings.leadFields,
			customKeys: s.on.includes('custom_fields') ? settings.customLeadFields : [],
			customFields: s.on.includes('custom_fields') ? await s.list('custom_fields') : [],
			consentRequired: String(settings.consentText).trim().length > 0,
			callingCode: await phoneCodeOf(s),
		});
		if (!checked.ok) throw invalid(checked.errors);
		const c = known ? await s.store.conversations.current(known) : null;
		const v = checked.value;
		if (c && (v.name || v.email || v.phone))
			await s.store.conversations.update(c.id, {
				set: { name: c.name ?? v.name, email: c.email ?? v.email, phone: c.phone ?? v.phone },
			});
		const id = await s.store.leads.insert({
			conversationId: c?.id ?? null,
			name: v.name,
			email: v.email,
			phone: v.phone,
			message: v.message,
			custom: v.custom,
			page: pageContext(bodyOf(ctx.body).page, await s.list('page_types')) ?? c?.page ?? null,
		});
		return created({ lead: { id } });
	};

	/** @param {any} ctx */
	const startFlow = async (ctx) => {
		const body = bodyOf(ctx.body);
		const { s, visitor: known } = await who(ctx);
		const flow = (await s.list('flows')).find((f) => f.id === ctx.params.flowId);
		const page = pageContext(body.page, await s.list('page_types'));
		const path = page?.url ? new URL(page.url).pathname : '';
		if (!flow || !pageFlowMatches(flow, path)) throw problem('not_found', 'No such flow for this page.');
		const { visitor, guestKey } = await visitorOrGuest(s, known);
		let c = await conversationOf(s, visitor, body.page);
		if (!c.flowsRun.includes(flow.id) && !c.flow) c = await reply.startFlow(s, c, flow);
		return created({ ...(guestKey ? { guestKey } : {}), chat: await service.chatView(s, visitor, c) });
	};

	/** @param {any} ctx */
	const answerFlow = async (ctx) => {
		const { s, visitor, c } = await existing(ctx);
		const flow = c.flow ? (await s.list('flows')).find((f) => f.id === c.flow?.id) : null;
		if (!flow || !c.flow) throw problem('conflict', 'No flow is waiting for an answer.');
		const answer = typeof bodyOf(ctx.body).answer === 'string' ? bodyOf(ctx.body).answer.trim().slice(0, 2000) : '';
		const checked = answerStep(flow, c.flow.step, answer, await s.list('custom_fields'), await phoneCodeOf(s));
		if (!checked.ok) throw invalid([String((await s.texts())['chat.flowInvalid'] ?? 'Not valid.')]);
		const contactField = ['name', 'email', 'phone'].includes(checked.key);
		let current = /** @type {ConversationRecord} */ (
			await (
				await service.append(
					s,
					c,
					{ author: 'visitor', text: String(answer) },
					{
						set: contactField ? { [checked.key]: checked.value } : { [`fields.${checked.key}`]: checked.value },
					},
				)
			).conversation
		);
		if (contactField && s.on.includes('leads_flows') && checked.key !== 'name')
			await s.store.leads.insert({
				conversationId: c.id,
				name: current.name,
				email: current.email,
				phone: current.phone,
				message: null,
				custom: {},
				page: current.page,
			});
		current = await reply.runFlow(s, current, flow, c.flow.step + 1);
		return { chat: await service.chatView(s, visitor, current) };
	};

	/** @param {any} ctx */
	const rate = async (ctx) => {
		const { s, visitor } = await who(ctx);
		const look = await s.values('visitor_chat');
		const ratingsOn = s.on.includes('ratings') || look.ratingsEnabled === true;
		if (!ratingsOn) throw problem('feature_off', 'Ratings are off.');
		const c = visitor ? await s.store.conversations.current(visitor) : null;
		if (!visitor || !c) throw problem('not_found', 'There is no chat yet.');
		const body = bodyOf(ctx.body);
		const settings = s.on.includes('ratings')
			? await s.values('ratings')
			: {
					kind: look.ratingKind ?? 'csat',
					labels: look.ratingLabels ?? ['1', '2', '3', '4', '5'],
					askWhen: look.ratingAskWhen ?? 'on_resolve',
					askComment: look.ratingAskComment !== false,
				};
		const scale = ratingScale(settings);
		const score = Number(body.score);
		if (!Number.isInteger(score) || score < scale.min || score > scale.max)
			throw invalid([`Rate from ${scale.min} to ${scale.max}.`]);
		const { askComment } = settings;
		const comment =
			askComment && typeof body.comment === 'string' && body.comment.trim() ? body.comment.trim().slice(0, 1000) : null;
		const updated = await s.store.conversations.update(c.id, {
			set: { rating: { kind: scale.kind, score, comment, at: new Date(now()) }, ratingRequested: false },
		});
		return { chat: await service.chatView(s, visitor, updated) };
	};

	/** @param {any} ctx */
	const transcript = async (ctx) => {
		const { s, visitor } = await who(ctx);
		const look = await s.values('visitor_chat');
		const transcriptsOn = s.on.includes('transcripts') || look.emailTranscripts !== false;
		if (!transcriptsOn) throw problem('feature_off', 'Transcripts are not enabled.');
		const c = visitor ? await s.store.conversations.current(visitor) : null;
		if (!visitor || !c) throw problem('not_found', 'There is no chat yet.');
		// only to the email Accounts verified for the signed-in visitor: an address typed in the chat proves nothing, and
		// there is no step that confirms one (SR-6-2)
		if (visitor.kind !== 'user') throw problem('sign_in_required', 'Sign in to get the transcript by email.');
		const email = verifiedIdentity(await s.signIn())?.email;
		if (!email) throw problem('forbidden', 'The transcript goes only to an email address your account has verified.');
		const typed = bodyOf(ctx.body).email;
		if (typed !== undefined && typed !== '') {
			const checked = checkFieldValue({ key: 'email', label: 'email', type: 'email', options: [] }, typed);
			if (!checked.ok) throw invalid(['Enter an email address.']);
			if (String(checked.value).toLowerCase() !== email.toLowerCase())
				throw invalid(['The transcript goes only to the email address of your account.']);
		}
		await service.sendTranscript(s, c, email);
		return new Response(JSON.stringify({ sent: true }), { status: 202, headers: { 'content-type': 'application/json' } });
	};

	/** @param {any} ctx */
	const upload = async (ctx) => {
		const { s, visitor: known } = await who(ctx);
		const look = await s.values('visitor_chat');
		const attachmentsOn = s.on.includes('attachments') || (look.visitorUploads && look.visitorUploads !== 'off');
		if (!attachmentsOn) throw problem('feature_off', 'Attachments are off.');
		const { visitor, guestKey } = await visitorOrGuest(s, known);
		const settings = s.on.includes('attachments')
			? await s.values('attachments')
			: { visitorUploads: look.visitorUploads ?? 'off' };
		if (settings.visitorUploads === 'off' || (settings.visitorUploads === 'signed_in' && visitor.kind !== 'user'))
			throw problem('forbidden', 'Visitors cannot attach files here.');
		return {
			...(await presign(product, s, `chat/${visitor.kind}-${visitor.id}`, ctx.body, {
				...settings,
				uploadTypes: await s.list('upload_types'),
			})),
			...(guestKey ? { guestKey } : {}),
		};
	};

	return Object.freeze({
		state,
		unread,
		send,
		read,
		end,
		handoff,
		contact,
		lead,
		startFlow,
		answerFlow,
		rate,
		transcript,
		upload,
	});
};

/**
 * What a file may be: the visitor rules (C11: the merchant's upload types, each with its own cap, at most 100 MB), or
 * the staff rules (C12: the fixed staff types and size).
 * @param {Record<string, any>} settings the attachment settings, with the list `uploadTypes` for visitors
 * @param {'visitor' | 'staff'} who
 * @returns {{ types: string[], max: number, limits: Record<string, number> }}
 */
export const uploadRules = (settings, who) => {
	if (who === 'staff') {
		const types = [...STAFF_ATTACHMENT_TYPES];
		const max = STAFF_ATTACHMENT_MAX_BYTES;
		return { types, max, limits: Object.fromEntries(types.map((type) => [type, max])) };
	}
	const rules = uploadLimits(Array.isArray(settings.uploadTypes) ? settings.uploadTypes : []);
	return { ...rules, max: Math.min(rules.max, MAX_ATTACHMENT_BYTES) };
};

/**
 * Check a file's name, type and size against the attachment settings.
 * @param {Record<string, unknown>} a
 * @param {Record<string, any>} settings
 * @param {'visitor' | 'staff'} [who]
 */
export const checkUpload = (a, settings, who = 'visitor') => {
	const { types: allowed, limits } = uploadRules(settings, who);
	const name = typeof a.name === 'string' ? a.name.replace(/[\\/\r\n"]/g, '_').slice(0, 120) : '';
	if (!name || typeof a.type !== 'string' || !allowed.includes(a.type))
		throw invalid([`Allowed types: ${allowed.join(', ') || 'none'}.`]);
	// each type's own cap (C11)
	const max = limits[a.type] ?? 0;
	if (!Number.isInteger(a.size) || Number(a.size) <= 0 || Number(a.size) > max)
		throw invalid([`The largest ${a.type} file is ${Math.round(max / 1024 / 1024)} MB.`]);
	return { key: typeof a.key === 'string' ? a.key : '', name, type: a.type, size: Number(a.size) };
};

/**
 * A presigned upload into the merchant's storage that fixes the type and size; Chat keeps only the object key.
 * @param {import('../adapters/product.js').Product} product
 * @param {Site} s
 * @param {string} folder
 * @param {unknown} body
 * @param {Record<string, any>} settings
 * @param {'visitor' | 'staff'} [who]
 */
export const presign = async (product, s, folder, body, settings, who = 'visitor') => {
	const storage = await product.connections.storage(s.websiteId);
	if (!storage) throw problem('storage_not_connected', 'Storage not connected: connect it in the product dashboard.');
	const file = checkUpload({ ...bodyOf(body), key: '' }, settings, who);
	const extension = EXTENSIONS[/** @type {keyof typeof EXTENSIONS} */ (file.type)];
	const key = `${folder}/${crypto.randomUUID()}.${extension}`;
	const signed = storage.presignPut({ key, contentType: file.type, contentLength: file.size, expiresIn: 300 });
	return {
		upload: { method: signed.method, url: signed.url, headers: signed.headers },
		attachment: { key, name: file.name, type: file.type, size: file.size },
	};
};
