/**
 * The inbox (PLAN 0.8.3 Inbox, staff and assignment): admin widget routes with a ticket (`/v1/admin/*`, the staff
 * member is the ticket's user) and the same work for the merchant's server with the server token (`/v1/*`, acting for
 * the member of staff its `SS-Actor-*` headers name, else as the team, PLAN 0.8.10 K2). Filters, search, counts,
 * unread counts, replies and attachments, internal notes, status, AI pause, assignment with presence and max chats,
 * custom field values, the AI summary, transcripts, rating requests, saved replies and the staff list. Staff actions
 * are written to the activity log with a label (the visitor's name, a title) and a short detail, never message
 * contents.
 * @module
 */
import { actorOf as kitActorOf, countHandlers, created, noContent, paginate, problem } from '@ss/app-kit';
import { STATUSES, messageText, statusAfter } from '../core/conversation.js';
import { checkFieldValue } from '../core/fields.js';
import { checkUpload, presign } from './visitor.js';
import { PRESENCE_MS, bodyOf, invalid } from './service.js';

/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./service.js').Actor} Actor */
/** @typedef {import('../core/conversation.js').ConversationRecord} ConversationRecord */

const PRESENCES = Object.freeze(['online', 'away', 'offline']);
const MAX_SAVED_REPLIES = 200;

/** The merchant's server when no member of staff is named: the team. */
const TEAM = Object.freeze({ kind: 'server', id: 'server', name: 'Team' });

/**
 * Who acts: the ticket's staff member, else the member of staff a server-token call names with `SS-Actor-*` headers
 * (K2), else the merchant's server (the team).
 * @param {any} ctx
 * @returns {Actor}
 */
export const actorOf = (ctx) => {
	const actor = kitActorOf(ctx, TEAM);
	return { ...actor, name: actor.name ?? TEAM.name };
};

/**
 * The activity label of a conversation: the visitor's name, never their message.
 * @param {ConversationRecord} c
 */
export const conversationLabel = (c) => c.name || (c.visitor.kind === 'guest' ? 'Guest' : 'Signed-in visitor');

/**
 * @param {import('../adapters/product.js').Product} product
 * @param {import('./service.js').Service} service
 * @param {import('./reply.js').Reply} reply
 */
