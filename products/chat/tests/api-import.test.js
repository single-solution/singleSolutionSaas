/**
 * Moving another system's chats into Chat (PLAN 0.8.10 K10, Migration step 7): the `import` feature's routes for the
 * merchant's server — dry runs that report every refusal and write nothing, re-runnable upserts by id (guests by the
 * hash of their old cookie value, so the old cookie keeps its conversation, C7), `finish` numbering each conversation's
 * messages in time order (C8), prune, the status totals and the feature switch. Nothing is sent.
 */
import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createRoutes } from '../server/routes.js';
import { API, BASE, ready } from './helpers.js';

/** @type {Array<Awaited<ReturnType<typeof ready>>>} */
const systems = [];
afterAll(async () => {
	for (const sys of systems) await sys.product.close();
});

const ON = ['visitor_chat', 'guest_chat', 'inbox', 'assignment', 'internal_notes', 'custom_fields', 'import'];

/** An id as the importer makes it from an ObjectId: the prefix and 24 hex digits. @param {string} prefix @param {number} n */
const idOf = (prefix, n) => `${prefix}_${n.toString(16).padStart(24, '0')}`;
/** @param {string} text */
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

const COOKIE = 'old-guest-cookie-0001';
const STAFF = {
	id: idOf('usr', 1),
	name: 'Alex Morgan',
	email: 'Alex@Shop.example.com',
	presence: 'away',
	maxChats: 5,
	createdAt: '2023-01-02T03:04:05Z',
};
const GUEST = { keyHash: sha256(COOKIE), id: idOf('guest', 1) };
const CONV = idOf('conv', 1);
const CONVERSATION = {
	id: CONV,
	visitor: { kind: 'guest', id: GUEST.id },
	name: 'Sam Visitor',
	phone: '07700 900123',
	status: 'awaiting_visitor',
	waiting: true,
	waitingSince: '2024-03-01T10:05:00Z',
	handedOffAt: '2024-03-01T10:05:00Z',
	aiPaused: true,
	aiPausedBy: { kind: 'user', id: STAFF.id, name: STAFF.name },
	aiPausedAt: '2024-03-01T10:06:00Z',
	aiPausedReason: 'Taking over',
	assignedTo: STAFF.id,
	note: 'Wants a call back',
	fields: { order_ref: 'A-100' },
	unreadStaff: 1,
	lastMessageAt: '2024-03-01T10:10:00Z',
	createdAt: '2024-03-01T10:00:00Z',
};
/** A signed-in visitor's resolved conversation without messages. */
const RESOLVED = {
	id: idOf('conv', 2),
	visitor: { kind: 'user', id: idOf('usr', 9) },
	email: 'buyer@example.com',
	status: 'resolved',
	summary: 'Asked about delivery.',
	rating: { score: 4, comment: null, at: '2024-02-01T09:30:00Z' },
	page: { url: 'https://shop.example.com/p/1', title: 'A phone', kind: 'product', productId: 'prd_1', productName: 'A phone' },
	lastMessageAt: '2024-02-01T09:20:00Z',
	createdAt: '2024-02-01T09:00:00Z',
};
/** The messages in source order (not time order); two share a time (ties by id). */
const MESSAGES = [
	{
		id: idOf('msg', 3),
		conversationId: CONV,
		author: 'staff',
		staffId: STAFF.id,
		name: STAFF.name,
		text: 'We will **call** you.',
		format: 'markdown',
		createdAt: '2024-03-01T10:10:00Z',
	},
	{
		id: idOf('msg', 1),
		conversationId: CONV,
		author: 'visitor',
		text: 'Hello, is the phone in stock?',
		createdAt: '2024-03-01T10:00:00Z',
	},
	{
		id: idOf('msg', 2),
		conversationId: CONV,
		author: 'ai',
		name: 'Assistant',
		text: 'Yes, it is.',
		createdAt: '2024-03-01T10:01:00Z',
	},
	{
		id: idOf('msg', 4),
		conversationId: CONV,
		author: 'staff',
		staffId: STAFF.id,
		name: STAFF.name,
		text: 'Check the stock first',
		internal: true,
		createdAt: '2024-03-01T10:10:00Z',
	},
	{
		id: idOf('msg', 5),
		conversationId: CONV,
		author: 'visitor',
		attachment: { key: 'chat/guest-old/photo.jpg', name: 'photo.jpg', type: 'image/jpeg', size: 1234 },
		createdAt: '2024-03-01T10:09:00Z',
	},
];

