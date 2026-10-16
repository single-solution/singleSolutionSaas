/**
 * The `import` feature's record checks and `finish`'s plan (pure; PLAN 0.8.10 K10): times, text limits (refused, never
 * cut), nested shapes, provisional sequence numbers and what a conversation derives from its messages.
 */
import { describe, expect, it } from 'vitest';
import {
	PROVISIONAL_SEQ,
	changesOf,
	checkConversation,
	checkGuest,
	checkMessage,
	checkStaff,
	finishPlan,
	previewText,
	provisionalSeq,
	timeOf,
} from '../core/imports.js';

/** @param {string[]} keys */
const labels = (...keys) => keys.map((key) => ({ key, name: key, description: '' }));
const RULES = {
	callingCode: '+44',
	staffIds: new Set(['usr_000000000000000000000001']),
	customFields: [],
	labels: { tags: labels('vip', 'refund'), topics: labels('orders'), priorities: labels('urgent', 'low') },
};
const CONVERSATION = {
	id: 'conv_000000000000000000000001',
	visitor: { kind: 'user', id: 'usr_000000000000000000000009' },
	status: 'open',
	lastMessageAt: '2024-01-01T10:00:00Z',
	createdAt: '2024-01-01T09:00:00Z',
};
const MESSAGE = {
	id: 'msg_000000000000000000000001',
	conversationId: CONVERSATION.id,
	author: 'visitor',
	text: 'Hello',
	createdAt: '2024-01-01T10:00:00Z',
};
/** @param {{ ok: boolean, errors?: Array<{ path: string }> }} checked */
const paths = (checked) => (checked.ok ? [] : (checked.errors ?? []).map((e) => e.path));

describe('times', () => {
	it('takes ISO 8601 with a zone and refuses what is not a real time', () => {
		expect(timeOf('2024-05-01T10:00:00Z')).toEqual(new Date(Date.UTC(2024, 4, 1, 10)));
		expect(timeOf('2024-05-01T15:00:00.250+05:00')).toEqual(new Date(Date.UTC(2024, 4, 1, 10, 0, 0, 250)));
		expect(timeOf('2024-05-01T10:00Z')).toEqual(new Date(Date.UTC(2024, 4, 1, 10)));
		for (const bad of ['2024-02-30T10:00:00Z', '2024-05-01T24:00:00Z', '2024-05-01T10:60:00Z', '2024-05-01T10:00:61Z']) {
			expect(timeOf(bad)).toBeNull();
		}
		expect(timeOf('2024-05-01T10:00:00+25:00')).toBeNull();
		expect(timeOf('2024-05-01T10:00:00')).toBeNull();
		expect(timeOf('0099-05-01T10:00:00Z')).toBeNull();
		expect(timeOf(1714557600000)).toBeNull();
	});
});

describe('staff and guests', () => {
	it('keeps a staff member’s max chats null for the default, and refuses text where text belongs', () => {
		expect(checkStaff({ id: 'usr_000000000000000000000001', name: 'Sam', maxChats: null })).toEqual({
			ok: true,
			value: { id: 'usr_000000000000000000000001', name: 'Sam', maxChats: null },
		});
		expect(paths(checkStaff({ id: 'usr_000000000000000000000001', name: 7, createdAt: 'then' }))).toEqual([
			'/name',
			'/createdAt',
		]);
	});

	it('keeps a guest’s given expiry and creation time', () => {
		const checked = checkGuest(
			{
				keyHash: 'a'.repeat(64),
				id: 'guest_000000000000000000000001',
				expireAt: '2030-01-01T00:00:00Z',
				createdAt: '2020-01-01T00:00:00Z',
			},
			{ now: Date.UTC(2026, 0, 1), rememberDays: 90 },
		);
		expect(checked).toEqual({
			ok: true,
			value: {
				keyHash: 'a'.repeat(64),
				id: 'guest_000000000000000000000001',
				expireAt: new Date('2030-01-01T00:00:00Z'),
				createdAt: new Date('2020-01-01T00:00:00Z'),
			},
		});
	});
});

