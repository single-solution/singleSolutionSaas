/**
 * The visitor API (browser token; PLAN 0.8.3 Visitor chat, Guests and signed-in visitors): the chat state and new
 * messages, sending, read receipts, ending a chat, asking for a person, guest contact details, leads, flows, ratings,
 * transcripts and attachment uploads. One ongoing conversation per visitor: a message reopens a resolved one.
 * @module
 */
import { created, noContent, problem } from '@ss/app-kit';
import { deviceOf, guestLimitReached, limitNext, messageText, pageContext, statusAfter } from '../core/conversation.js';
import { checkFieldValue, checkLead } from '../core/fields.js';
import { answerStep, pageFlowMatches } from '../core/flows.js';
import { moderateInbound } from '../core/moderation.js';
import { ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES } from '../core/widgets.js';
import { labelsOf } from './reply.js';
import { bodyOf, invalid } from './service.js';

/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./service.js').Visitor} Visitor */
/** @typedef {import('../core/conversation.js').ConversationRecord} ConversationRecord */

/**
 * A new conversation record.
 * @param {Visitor} visitor
 * @param {{ page: import('../core/conversation.js').PageContext | null, device: string, now: number }} input
 * @returns {Omit<ConversationRecord, 'id'>}
 */
export const newConversation = (visitor, { page, device, now }) => ({
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
		if (visitor && (visitor.kind === 'user' || s.on.includes('guest_chat'))) return { visitor, guestKey: null };
		if (!s.on.includes('guest_chat')) throw problem('sign_in_required', 'Sign in to chat.');
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
			newConversation(visitor, { page: pageContext(page), device: deviceOf(s.ctx.headers.get('user-agent')), now: now() }),
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

	/** @param {any} ctx */
	const state = async (ctx) => {
		const { s, visitor } = await who(ctx);
		const c = visitor ? await s.store.conversations.current(visitor) : null;
		const after = /^\d{1,9}$/.test(String(ctx.query.after ?? '')) ? Number(ctx.query.after) : null;
		const messages = c ? await s.store.messages.list(c.id, { after, limit: after === null ? 50 : 100, internal: false }) : [];
		return { ...(await service.chatView(s, visitor, c)), messages: await service.visitorMessages(s, messages) };
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
		if (!s.on.includes('attachments')) throw problem('feature_off', 'Attachments are off.');
		const settings = await s.values('attachments');
		if (settings.visitorUploads === 'off' || (settings.visitorUploads === 'signed_in' && visitor.kind !== 'user'))
			throw problem('forbidden', 'Visitors cannot attach files here.');
		const a = bodyOf(raw);
		if (typeof a.key !== 'string' || !a.key.startsWith(`chat/${visitor.kind}-${visitor.id}/`))
			throw invalid(['Upload the file first.']);
		return checkUpload(a, settings);
	};

	/** @param {any} ctx */
	const send = async (ctx) => {
		const body = bodyOf(ctx.body);
		let text = messageText(body.text, { allowEmpty: body.attachment !== undefined && body.attachment !== null });
		if (text === null) throw invalid(['Write a message (up to 4000 characters).']);
		const { s, visitor: known } = await who(ctx);
		const { visitor, guestKey } = await visitorOrGuest(s, known);
		const attachment = await visitorAttachment(s, visitor, body.attachment);
		let c = await conversationOf(s, visitor, body.page);
		if (visitor.kind === 'guest' && s.on.includes('guest_chat')) {
			const { messageLimit } = await s.values('guest_chat');
			if (guestLimitReached(c, Number(messageLimit))) {
				const next = limitNext({
					signedInChat: s.on.includes('signed_in_chat'),
					signInUrl: String((await s.values('signed_in_chat')).signInUrl),
					leads: s.on.includes('leads_flows'),
				});
				throw problem('guest_limit_reached', 'The guest message limit is reached.', { extensions: { next } });
			}
		}
		if (s.on.includes('moderation') && text) {
			const moderated = moderateInbound(text, /** @type {any} */ (await s.values('moderation')), labelsOf(await s.texts()));
			if (!moderated.ok) throw problem('message_rejected', 'This message cannot be sent.');
			text = moderated.text;
		}
		const firstPage = c.visitorMessages === 0 && body.page ? { page: pageContext(body.page) } : {};
		const appended = await service.append(
			s,
			c,
			{ author: 'visitor', text, attachment },
			{
				set: {
					status: statusAfter(c.status, 'visitor'),
					...firstPage,
					...(c.firstVisitorAt ? {} : { firstVisitorAt: new Date(now()) }),
					...(visitor.kind === 'user'
						? { name: c.name ?? visitor.name, email: c.email ?? visitor.email, phone: c.phone ?? visitor.phone }
						: {}),
				},
			},
		);
		c = await reply.afterVisitorMessage(s, appended.conversation, text);
		const [message] = await service.visitorMessages(s, [appended.message]);
		return created({ message, ...(guestKey ? { guestKey } : {}), chat: await service.chatView(s, visitor, c) });
	};

	/** @param {any} ctx */
	const read = async (ctx) => {
		const { s, c } = await existing(ctx);
		await s.store.conversations.update(c.id, { set: { visitorSeenSeq: c.lastSeq, unreadVisitor: 0 } });
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
			const checked = checkFieldValue({ key: field, label: field, type, options: [] }, body[field]);
			if (checked.ok) set[field] = String(checked.value).slice(0, 200);
			else errors.push(`${field} is not valid.`);
		}
		if (errors.length === 0 && !set.email && !set.phone) errors.push('Leave an e-mail address or a phone number.');
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
			page: pageContext(bodyOf(ctx.body).page) ?? c?.page ?? null,
		});
		return created({ lead: { id } });
	};

	/** @param {any} ctx */
	const startFlow = async (ctx) => {
		const body = bodyOf(ctx.body);
		const { s, visitor: known } = await who(ctx);
		const flow = (await s.list('flows')).find((f) => f.id === ctx.params.flowId);
		const page = pageContext(body.page);
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
		const checked = answerStep(flow, c.flow.step, answer, await s.list('custom_fields'));
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
		const { s, visitor, c } = await existing(ctx);
		const body = bodyOf(ctx.body);
		const { scale, askComment } = await s.values('ratings');
		const score = Number(body.score);
		if (!Number.isInteger(score) || score < 1 || score > Number(scale)) throw invalid([`Rate from 1 to ${scale}.`]);
		const comment =
			askComment && typeof body.comment === 'string' && body.comment.trim() ? body.comment.trim().slice(0, 1000) : null;
		const updated = await s.store.conversations.update(c.id, {
			set: { rating: { score, comment, at: new Date(now()) }, ratingRequested: false },
		});
		return { chat: await service.chatView(s, visitor, updated) };
	};

	/** @param {any} ctx */
	const transcript = async (ctx) => {
		const { s, c } = await existing(ctx);
		const checked = checkFieldValue({ key: 'email', label: 'email', type: 'email', options: [] }, bodyOf(ctx.body).email);
		if (!checked.ok) throw invalid(['Enter an e-mail address.']);
		await service.sendTranscript(s, c, String(checked.value));
		return new Response(JSON.stringify({ sent: true }), { status: 202, headers: { 'content-type': 'application/json' } });
	};

	/** @param {any} ctx */
	const upload = async (ctx) => {
		const { s, visitor: known } = await who(ctx);
		const { visitor, guestKey } = await visitorOrGuest(s, known);
		const settings = await s.values('attachments');
		if (settings.visitorUploads === 'off' || (settings.visitorUploads === 'signed_in' && visitor.kind !== 'user'))
			throw problem('forbidden', 'Visitors cannot attach files here.');
		return {
			...(await presign(product, s, `chat/${visitor.kind}-${visitor.id}`, ctx.body, settings)),
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
 * Check a file's name, type and size against the attachment settings.
 * @param {Record<string, unknown>} a
 * @param {Record<string, any>} settings
 */
export const checkUpload = (a, settings) => {
	const allowed = ATTACHMENT_TYPES.filter((type) => settings.allowedTypes.includes(type));
	const max = Math.min(Number(settings.maxSizeMb) * 1024 * 1024, MAX_ATTACHMENT_BYTES);
	const name = typeof a.name === 'string' ? a.name.replace(/[\\/\r\n"]/g, '_').slice(0, 120) : '';
	if (!name || typeof a.type !== 'string' || !allowed.includes(a.type))
		throw invalid([`Allowed types: ${allowed.join(', ') || 'none'}.`]);
	if (!Number.isInteger(a.size) || Number(a.size) <= 0 || Number(a.size) > max)
		throw invalid([`The largest file is ${Math.round(max / 1024 / 1024)} MB.`]);
	return { key: typeof a.key === 'string' ? a.key : '', name, type: a.type, size: Number(a.size) };
};

/**
 * A presigned upload into the merchant's storage that fixes the type and size; Chat keeps only the object key.
 * @param {import('../adapters/product.js').Product} product
 * @param {Site} s
 * @param {string} folder
 * @param {unknown} body
 * @param {Record<string, any>} settings
 */
export const presign = async (product, s, folder, body, settings) => {
	const storage = await product.connections.storage(s.websiteId);
	if (!storage) throw problem('storage_not_connected', 'Storage not connected: connect it in the product dashboard.');
	const file = checkUpload({ ...bodyOf(body), key: '' }, settings);
	const extension = {
		'image/jpeg': 'jpg',
		'image/png': 'png',
		'image/webp': 'webp',
		'image/gif': 'gif',
		'application/pdf': 'pdf',
	}[file.type];
	const key = `${folder}/${crypto.randomUUID()}.${extension}`;
	const signed = storage.presignPut({ key, contentType: file.type, contentLength: file.size, expiresIn: 300 });
	return {
		upload: { method: signed.method, url: signed.url, headers: signed.headers },
		attachment: { key, name: file.name, type: file.type, size: file.size },
	};
};