/** @param {string[]} [on] */
const start = async (on = ON) => {
	const sys = await ready(on);
	systems.push(sys);
	const handler = sys.product.handler(createRoutes(sys.product));
	/** @param {string} method @param {string} path @param {string} [body] @param {string} [type] */
	const raw = async (method, path, body, type) => {
		const response = await handler(
			new Request(`${BASE}${path}`, {
				method,
				headers: { authorization: `Bearer ${sys.server}`, ...(type ? { 'content-type': type } : {}) },
				...(body === undefined ? {} : { body }),
			}),
		);
		const text = await response.text();
		const json = text ? JSON.parse(text) : null;
		API.assert({ method, path, status: response.status, body: json });
		return { status: response.status, json };
	};
	return {
		...sys,
		/** @param {string} collection @param {unknown[]} records @param {{ dryRun?: boolean }} [options] */
		send: (collection, records, { dryRun = false } = {}) =>
			raw(
				'POST',
				`/v1/import/${collection}${dryRun ? '?dryRun=1' : ''}`,
				`${records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n')}\n`,
				'application/x-ndjson',
			),
		/** @param {string} collection @param {unknown} body @param {{ dryRun?: boolean }} [options] */
		prune: (collection, body, { dryRun = false } = {}) =>
			raw('POST', `/v1/import/${collection}/prune${dryRun ? '?dryRun=1' : ''}`, JSON.stringify(body), 'application/json'),
		/** @param {string} [after] */
		finish: (after) => raw('POST', `/v1/import/finish${after === undefined ? '' : `?after=${after}`}`),
		status: () => raw('GET', '/v1/import/status'),
		/** A stored record, read directly. @param {string} collection @param {Record<string, unknown>} filter */
		stored: async (collection, filter) =>
			(await sys.product.data.forWebsite(sys.websiteId))
				.collection(collection)
				.findOne(
					{ websiteId: sys.websiteId, ...filter },
					{ projection: { _id: 0, websiteId: 0, merchantId: 0, updatedAt: 0 } },
				),
		/** The seq of each message of a conversation, by id. @param {string} conversationId */
		seqs: async (conversationId) =>
			Object.fromEntries(
				(
					await (
						await sys.product.data.forWebsite(sys.websiteId)
					)
						.collection('messages')
						.find({ websiteId: sys.websiteId, conversationId }, { projection: { _id: 0, id: 1, seq: 1 } })
						.toArray()
				).map((m) => [m.id, m.seq]),
			),
	};
};

/** Imports everything of the fixtures, in the importer's order. @param {Awaited<ReturnType<typeof start>>} sys */
const importAll = async (sys) => {
	await sys.list('custom_fields', [{ key: 'order_ref', label: 'Order ref', type: 'text' }]);
	expect((await sys.send('staff', [STAFF])).json).toMatchObject({ inserted: 1, failed: [] });
	expect((await sys.send('guests', [GUEST])).json).toMatchObject({ inserted: 1, failed: [] });
	expect((await sys.send('conversations', [CONVERSATION, RESOLVED])).json).toMatchObject({ inserted: 2, failed: [] });
	expect((await sys.send('messages', MESSAGES)).json).toMatchObject({ inserted: 5, failed: [] });
};