export const createInbox = (product, service, reply) => {
	const { now } = product;

	/**
	 * A conversation of the website, else 404.
	 * @param {any} ctx
	 */
	const found = async (ctx) => {
		const s = await service.site(ctx);
		const c = await s.store.conversations.get(String(ctx.params.id));
		if (!c) throw problem('not_found', 'No such conversation.');
		return { s, c, actor: actorOf(ctx) };
	};

	/**
	 * A feature an action needs besides the route's own.
	 * @param {Site} s
	 * @param {string} feature
	 */
	const needs = (s, feature) => {
		if (!s.on.includes(feature)) throw problem('feature_off', `This needs the ${feature} feature.`);
	};

	/**
	 * The inbox list's filter of a request, shared by the list and its counts: status, waiting for a person, visitor
	 * kind, assignment (`unassigned`, or `me`: the ticket's user or the acting user) and the search text. Values that
	 * do not fit are ignored, as the list always did.
	 * @param {any} ctx
	 * @param {Site} s
	 */
	const whereOf = (ctx, s) => {
		/** @type {Record<string, unknown>} */
		const filter = {};
		if (STATUSES.includes(ctx.query.status)) filter.status = ctx.query.status;
		if (ctx.query.waiting === '1') filter.waiting = true;
		if (ctx.query.visitor === 'guest' || ctx.query.visitor === 'user') filter['visitor.kind'] = ctx.query.visitor;
		if (s.on.includes('assignment') && ctx.query.assigned === 'unassigned') filter.assignedTo = null;
		if (s.on.includes('assignment') && ctx.query.assigned === 'me') filter.assignedTo = actorOf(ctx).id;
		const q = typeof ctx.query.q === 'string' && ctx.query.q.trim() ? ctx.query.q.trim().slice(0, 100) : null;
		return s.store.conversations.where({ filter, q });
	};

	/** @param {any} ctx */
	const list = async (ctx) => {
		const s = await service.site(ctx);
		const actor = actorOf(ctx);
		// the inbox of a member of staff is open: a ticket's user, or the acting user of a server call
		if (actor.kind !== TEAM.kind) await s.store.staff.checkIn(actor);
		const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url }, { defaultLimit: 25 });
		const after = /** @type {[string, string] | null} */ (page.after);
		const rows = await s.store.conversations.list({ where: await whereOf(ctx, s), after, limit: page.fetchLimit });
		const staff = new Map((await s.store.staff.list()).map((m) => [m.id, m.name]));
		const items = await Promise.all(rows.map((c) => service.inboxView(s, c, { staff })));
		const answer = page.page(items, (c) => [/** @type {string} */ (c.lastMessageAt), c.id]);
		return { ...answer, unread: await s.store.conversations.unread() };
	};

	/**
	 * `GET …/conversations/count` and `…/counts?by=` (K4): the list's own filter; `waiting`, `guest` (the visitor is a
	 * guest) and `unread` (visitor messages no staff member opened) answer `true` / `false`.
	 */
	const counts = countHandlers({
		source: async (ctx) => {
			const s = await service.site(ctx);
			return { collection: (await ctx.data()).collection('conversations'), filter: await whereOf(ctx, s) };
		},
		by: {
			status: 'status',
			waiting: { path: 'waiting', map: (value) => String(value === true) },
			guest: { path: 'visitor.kind', map: (value) => String(value === 'guest') },
			unread: { path: 'unreadStaff', map: (value) => String(Number(value) > 0) },
		},
	});

	/** @param {any} ctx */
	const get = async (ctx) => {
		const { s, c } = await found(ctx);
		const after = /^\d{1,9}$/.test(String(ctx.query.after ?? '')) ? Number(ctx.query.after) : null;
		const messages = await s.store.messages.list(c.id, {
			after,
			limit: after === null ? 100 : 200,
			internal: s.on.includes('internal_notes'),
		});
		return { conversation: await service.inboxView(s, c, { full: true }), messages: await service.staffMessages(s, messages) };
	};

	/** @param {any} ctx */
	const read = async (ctx) => {
		const { s, c } = await found(ctx);
		await s.store.conversations.update(c.id, { set: { staffSeenSeq: c.lastSeq, unreadStaff: 0, alerted: false } });
		return noContent();
	};

	/** @param {any} ctx */
	const replyTo = async (ctx) => {
		const { s, c, actor } = await found(ctx);
		const body = bodyOf(ctx.body);
		/** @type {import('../core/conversation.js').Attachment | null} */
		let attachment = null;
		if (body.attachment !== undefined && body.attachment !== null) {
			needs(s, 'attachments');
			const a = bodyOf(body.attachment);
			if (typeof a.key !== 'string' || !a.key.startsWith('chat/staff/')) throw invalid(['Upload the file first.']);
			attachment = checkUpload(a, await s.values('attachments'));
		}
		const text = messageText(body.text, { allowEmpty: attachment !== null });
		if (text === null) throw invalid(['Write a reply (up to 4000 characters).']);
		const { message, conversation } = await service.append(
			s,
			c,
			{ author: 'staff', text, name: actor.name, staffId: actor.id, attachment },
			{
				set: {
					status: statusAfter(c.status, 'staff'),
					waiting: false,
					waitingSince: null,
					staffReplied: true,
					alerted: false,
					aiPending: false,
					staffSeenSeq: c.lastSeq + 1,
					unreadStaff: 0,
					...(c.firstStaffReplyAt ? {} : { firstStaffReplyAt: new Date(now()) }),
				},
			},
		);
		await service.log(s, actor, 'conversation.replied', conversation.id, {
			label: conversationLabel(conversation),
			detail: attachment ? 'Reply with an attachment' : 'Reply',
		});
		const [view] = await service.staffMessages(s, [message]);
		return created({ message: view });
	};

	/** @param {any} ctx */
	const note = async (ctx) => {
		const { s, c, actor } = await found(ctx);
		const text = messageText(bodyOf(ctx.body).text);
		if (text === null) throw invalid(['Write the note (up to 4000 characters).']);
		const { message } = await service.append(s, c, {
			author: 'staff',
			text,
			name: actor.name,
			staffId: actor.id,
			internal: true,
		});
		await service.log(s, actor, 'conversation.note_added', c.id, { label: conversationLabel(c), detail: 'Internal note' });
		const [view] = await service.staffMessages(s, [message]);
		return created({ message: view });
	};

	/**
	 * Whether a staff member can take one more open conversation.
	 * @param {Site} s
	 * @param {string} staffId
	 */
	const hasRoom = async (s, staffId) => {
		if (!s.on.includes('presence_queue')) return true;
		const member = await s.store.staff.get(staffId);
		const max = member?.maxChats ?? Number((await s.values('presence_queue')).maxChats);
		if (!max) return true;
		return ((await s.store.conversations.openByStaff()).get(staffId) ?? 0) < max;
	};

	/** @param {any} ctx */
	const update = async (ctx) => {
		const { s, c, actor } = await found(ctx);
		const body = bodyOf(ctx.body);
		/** @type {Record<string, unknown>} */
		const set = {};
		/** @type {Array<{ action: string, detail: string }>} */
		const actions = [];
		if (body.status !== undefined) {
			if (!STATUSES.includes(body.status)) throw invalid(['The status is open, awaiting_visitor or resolved.']);
			set.status = body.status;
			if (body.status === 'resolved') {
				set.waiting = false;
				const ratings = s.on.includes('ratings') ? await s.values('ratings') : null;
				if (
					ratings &&
					!c.rating &&
					(ratings.askWhen === 'on_resolve' || (ratings.askWhen === 'after_staff' && c.staffReplied))
				)
					set.ratingRequested = true;
			}
			actions.push({ action: 'conversation.status_changed', detail: `Status: ${c.status} → ${body.status}` });
		}
		if (body.aiPaused !== undefined) {
			if (typeof body.aiPaused !== 'boolean') throw invalid(['aiPaused is true or false.']);
			set.aiPaused = body.aiPaused;
			actions.push({ action: 'conversation.ai_paused_changed', detail: body.aiPaused ? 'AI paused' : 'AI resumed' });
		}
		if (body.assignedTo !== undefined) {
			needs(s, 'assignment');
			/** @type {string | null} */
			let assignee = null;
			if (body.assignedTo !== null) {
				const member = typeof body.assignedTo === 'string' ? await s.store.staff.get(body.assignedTo) : null;
				if (!member) throw invalid(['Assign to someone on the staff list.']);
				if (body.assignedTo !== c.assignedTo && !(await hasRoom(s, body.assignedTo)))
					throw problem('staff_full', 'This person has the most open chats they can take.');
				assignee = member.name;
			}
			set.assignedTo = body.assignedTo;
			actions.push({ action: 'conversation.assigned', detail: assignee ? `Assigned to ${assignee}` : 'Unassigned' });
		}
		if (body.fields !== undefined) {
			needs(s, 'custom_fields');
			const definitions = await s.list('custom_fields');
			/** @type {string[]} */
			const changed = [];
			for (const [key, value] of Object.entries(bodyOf(body.fields))) {
				const field = definitions.find((f) => f.key === key);
				if (!field) throw invalid([`No custom field ${key}.`]);
				changed.push(String(field.label));
				if (value === null || value === '') {
					set[`fields.${key}`] = null;
					continue;
				}
				const checked = checkFieldValue(field, value);
				if (!checked.ok) throw invalid([`${field.label} is not valid.`]);
				set[`fields.${key}`] = checked.value;
			}
			// the fields' names only: their values may be personal
			actions.push({ action: 'conversation.fields_changed', detail: `Custom fields: ${changed.join(', ')}` });
		}
		if (actions.length === 0) throw invalid(['Send what to change.']);
		const updated = /** @type {ConversationRecord} */ (await s.store.conversations.update(c.id, { set }));
		for (const { action, detail } of actions)
			await service.log(s, actor, action, c.id, { label: conversationLabel(updated), detail });
		return { conversation: await service.inboxView(s, updated, { full: true }) };
	};

	/** @param {any} ctx */
	const remove = async (ctx) => {
		const { s, c, actor } = await found(ctx);
		await deleteConversations(product, s, [c]);
		await service.log(s, actor, 'conversation.deleted', c.id, { label: conversationLabel(c) });
		return noContent();
	};

	/** @param {any} ctx */
	const summary = async (ctx) => {
		const { s, c } = await found(ctx);
		return { summary: await reply.summarise(s, c.id) };
	};

	/** @param {any} ctx */
	const transcript = async (ctx) => {
		const { s, c, actor } = await found(ctx);
		const checked = checkFieldValue({ key: 'email', label: 'email', type: 'email', options: [] }, bodyOf(ctx.body).email);
		if (!checked.ok) throw invalid(['Enter an e-mail address.']);
		await service.sendTranscript(s, c, String(checked.value));
		await service.log(s, actor, 'conversation.transcript_sent', c.id, {
			label: conversationLabel(c),
			detail: 'Transcript e-mailed',
		});
		return new Response(JSON.stringify({ sent: true }), { status: 202, headers: { 'content-type': 'application/json' } });
	};

	/** @param {any} ctx */
	const askRating = async (ctx) => {
		const { s, c } = await found(ctx);
		await s.store.conversations.update(c.id, { set: { ratingRequested: true } });
		return noContent();
	};

	/** @param {any} ctx */
	const upload = async (ctx) => {
		const s = await service.site(ctx);
		return presign(product, s, 'chat/staff', ctx.body, await s.values('attachments'));
	};

	/** @param {any} ctx */
	const unread = async (ctx) => ({ unread: await (await service.site(ctx)).store.conversations.unread() });

	// ------------------------------------------------------------------------------------------------ staff

	/** @param {any} ctx */
	const staff = async (ctx) => {
		const s = await service.site(ctx);
		const presence = s.on.includes('presence_queue');
		const open = await s.store.conversations.openByStaff();
		const defaultMax = presence ? Number((await s.values('presence_queue')).maxChats) || null : null;
		const actor = actorOf(ctx);
		const me = actor.kind === TEAM.kind ? null : actor.id;
		const items = (await s.store.staff.list()).map((m) => {
			const checkedIn = m.checkedInAt ? new Date(m.checkedInAt).getTime() : 0;
			const max = presence ? (m.maxChats ?? defaultMax) : null;
			return {
				id: m.id,
				name: m.name,
				email: m.email,
				presence: now() - checkedIn > PRESENCE_MS ? 'offline' : (m.presence ?? 'online'),
				maxChats: max,
				open: open.get(m.id) ?? 0,
				full: max !== null && (open.get(m.id) ?? 0) >= max,
				...(m.id === me ? { me: true } : {}),
			};
		});
		return { items };
	};

	/** @param {any} ctx */
	const setPresence = async (ctx) => {
		const s = await service.site(ctx);
		const presence = bodyOf(ctx.body).presence;
		if (!PRESENCES.includes(presence)) throw invalid(['Presence is online, away or offline.']);
		const actor = actorOf(ctx);
		await s.store.staff.checkIn(/** @type {any} */ (actor));
		await s.store.staff.set(actor.id, { presence });
		return { presence };
	};

	/** @param {any} ctx */
	const setMaxChats = async (ctx) => {
		const s = await service.site(ctx);
		const max = bodyOf(ctx.body).maxChats;
		if (max !== null && (!Number.isInteger(max) || max < 1 || max > 200))
			throw invalid(['Max chats is 1–200, or null for the default.']);
		const updated = await s.store.staff.set(String(ctx.params.id), { maxChats: max });
		if (!updated) throw problem('not_found', 'No such staff member.');
		await service.log(s, actorOf(ctx), 'staff.max_chats_changed', updated.id, {
			label: updated.name,
			detail: `Max chats: ${max ?? 'default'}`,
		});
		return { staff: { id: updated.id, name: updated.name, email: updated.email, maxChats: updated.maxChats ?? null } };
	};

	// -------------------------------------------------------------------------------------------- saved replies

	/** @param {unknown} raw */
	const checkReply = (raw) => {
		const body = bodyOf(raw);
		const title = typeof body.title === 'string' ? body.title.trim() : '';
		const text = typeof body.text === 'string' ? body.text.trim() : '';
		if (!title || title.length > 100 || !text || text.length > 4000)
			throw invalid(['A title (up to 100) and a text (up to 4000 characters).']);
		return { title, text };
	};

	/** @param {any} ctx */
	const replies = async (ctx) => ({ items: await (await service.site(ctx)).store.replies.list() });

	/** @param {any} ctx */
	const createReply = async (ctx) => {
		const s = await service.site(ctx);
		const value = checkReply(ctx.body);
		if ((await s.store.replies.count()) >= MAX_SAVED_REPLIES) throw invalid([`Up to ${MAX_SAVED_REPLIES} saved replies.`]);
		const saved = await s.store.replies.create(value);
		await service.log(s, actorOf(ctx), 'saved_reply.created', saved.id, { label: saved.title });
		return created({ reply: saved });
	};

	/** @param {any} ctx */
	const updateReply = async (ctx) => {
		const s = await service.site(ctx);
		const value = checkReply(ctx.body);
		if (!(await s.store.replies.update(String(ctx.params.id), value))) throw problem('not_found', 'No such saved reply.');
		await service.log(s, actorOf(ctx), 'saved_reply.updated', String(ctx.params.id), { label: value.title });
		return { reply: { id: String(ctx.params.id), ...value } };
	};

	/** @param {any} ctx */
	const deleteReply = async (ctx) => {
		const s = await service.site(ctx);
		const removed = await s.store.replies.remove(String(ctx.params.id));
		if (!removed) throw problem('not_found', 'No such saved reply.');
		await service.log(s, actorOf(ctx), 'saved_reply.deleted', removed.id, { label: removed.title });
		return noContent();
	};

	/** @param {any} ctx */
	const leads = async (ctx) => {
		const s = await service.site(ctx);
		const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url }, { defaultLimit: 25 });
		const rows = await s.store.leads.list({
			after: /** @type {[string, string] | null} */ (page.after),
			limit: page.fetchLimit,
		});
		const items = rows.map((lead) => ({ ...lead, createdAt: new Date(lead.createdAt).toISOString() }));
		return page.respond(items, (lead) => [lead.createdAt, lead.id]);
	};

	/** @param {any} ctx */
	const lead = async (ctx) => {
		const s = await service.site(ctx);
		const row = await s.store.leads.get(String(ctx.params.id));
		if (!row) throw problem('not_found', 'No such lead.');
		return { lead: { ...row, createdAt: new Date(row.createdAt).toISOString() } };
	};

	return Object.freeze({
		list,
		count: counts.count,
		counts: counts.counts,
		get,
		read,
		reply: replyTo,
		note,
		update,
		remove,
		summary,
		transcript,
		askRating,
		upload,
		unread,
		staff,
		setPresence,
		setMaxChats,
		replies,
		createReply,
		updateReply,
		deleteReply,
		leads,
		lead,
	});
};

/**
 * Delete conversations with their messages, attachments and guest records (the API and data rights).
 * @param {import('../adapters/product.js').Product} product
 * @param {Site} s
 * @param {ConversationRecord[]} conversations
 */
export const deleteConversations = async (product, s, conversations) => {
	const ids = conversations.map((c) => c.id);
	const messages = await s.store.messages.ofConversations(ids);
	const storage = await product.connections.storage(s.websiteId);
	if (storage)
		for (const m of messages) if (m.attachment) await storage.deleteObject({ key: m.attachment.key }).catch(() => null);
	const guests = conversations.flatMap((c) => [...c.guestIds, ...(c.visitor.kind === 'guest' ? [c.visitor.id] : [])]);
	return (await s.store.conversations.remove(ids)) + (await s.store.guests.remove(guests));
};