describe('conversations', () => {
	it('fills what a conversation without messages has and keeps the given contact', () => {
		const checked = checkConversation(
			{ ...CONVERSATION, guestIds: ['guest_000000000000000000000001', 'guest_000000000000000000000001'], email: '' },
			RULES,
		);
		expect(checked.ok && checked.value).toMatchObject({
			guestIds: ['guest_000000000000000000000001'],
			email: null,
			phone: null,
			name: null,
			waiting: false,
			aiPaused: false,
			aiPausedBy: null,
			assignedTo: null,
			fields: {},
			rating: null,
			page: null,
			device: '',
			unreadStaff: 0,
			lastSeq: 0,
			preview: '',
			flow: null,
			flowsRun: [],
			tags: [],
			topic: null,
			priority: null,
		});
	});

	it('keeps tags, a topic and a priority of the website’s lists (C7), and refuses others', () => {
		const checked = checkConversation(
			{ ...CONVERSATION, tags: ['vip', 'refund', 'vip'], topic: 'orders', priority: 'urgent' },
			RULES,
		);
		expect(checked.ok && checked.value).toMatchObject({ tags: ['vip', 'refund'], topic: 'orders', priority: 'urgent' });
		expect(
			paths(checkConversation({ ...CONVERSATION, tags: ['vip', 'unknown'], topic: 'returns', priority: 1 }, RULES)),
		).toEqual(['/tags', '/topic', '/priority']);
		const many = Array.from({ length: 11 }, (_, i) => `t${i}`);
		expect(
			paths(
				checkConversation({ ...CONVERSATION, tags: many }, { ...RULES, labels: { ...RULES.labels, tags: labels(...many) } }),
			),
		).toEqual(['/tags']);
	});

	it('takes a page with its defaults and refuses shapes that do not fit', () => {
		const checked = checkConversation({ ...CONVERSATION, page: { url: '', title: '  ' } }, RULES);
		expect(checked.ok && checked.value.page).toEqual({ url: '', title: '', kind: 'other', productId: null, productName: null });
		expect(
			paths(
				checkConversation(
					{
						...CONVERSATION,
						visitor: 'guest',
						guestIds: 'guest_1',
						aiPausedBy: 'Sam',
						fields: [1],
						rating: 5,
						page: 'home',
						waiting: 'yes',
						unreadStaff: -1,
						createdAt: undefined,
					},
					RULES,
				),
			),
		).toEqual([
			'/visitor',
			'/guestIds',
			'/waiting',
			'/aiPausedBy',
			'/fields',
			'/rating',
			'/page',
			'/unreadStaff',
			'/createdAt',
		]);
		expect(paths(checkConversation({ ...CONVERSATION, id: 'conv_1', status: undefined }, RULES))).toEqual(['/id', '/status']);
		expect(paths(checkConversation({ ...CONVERSATION, visitor: { kind: 'user', id: 'a b', extra: 1 } }, RULES))).toEqual([
			'/visitor/extra',
			'/visitor',
		]);
		const fields = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`f${i}`, 'x']));
		expect(paths(checkConversation({ ...CONVERSATION, fields }, RULES))).toEqual(['/fields']);
	});
});