describe('import (K10): checks and dry runs', () => {
	it('a dry run reports every refusal by line and field and writes nothing', async () => {
		const sys = await start();
		await sys.list('custom_fields', [{ key: 'order_ref', label: 'Order ref', type: 'number' }]);
		const staff = await sys.send(
			'staff',
			[
				STAFF,
				{
					id: idOf('usr', 2),
					name: ' ',
					email: 'not-mail',
					presence: 'busy',
					maxChats: 0,
					role: 'Support',
					websiteId: 'web_x',
				},
				{ id: idOf('usr', 3), name: 'x'.repeat(121) },
			],
			{ dryRun: true },
		);
		expect(staff.status).toBe(200);
		expect(staff.json).toMatchObject({ inserted: 1, updated: 0, dryRun: true });
		expect(staff.json.failed).toEqual([
			{
				line: 2,
				id: idOf('usr', 2),
				errors: [
					{ path: '/role', message: 'Unknown field role.' },
					{ path: '/websiteId', message: 'websiteId is never taken from a record: the import stamps the website.' },
					{ path: '/name', message: 'This is required.' },
					{ path: '/email', message: 'Not an email address.' },
					{ path: '/presence', message: 'One of online, away, offline.' },
					{ path: '/maxChats', message: 'A whole number from 1 to 200.' },
				],
			},
			{
				line: 3,
				id: idOf('usr', 3),
				errors: [{ path: '/name', message: 'At most 120 characters (this has 121); shorten it in the source.' }],
			},
		]);
		const guests = await sys.send(
			'guests',
			[
				GUEST,
				{ keyHash: 'ABC', id: 'guest_1' },
				{ keyHash: sha256('x'), id: idOf('guest', 2), expireAt: '2020-01-01T00:00:00Z' },
			],
			{ dryRun: true },
		);
		expect(guests.json.failed.map((/** @type {any} */ f) => [f.line, f.errors.map((/** @type {any} */ e) => e.path)])).toEqual([
			[2, ['/keyHash', '/id']],
			[3, ['/expireAt']],
		]);
		const conversations = await sys.send(
			'conversations',
			[
				CONVERSATION,
				{
					...RESOLVED,
					visitor: { kind: 'robot', id: 'x' },
					phone: '12',
					status: 'pending',
					tags: ['vip'],
					note: 'n'.repeat(4001),
					fields: { order_ref: 'abc', color: 'red' },
					rating: { score: 11, at: 'yesterday', extra: 1 },
					page: { url: 'ftp://x', kind: 'Shelf!' },
					aiPausedBy: { kind: 'user' },
					lastMessageAt: '2024-02-30T10:00:00Z',
				},
			],
			{ dryRun: true },
		);
		// the first one names staff that are not imported yet (a dry run writes nothing)
		expect(conversations.json.failed[0]).toEqual({
			line: 1,
			id: CONV,
			errors: [
				{ path: '/assignedTo', message: `No member of staff ${STAFF.id}: import the staff first.` },
				{ path: '/fields/order_ref', message: 'Not a value of Order ref.' },
			],
		});
		expect(conversations.json.failed[1].errors.map((/** @type {any} */ e) => e.path)).toEqual([
			'/visitor',
			'/phone',
			'/status',
			'/aiPausedBy/id',
			'/aiPausedBy/name',
			'/note',
			'/fields/order_ref',
			'/fields/color',
			'/rating/extra',
			'/rating/score',
			'/rating/at',
			'/page/url',
			'/page/kind',
			// a tag the website's Tags list does not have
			'/tags',
			'/lastMessageAt',
		]);
		const messages = await sys.send(
			'messages',
			[
				MESSAGES[1],
				{ ...MESSAGES[0], seq: 4, staffId: 'bad id!', internal: 'yes', text: 'x'.repeat(4001) },
				{ id: idOf('msg', 9), conversationId: CONV, author: 'visitor', staffId: STAFF.id, internal: true },
				{ ...MESSAGES[4], attachment: { key: 'products/x.jpg', name: 'a/b', type: 'text/html', size: 0 } },
				'not json',
			],
			{ dryRun: true },
		);
		expect(
			messages.json.failed.map((/** @type {any} */ f) => [f.line, f.errors.map((/** @type {any} */ e) => e.path)]),
		).toEqual([
			[1, ['/conversationId']],
			[2, ['/seq', '/staffId', '/internal', '/text']],
			[3, ['/staffId', '/internal', '/text', '/createdAt']],
			[4, ['/attachment/key', '/attachment/name', '/attachment/type', '/attachment/size']],
			[5, ['']],
		]);
		expect(messages.json.failed[0].errors[0].message).toBe(`No conversation ${CONV}: import the conversations first.`);
		// nothing was written
		const status = await sys.status();
		expect(status.json.collections).toEqual({ staff: 0, guests: 0, conversations: 0, messages: 0 });
		expect(status.json.imported).toEqual({ staff: 0, guests: 0, conversations: 0, messages: 0 });
	});
});

describe('import (K10): a run, a re-run and finish', () => {
	it('stores Chat’s own shapes, numbers the messages in time order and the old guest cookie finds its chat', async () => {
		const sys = await start();
		await importAll(sys);
		expect(await sys.stored('staff', { id: STAFF.id })).toEqual({
			id: STAFF.id,
			name: 'Alex Morgan',
			email: 'alex@shop.example.com',
			presence: 'away',
			maxChats: 5,
			createdAt: new Date(STAFF.createdAt),
		});
		const guest = await sys.stored('guests', { keyHash: GUEST.keyHash });
		expect(guest).toMatchObject({ id: GUEST.id, keyHash: sha256(COOKIE) });
		// remembered for the guest_chat setting's days (90) from now
		expect(guest?.expireAt).toEqual(new Date(sys.now() + 90 * 86_400_000));
		const before = await sys.stored('conversations', { id: CONV });
		expect(before).toMatchObject({
			phone: '+447700900123',
			status: 'awaiting_visitor',
			aiPausedBy: { kind: 'user', id: STAFF.id, name: STAFF.name },
			fields: { order_ref: 'A-100' },
			lastSeq: 0,
			createdAt: new Date(CONVERSATION.createdAt),
		});
		// provisional numbers keep the time order, far past what a conversation reaches by itself
		const provisional = await sys.seqs(CONV);
		expect(Object.values(provisional).every((seq) => seq > 2 ** 21)).toBe(true);
		expect(provisional[idOf('msg', 1)]).toBeLessThan(provisional[idOf('msg', 2)]);

		const finished = await sys.finish();
		expect(finished.status).toBe(200);
		expect(finished.json).toEqual({ finished: true, conversations: 2, renumbered: 5, updated: 1, next: null, more: false });
		expect(await sys.seqs(CONV)).toEqual({
			[idOf('msg', 1)]: 1,
			[idOf('msg', 2)]: 2,
			[idOf('msg', 5)]: 3,
			[idOf('msg', 3)]: 4,
			[idOf('msg', 4)]: 5,
		});
		expect(await sys.stored('conversations', { id: CONV })).toMatchObject({
			lastSeq: 5,
			visitorMessages: 2,
			aiReplies: 1,
			staffReplied: true,
			firstVisitorAt: new Date('2024-03-01T10:00:00Z'),
			firstStaffReplyAt: new Date('2024-03-01T10:10:00Z'),
			lastMessageAt: new Date('2024-03-01T10:10:00Z'),
			preview: 'We will call you.',
			unreadStaff: 1,
			staffSeenSeq: 2,
			unreadVisitor: 0,
			visitorSeenSeq: 5,
		});
		// finish again changes nothing
		expect((await sys.finish()).json).toEqual({
			finished: true,
			conversations: 2,
			renumbered: 0,
			updated: 0,
			next: null,
			more: false,
		});

		// the old guest cookie value, sent as SS-Guest, reaches the conversation (C7)
		const visitor = sys.visitor({ guestKey: COOKIE });
		const chat = await visitor('GET', '/v1/chat');
		expect(chat.status).toBe(200);
		expect(chat.json.conversation).toMatchObject({ id: CONV, status: 'awaiting_visitor' });
		expect(chat.json.messages.map((/** @type {any} */ m) => [m.seq, m.author, m.text])).toEqual([
			[1, 'visitor', 'Hello, is the phone in stock?'],
			[2, 'ai', 'Yes, it is.'],
			[3, 'visitor', ''],
			[4, 'staff', 'We will **call** you.'],
		]);
		// and goes on after the imported messages
		const sent = await visitor('POST', '/v1/chat/messages', { text: 'Any news?' });
		expect(sent.status).toBe(201);
		expect((await visitor('GET', '/v1/chat')).json.messages.at(-1)).toMatchObject({ seq: 6, text: 'Any news?' });
		// staff see the conversation with its assignment and the internal note
		const inbox = await sys.serverCall('GET', `/v1/conversations/${CONV}`);
		expect(inbox.json.conversation).toMatchObject({ assignedTo: { id: STAFF.id, name: 'Alex Morgan' }, waiting: true });
		expect(inbox.json.messages.map((/** @type {any} */ m) => m.internal)).toEqual([false, false, false, false, true, false]);
		// nothing was sent
		expect(sys.messages()).toEqual([]);
		expect(sys.aiCalls()).toEqual([]);
	});

	it('a re-run replaces the records and finish numbers them again; prune removes what the source dropped', async () => {
		const sys = await start();
		await importAll(sys);
		await sys.finish();
		const again = await sys.send('messages', MESSAGES);
		expect(again.json).toEqual({ inserted: 0, updated: 5, failed: [], dryRun: false });
		const conversations = await sys.send('conversations', [{ ...CONVERSATION, status: 'open', unreadStaff: 0 }, RESOLVED]);
		expect(conversations.json).toMatchObject({ inserted: 0, updated: 2 });
		expect(await sys.stored('conversations', { id: CONV })).toMatchObject({ status: 'open', lastSeq: 0 });
		expect((await sys.finish()).json).toMatchObject({ conversations: 2, renumbered: 5, updated: 1 });
		expect(await sys.stored('conversations', { id: CONV })).toMatchObject({ lastSeq: 5, staffSeenSeq: 5, unreadStaff: 0 });

		// the source no longer has the internal note: a dry run says so, the real run removes it
		const keep = MESSAGES.map((m) => m.id).filter((id) => id !== idOf('msg', 4));
		expect((await sys.prune('messages', { keep }, { dryRun: true })).json).toEqual({
			removed: 1,
			keys: [idOf('msg', 4)],
			more: false,
			dryRun: true,
		});
		expect((await sys.prune('messages', { keep })).json).toMatchObject({ removed: 1, keys: [idOf('msg', 4)] });
		expect((await sys.finish()).json).toMatchObject({ renumbered: 0, updated: 1 });
		expect(await sys.stored('conversations', { id: CONV })).toMatchObject({ lastSeq: 4 });

		const status = await sys.status();
		expect(status.json).toEqual({
			collections: { staff: 1, guests: 1, conversations: 2, messages: 4 },
			imported: { staff: 1, guests: 1, conversations: 2, messages: 4 },
			totals: {
				conversations: 2,
				messages: 4,
				'conversations.open': 1,
				'conversations.awaiting_visitor': 0,
				'conversations.resolved': 1,
				'conversations.waiting': 1,
			},
		});
		// the activity log keeps one entry per call, never a message
		const activity = (await sys.serverCall('GET', '/v1/activity?action=import.messages')).json.items;
		expect(activity.map((/** @type {any} */ e) => e.values)).toEqual([
			{ inserted: 0, updated: 5, failed: 0 },
			{ inserted: 5, updated: 0, failed: 0 },
		]);
	});

	it('finish takes the imported conversations in batches of 100 and answers where to go on', async () => {
		const sys = await start();
		const many = Array.from({ length: 101 }, (_, i) => ({
			id: idOf('conv', 100 + i),
			visitor: { kind: 'user', id: idOf('usr', 100 + i) },
			status: 'open',
			unreadStaff: 3,
			lastMessageAt: '2024-01-01T00:00:00Z',
			createdAt: '2024-01-01T00:00:00Z',
		}));
		expect((await sys.send('conversations', many)).json).toMatchObject({ inserted: 101, failed: [] });
		const first = await sys.finish();
		expect(first.json).toEqual({
			finished: true,
			conversations: 100,
			renumbered: 0,
			updated: 100,
			next: idOf('conv', 199),
			more: true,
		});
		const second = await sys.finish(first.json.next);
		expect(second.json).toEqual({ finished: true, conversations: 1, renumbered: 0, updated: 1, next: null, more: false });
		// no messages: no unread counts
		expect(await sys.stored('conversations', { id: idOf('conv', 200) })).toMatchObject({ unreadStaff: 0, lastSeq: 0 });
		expect((await sys.finish('nope')).json).toMatchObject({ status: 422, detail: expect.stringContaining('after') });
	});

	it('the routes need the import feature and the server token', async () => {
		const sys = await start(ON.filter((key) => key !== 'import'));
		const sent = await sys.send('staff', [STAFF]);
		expect(sent.status).toBe(403);
		expect(sent.json.type).toMatch(/feature_off$/);
		expect((await sys.status()).status).toBe(403);
		expect((await sys.finish()).status).toBe(403);
		expect((await sys.call('GET', '/v1/import/status', { token: sys.browser })).status).toBe(401);
	});
});