describe('messages', () => {
	it('keeps a markdown staff message with its staff id and an attachment beside empty text', () => {
		const checked = checkMessage({
			...MESSAGE,
			author: 'staff',
			staffId: 'usr_000000000000000000000001',
			name: 'Sam',
			text: '  **Done**  ',
			format: 'markdown',
			internal: false,
		});
		expect(checked).toEqual({
			ok: true,
			value: {
				id: MESSAGE.id,
				conversationId: CONVERSATION.id,
				seq: provisionalSeq(new Date(MESSAGE.createdAt), MESSAGE.id),
				author: 'staff',
				staffId: 'usr_000000000000000000000001',
				name: 'Sam',
				text: '**Done**',
				format: 'markdown',
				internal: false,
				attachment: null,
				createdAt: new Date(MESSAGE.createdAt),
			},
		});
		const file = checkMessage({
			...MESSAGE,
			text: '',
			attachment: { key: 'chat/guest-1/a.pdf', name: 'a.pdf', type: 'application/pdf', size: 10 },
		});
		expect(file.ok && file.value).toMatchObject({ text: '', attachment: { key: 'chat/guest-1/a.pdf', size: 10 } });
	});

	it('refuses ids, authors, formats and attachments that do not fit', () => {
		expect(
			paths(checkMessage({ ...MESSAGE, id: 'msg_1', conversationId: 'conv_1', author: undefined, format: 'html', text: 5 })),
		).toEqual(['/id', '/conversationId', '/author', '/text', '/format']);
		expect(paths(checkMessage({ ...MESSAGE, author: 'robot' }))).toEqual(['/author']);
		expect(paths(checkMessage({ ...MESSAGE, attachment: 'a.jpg' }))).toEqual(['/attachment']);
		expect(
			paths(checkMessage({ ...MESSAGE, attachment: { key: 'chat/a\nb.jpg', name: 'b.jpg', size: 1, owner: 'x' } })),
		).toEqual(['/attachment/owner', '/attachment/key', '/attachment/type']);
	});
});

describe('provisional numbers', () => {
	it('keep the time order, past the numbers a conversation reaches, and stay safe integers', () => {
		const a = provisionalSeq(new Date('2024-01-01T10:00:00Z'), 'msg_000000000000000000000002');
		const b = provisionalSeq(new Date('2024-01-01T10:00:01Z'), 'msg_000000000000000000000001');
		expect(a).toBeGreaterThan(PROVISIONAL_SEQ);
		expect(a).toBeLessThan(b);
		expect(provisionalSeq(new Date('1990-01-01T00:00:00Z'), 'msg_x')).toBeLessThan(2 * PROVISIONAL_SEQ);
		expect(Number.isSafeInteger(provisionalSeq(new Date('2999-01-01T00:00:00Z'), 'msg_x'))).toBe(true);
	});
});

describe('finish’s plan', () => {
	const at = (/** @type {string} */ time) => new Date(`2024-01-01T${time}Z`);
	it('numbers by time then id, derives the counters and caps the unread counts at the messages there are', () => {
		const plan = finishPlan({ lastMessageAt: at('09:00:00'), unreadStaff: 9, unreadVisitor: 1 }, [
			{ id: 'msg_b', seq: 1, author: 'visitor', internal: false, createdAt: at('10:00:00') },
			{ id: 'msg_a', seq: 2, author: 'visitor', internal: false, createdAt: at('10:00:00') },
			{ id: 'msg_c', seq: 3, author: 'system', internal: false, createdAt: at('10:01:00') },
			{ id: 'msg_d', seq: 4, author: 'staff', internal: true, createdAt: at('10:02:00') },
		]);
		expect(plan).toEqual({
			order: ['msg_a', 'msg_b', 'msg_c', 'msg_d'],
			changed: ['msg_a', 'msg_b'],
			lastVisibleId: 'msg_c',
			set: {
				lastSeq: 4,
				visitorMessages: 2,
				aiReplies: 0,
				staffReplied: false,
				firstVisitorAt: at('10:00:00'),
				firstStaffReplyAt: null,
				lastMessageAt: at('10:01:00'),
				unreadStaff: 2,
				unreadVisitor: 1,
				staffSeenSeq: 0,
				visitorSeenSeq: 2,
			},
		});
	});

	it('writes the preview as Chat does and finds what changed', () => {
		expect(previewText({ text: '**Big** [deal](https://x.example.com)', format: 'markdown' })).toBe('Big deal');
		expect(previewText({ text: '', attachment: { name: 'photo.jpg' } })).toBe('photo.jpg');
		expect(previewText({})).toBe('');
		expect(changesOf({ a: 1, at: new Date(5) }, { a: 1, at: new Date(5) })).toBeNull();
		expect(changesOf({ a: 1 }, { a: 2, b: null })).toEqual({ a: 2, b: null });
	});
});
