// @vitest-environment jsdom
/* global window */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_CONFIG_PATH } from '../ui/widget.js';
import { startWidget } from '../ui/widget.js';
import {
	BASE,
	START,
	TEXTS,
	answer,
	buttonIn,
	change,
	checkIn,
	choose,
	click,
	clock,
	configOf,
	fieldIn,
	flush,
	place,
	problem,
	resetPage,
	script,
	serve,
	shadow,
	shows,
	submit,
	textsIn,
} from './ui-helpers.js';

beforeEach(resetPage);
afterEach(resetPage);

const AT = new Date(START).toISOString();
const ticket = (/** @type {string} */ value = 'tk', minutes = 15) => ({
	ticket: value,
	expiresAt: new Date(START + minutes * 60_000).toISOString(),
});

/**
 * @param {{ features: string[], settings?: Record<string, any>, routes?: Record<string, import('./ui-helpers.js').Route>,
 *   getTicket?: () => Promise<any> }} input
 */
const startAdmin = async ({ features, settings = {}, routes = {}, getTicket }) => {
	const time = clock();
	const hosts = { inbox: place('inbox'), knowledge: place('knowledge_editor'), reports: place('reports') };
	const server = serve({ [`GET ${ADMIN_CONFIG_PATH}`]: () => answer(200, configOf(features, settings)), ...routes });
	const api = startWidget({ window, script: script(null), ...time });
	const unread = vi.fn();
	api.onUnread(unread);
	await api.admin({ getTicket: getTicket ?? (async () => ticket()) });
	await flush();
	return { time, server, api, hosts, unread };
};

describe('admin()', () => {
	it('mounts nothing without a ticket, a config or the features', async () => {
		const failing = await startAdmin({ features: ['inbox'], getTicket: async () => Promise.reject(new Error('no')) });
		expect(failing.hosts.inbox.shadowRoot).toBeNull();
		resetPage();
		const empty = await startAdmin({ features: ['inbox'], getTicket: async () => ({}) });
		expect(empty.server.calls).toHaveLength(0);
		resetPage();
		const refused = await startAdmin({
			features: ['inbox'],
			routes: { [`GET ${ADMIN_CONFIG_PATH}`]: () => problem(403, 'x') },
		});
		expect(refused.hosts.inbox.shadowRoot).toBeNull();
		resetPage();
		const off = await startAdmin({ features: [] });
		expect(off.hosts.inbox.shadowRoot).toBeNull();
		expect(off.hosts.reports.shadowRoot).toBeNull();
		expect(off.server.last(`GET ${ADMIN_CONFIG_PATH}`)?.headers.authorization).toBe('Bearer tk');
	});
});

/** @param {Record<string, unknown>} [over] */
const item = (over = {}) => ({
	id: 'c1',
	visitor: { kind: 'guest', id: 'g1', name: 'Ana', email: 'ana@x.co', phone: null },
	status: 'open',
	waiting: true,
	aiPaused: true,
	assignedTo: { id: 's1', name: 'Sam' },
	unread: 2,
	preview: 'Hi there',
	lastMessageAt: AT,
	createdAt: AT,
	...over,
});
/** @param {Record<string, unknown>} [over] */
const full = (over = {}) => ({
	...item(),
	fields: { size: 3 },
	summary: null,
	rating: { score: 4, comment: 'ok' },
	context: {
		name: 'Ana',
		email: 'ana@x.co',
		phone: '',
		page: { url: 'https://shop.test/p', title: 'Phone', kind: 'product', productId: 'p1', productName: 'Phone X' },
		device: 'Mobile',
		conversations: 3,
	},
	visitorSeenSeq: 3,
	...over,
});
/** @param {number} seq @param {string} author @param {Record<string, unknown>} [over] */
const message = (seq, author, over = {}) => ({
	id: `m${seq}`,
	seq,
	author,
	name: author === 'staff' ? 'Sam' : null,
	text: `text ${seq}`,
	internal: false,
	createdAt: AT,
	...over,
});
const STAFF = [
	{ id: 's1', name: 'Sam', email: 's@x.co', presence: 'online', maxChats: 2, open: 2, full: true, me: true },
	{ id: 's2', name: '', email: 'b@x.co', presence: 'away', maxChats: null, open: 0, full: false },
];

describe('inbox', () => {
	const ALL = [
		'inbox',
		'assignment',
		'presence_queue',
		'internal_notes',
		'saved_replies',
		'custom_fields',
		'context_panel',
		'ai_summary',
		'transcripts',
		'ratings',
		'attachments',
		'typing_receipts',
	];

	it('lists, filters, opens and works a conversation', async () => {
		/** @type {any} */
		let conversation = full();
		/** @type {any[]} */
		let extra = [];
		let patchAnswer = /** @type {() => Response} */ (() => answer(200, { conversation }));
		let replyAnswer = /** @type {() => Response} */ (() => answer(201, { message: message(5, 'staff', { text: 'Sure' }) }));
		/** @type {any[]} */
		let saved = [{ id: 'r1', title: 'Hello', text: 'Hello there' }];
		const { server, hosts, unread, time } = await startAdmin({
			features: ALL,
			settings: {
				customFields: [{ key: 'size', label: 'Size', type: 'number', options: [] }],
				ratings: { askWhen: 'manual' },
				attachments: { types: [], maxBytes: 0 },
			},
			routes: {
				'GET /v1/admin/staff': () => answer(200, { items: STAFF }),
				'PUT /v1/admin/staff/me/presence': (call) => answer(200, { presence: call.body.presence }),
				'PATCH /v1/admin/staff/s2': () => answer(200, { staff: {} }),
				'PATCH /v1/admin/staff/s1': () => problem(403, 'forbidden'),
				'GET /v1/admin/saved-replies': () => answer(200, { items: saved }),
				'POST /v1/admin/saved-replies': (call) => {
					saved = [...saved, { id: 'r2', ...call.body }];
					return answer(201, {});
				},
				'PUT /v1/admin/saved-replies/r1': (call) => {
					saved = [{ id: 'r1', ...call.body }];
					return answer(200, {});
				},
				'DELETE /v1/admin/saved-replies/r1': () => answer(204),
				'GET /v1/admin/conversations': (call) =>
					answer(200, {
						items: call.url.searchParams.get('cursor')
							? [
									item({
										id: 'c2',
										visitor: { kind: 'user' },
										unread: 0,
										waiting: false,
										aiPaused: false,
										assignedTo: null,
										preview: null,
									}),
								]
							: [item()],
						nextCursor: call.url.searchParams.get('cursor') ? null : 'n1',
						hasMore: !call.url.searchParams.get('cursor'),
						unread: 2,
					}),
				'GET /v1/admin/conversations/c1': (call) =>
					answer(200, {
						conversation,
						messages: call.url.searchParams.get('after')
							? extra
							: [
									message(1, 'visitor'),
									message(2, 'ai'),
									message(3, 'staff'),
									message(4, 'staff', {
										internal: true,
										name: null,
										attachment: { name: 'a.png', type: 'image/png', size: 3, url: 'https://files.test/a.png' },
									}),
								],
					}),
				'POST /v1/admin/conversations/c1/read': () => answer(204),
				'PATCH /v1/admin/conversations/c1': (call) => {
					conversation = {
						...conversation,
						...call.body,
						...(call.body.assignedTo !== undefined
							? { assignedTo: call.body.assignedTo ? { id: call.body.assignedTo, name: 'B' } : null }
							: {}),
					};
					return patchAnswer();
				},
				'POST /v1/admin/conversations/c1/messages': () => replyAnswer(),
				'POST /v1/admin/conversations/c1/notes': () =>
					answer(201, { message: message(6, 'staff', { internal: true, text: 'Note' }) }),
				'POST /v1/admin/conversations/c1/summary': () => answer(200, { summary: 'Wants a phone.' }),
				'POST /v1/admin/conversations/c1/transcript': () => answer(202, { sent: true }),
				'POST /v1/admin/conversations/c1/rating-request': () => answer(204),
				'GET /v1/admin/inbox/unread': () => answer(200, { unread: 7 }),
			},
		});
		const root = shadow(hosts.inbox);
		expect(root.querySelector('.total')?.textContent).toBe('2 unread');
		expect(unread).toHaveBeenCalledWith(2, 'inbox');
		expect(textsIn(root, '.conversations li > button')).toEqual(['Ana']);
		expect(root.querySelector('.conversations .meta:last-child')?.textContent).toContain('Assigned to Sam');

		// filters and paging
		await change(fieldIn(root, TEXTS['inbox.status']), 'resolved');
		await change(fieldIn(root, TEXTS['inbox.assigned']), 'me');
		await change(fieldIn(root, TEXTS['inbox.visitor']), 'user');
		fieldIn(root, TEXTS['inbox.search']).value = ' ana ';
		checkIn(root, TEXTS['inbox.waitingOnly']).checked = true;
		await submit(fieldIn(root, TEXTS['inbox.search']));
		expect(Object.fromEntries(new URL(String(server.last('GET /v1/admin/conversations')?.url)).searchParams)).toEqual({
			limit: '25',
			status: 'resolved',
			assigned: 'me',
			waiting: '1',
			visitor: 'user',
			q: 'ana',
		});
		await click(buttonIn(root, TEXTS['inbox.more']));
		expect(server.last('GET /v1/admin/conversations')?.url.searchParams.get('cursor')).toBe('n1');
		expect(textsIn(root, '.conversations li > button')).toEqual(['Ana', TEXTS['inbox.signedIn']]);

		// staff and presence
		const presence = fieldIn(root, TEXTS['inbox.myPresence']);
		expect(presence.value).toBe('online');
		await change(presence, '');
		await change(presence, 'away');
		expect(server.last('PUT /v1/admin/staff/me/presence')?.body).toEqual({ presence: 'away' });
		expect(root.textContent).toContain(TEXTS['inbox.presenceSaved']);
		const maxFields = [...root.querySelectorAll('label')].filter((l) => l.textContent === TEXTS['inbox.maxChats']);
		expect(maxFields).toHaveLength(2);
		const second = /** @type {HTMLInputElement} */ (
			root.getElementById(/** @type {HTMLLabelElement} */ (maxFields[1]).htmlFor)
		);
		expect(second.value).toBe('');
		second.value = '4';
		await submit(second);
		expect(server.last('PATCH /v1/admin/staff/s2')?.body).toEqual({ maxChats: 4 });
		await submit(/** @type {HTMLElement} */ (root.getElementById(/** @type {HTMLLabelElement} */ (maxFields[0]).htmlFor)));
		expect(server.last('PATCH /v1/admin/staff/s1')?.body).toEqual({ maxChats: 2 });

		// open a conversation
		await click(buttonIn(root, 'Ana'));
		expect(server.all('POST /v1/admin/conversations/c1/read')).toHaveLength(1);
		expect(textsIn(root, '.log .who')).toEqual([
			'Ana',
			TEXTS['inbox.ai'],
			'Sam',
			`${TEXTS['inbox.staffMember']} ${TEXTS['inbox.note']}`,
		]);
		expect(root.querySelector('.log li.note img')).not.toBeNull();
		expect(root.querySelector('.log li[data-seq="3"] .seen')?.textContent).toBe(TEXTS['inbox.seen']);
		expect(root.querySelector('.visitor h3')?.textContent).toBe('Ana');
		expect(textsIn(root, '.facts li')).toEqual([
			'Ana',
			'ana@x.co',
			'Mobile',
			'Phone',
			'Product: Phone X',
			'3 conversations',
			'Rating: 4 · ok',
		]);
		expect(fieldIn(root, 'Size').value).toBe('3');
		expect(fieldIn(root, TEXTS['inbox.transcriptEmail']).value).toBe('ana@x.co');
		expect(checkIn(root, TEXTS['inbox.pauseAi']).checked).toBe(true);
		const assign = fieldIn(root, TEXTS['inbox.assign']);
		expect(textsIn(assign, 'option')).toEqual([TEXTS['inbox.unassigned'], 'Sam · Online · Full', 'b@x.co · Away']);
		expect(assign.value).toBe('s1');

		// manage
		await change(fieldIn(root, TEXTS['inbox.status']), 'resolved');
		const statusSelects = [...root.querySelectorAll('.manage select')];
		await change(/** @type {HTMLSelectElement} */ (statusSelects[0]), 'resolved');
		expect(server.last('PATCH /v1/admin/conversations/c1')?.body).toEqual({ status: 'resolved' });
		const pause = checkIn(root, TEXTS['inbox.pauseAi']);
		pause.checked = false;
		pause.dispatchEvent(new window.Event('change'));
		await flush();
		expect(server.last('PATCH /v1/admin/conversations/c1')?.body).toEqual({ aiPaused: false });
		patchAnswer = () => problem(409, 'staff_full');
		await change(assign, 's2');
		expect(server.last('PATCH /v1/admin/conversations/c1')?.body).toEqual({ assignedTo: 's2' });
		expect(root.textContent).toContain(TEXTS['inbox.staffFull']);
		patchAnswer = () => answer(200, { conversation });
		await change(assign, '');
		expect(server.last('PATCH /v1/admin/conversations/c1')?.body).toEqual({ assignedTo: null });
		fieldIn(root, 'Size').value = '5';
		await submit(fieldIn(root, 'Size'));
		expect(server.last('PATCH /v1/admin/conversations/c1')?.body).toEqual({ fields: { size: 5 } });
		patchAnswer = () => problem(403, 'forbidden');
		await submit(fieldIn(root, 'Size'));
		expect(/** @type {HTMLElement} */ (root.querySelector('.manage')).hidden).toBe(true);

		// reply, saved replies, notes
		const box = /** @type {HTMLTextAreaElement} */ (root.querySelector('textarea[aria-label]'));
		const picker = /** @type {HTMLSelectElement} */ (root.querySelector(`select[aria-label="${TEXTS['inbox.savedPick']}"]`));
		await change(picker, 'r1');
		await change(picker, 'r1');
		expect(box.value).toBe('Hello there Hello there');
		box.value = 'Sure';
		await submit(box);
		expect(server.last('POST /v1/admin/conversations/c1/messages')?.body).toEqual({ text: 'Sure' });
		expect(box.value).toBe('');
		await submit(box);
		await click(buttonIn(root, TEXTS['inbox.addNote']));
		expect(server.all('POST /v1/admin/conversations/c1/notes')).toHaveLength(0);
		box.value = 'Note';
		await click(buttonIn(root, TEXTS['inbox.addNote']));
		expect(textsIn(root, '.log li.note p').at(-1)).toBe('Note');

		// saved replies editor
		fieldIn(root, TEXTS['inbox.savedTitle']).value = 'Bye';
		fieldIn(root, TEXTS['inbox.savedText']).value = 'Bye now';
		await submit(fieldIn(root, TEXTS['inbox.savedTitle']));
		expect(server.last('POST /v1/admin/saved-replies')?.body).toEqual({ title: 'Bye', text: 'Bye now' });
		expect(textsIn(picker, 'option')).toEqual([TEXTS['inbox.savedPick'], 'Hello', 'Bye']);
		const savedPart = /** @type {HTMLElement} */ (
			[...root.querySelectorAll('section.part')].find((part) => part.textContent?.startsWith(TEXTS['inbox.savedReplies']))
		);
		await click(buttonIn(savedPart, TEXTS['common.edit']));
		expect(fieldIn(root, TEXTS['inbox.savedTitle']).value).toBe('Hello');
		fieldIn(root, TEXTS['inbox.savedText']).value = 'Hi!';
		await submit(fieldIn(root, TEXTS['inbox.savedTitle']));
		expect(server.last('PUT /v1/admin/saved-replies/r1')?.body).toEqual({ title: 'Hello', text: 'Hi!' });
		saved = [{ id: 'r1', title: 'Hello', text: 'Hi!' }];
		await click(buttonIn(savedPart, TEXTS['common.delete']));
		expect(server.all('DELETE /v1/admin/saved-replies/r1')).toHaveLength(1);

		// context, transcript, rating
		await click(buttonIn(root, TEXTS['inbox.summarise']));
		expect(root.querySelector('.summary')?.textContent).toBe('Wants a phone.');
		await submit(fieldIn(root, TEXTS['inbox.transcriptEmail']));
		expect(server.last('POST /v1/admin/conversations/c1/transcript')?.body).toEqual({ email: 'ana@x.co' });
		expect(root.textContent).toContain(TEXTS['inbox.transcriptSent']);
		await click(buttonIn(root, TEXTS['inbox.askRating']));
		expect(root.textContent).toContain(TEXTS['inbox.ratingAsked']);

		// back-off checks
		extra = [message(7, 'visitor')];
		conversation = { ...conversation, visitorSeenSeq: 5 };
		const reads = server.all('POST /v1/admin/conversations/c1/read').length;
		await time.advance(10_000);
		expect(server.last('GET /v1/admin/conversations/c1')?.url.searchParams.get('after')).toBe('6');
		expect(server.all('POST /v1/admin/conversations/c1/read').length).toBe(reads + 1);
		expect(root.querySelector('.log li[data-seq="5"] .seen')).not.toBeNull();
		expect(unread).toHaveBeenCalledWith(7, 'inbox');

		// failures
		replyAnswer = () => problem(403, 'forbidden');
		box.value = 'x';
		await submit(box);
		expect(root.querySelector('form.part textarea')?.closest('form')?.hidden).toBe(true);
		// an open conversation sits beside the list (or replaces it in a narrow widget) until it is closed
		expect(root.querySelector('.split')?.classList.contains('open')).toBe(true);
		await click(buttonIn(root, TEXTS['inbox.close']));
		expect(root.querySelector('.log')).toBeNull();
		expect(root.querySelector('.split')?.classList.contains('open')).toBe(false);
	});

	it('attaches files to replies', async () => {
		let put = () => answer(500);
		const { server, hosts } = await startAdmin({
			features: ['inbox', 'attachments'],
			settings: { attachments: { types: ['application/pdf'], maxBytes: 1024 } },
			routes: {
				'GET /v1/admin/conversations': () => answer(200, { items: [item()], hasMore: false, unread: 0 }),
				'GET /v1/admin/conversations/c1': () =>
					answer(200, { conversation: full({ context: undefined, rating: null }), messages: [] }),
				'POST /v1/admin/conversations/c1/read': () => problem(500, 'x'),
				'POST /v1/admin/uploads': () =>
					answer(200, {
						upload: { method: 'PUT', url: `${BASE}/bucket/k`, headers: { 'content-type': 'application/pdf' } },
						attachment: { key: 'k', name: 'a.pdf', type: 'application/pdf', size: 3 },
					}),
				'PUT /bucket/k': () => put(),
				'POST /v1/admin/conversations/c1/messages': () =>
					answer(201, {
						message: message(1, 'staff', {
							text: '',
							attachment: { name: 'a.pdf', type: 'application/pdf', size: 3, url: 'https://files.test/a.pdf' },
						}),
					}),
			},
		});
		const root = shadow(hosts.inbox);
		await click(buttonIn(root, 'Ana'));
		const file = /** @type {HTMLInputElement} */ (root.querySelector('input[type="file"]'));
		expect(file.getAttribute('accept')).toBe('application/pdf');
		const clicked = vi.spyOn(file, 'click').mockImplementation(() => {});
		await click(buttonIn(root, TEXTS['inbox.attach']));
		expect(clicked).toHaveBeenCalled();
		await choose(file, null);
		await choose(file, new File(['x'], 'a.png', { type: 'image/png' }));
		expect(root.textContent).toContain(TEXTS['inbox.fileType']);
		const big = new File(['x'], 'b.pdf', { type: 'application/pdf' });
		Object.defineProperty(big, 'size', { value: 2048 });
		await choose(file, big);
		expect(root.textContent).toContain('The file is too big (at most 1 MB).');
		const pdf = new File(['abc'], 'a.pdf', { type: 'application/pdf' });
		await choose(file, pdf);
		expect(root.textContent).toContain(TEXTS['inbox.uploadFailed']);
		put = () => answer(200);
		await choose(file, pdf);
		expect(server.last('POST /v1/admin/conversations/c1/messages')?.body).toEqual({
			text: '',
			attachment: { key: 'k', name: 'a.pdf', type: 'application/pdf', size: 3 },
		});
		expect(root.querySelector('.log a.file')?.textContent).toBe('a.pdf');
		expect(shows(root, TEXTS['inbox.addNote'])).toBe(false);
	});

	it('handles failures, 403s and signing out', async () => {
		const getTicket = vi.fn().mockResolvedValueOnce(ticket()).mockRejectedValueOnce(new Error('signed out'));
		let list = () => problem(403, 'forbidden');
		const { hosts, time, server } = await startAdmin({
			features: ['inbox', 'saved_replies', 'ai_summary', 'context_panel', 'transcripts', 'ratings', 'presence_queue'],
			settings: { ratings: { askWhen: 'manual' } },
			getTicket,
			routes: {
				'GET /v1/admin/staff': () => problem(403, 'forbidden'),
				'GET /v1/admin/saved-replies': () => problem(403, 'forbidden'),
				'GET /v1/admin/conversations': () => list(),
				'GET /v1/admin/conversations/c1': () =>
					answer(200, {
						conversation: full({
							visitor: { kind: 'user', id: 'u1', name: null, email: null, phone: '55' },
							context: { page: { url: 'x' } },
							rating: { score: 2 },
						}),
						messages: [message(1, 'system')],
					}),
				'GET /v1/admin/conversations/c9': () => problem(404, 'not_found'),
				'POST /v1/admin/conversations/c1/read': () => answer(204),
				'POST /v1/admin/conversations/c1/summary': () => problem(500, 'x'),
				'POST /v1/admin/conversations/c1/transcript': () => problem(503, 'notifications_not_connected'),
				'POST /v1/admin/conversations/c1/rating-request': () => problem(403, 'forbidden'),
			},
		});
		const root = shadow(hosts.inbox);
		expect(root.querySelector('.inbox .list-part > .status')?.textContent).toBe(TEXTS['inbox.noAccess']);
		list = () =>
			answer(200, {
				items: [
					item({ id: 'c9' }),
					item({ visitor: { kind: 'user', id: 'u1', name: null, email: null, phone: '55' }, status: 'weird' }),
				],
				hasMore: false,
				unread: 0,
			});
		await submit(fieldIn(root, TEXTS['inbox.search']));
		await click(buttonIn(root, 'Ana'));
		expect(root.textContent).toContain(TEXTS['common.error']);
		await click(buttonIn(root, '55'));
		expect(textsIn(root, '.facts li')).toEqual(['Rating: 2']);
		expect(textsIn(root, '.log .who')).toEqual(['']);
		await click(buttonIn(root, TEXTS['inbox.summarise']));
		expect(root.textContent).toContain(TEXTS['common.error']);
		await submit(fieldIn(root, TEXTS['inbox.transcriptEmail']));
		expect(root.textContent).toContain(TEXTS['inbox.transcriptUnavailable']);
		await click(buttonIn(root, TEXTS['inbox.askRating']));
		expect(shows(root, TEXTS['inbox.askRating'])).toBe(false);
		expect(server.all('GET /v1/admin/conversations/c1')).toHaveLength(1);
		await time.advance(14 * 60_000);
		expect(root.querySelector('.inbox .list-part > .status')?.textContent).toBe(TEXTS['inbox.signedOut']);
		await submit(fieldIn(root, TEXTS['inbox.search']));
		expect(root.querySelector('.inbox .list-part > .status')?.textContent).toBe(TEXTS['inbox.signedOut']);
	});
});

describe('knowledge editor', () => {
	it('searches, adds, changes and deletes entries and website pages', async () => {
		/** @type {any[]} */
		let entries = [{ id: 'e1', kind: 'faq', title: 'Returns?', text: '30 days', updatedAt: AT }];
		let save = () => answer(201, { entry: {} });
		const pages = [
			{ id: 'p1', url: 'https://shop.test/about', title: 'About', status: 'ok', error: null, fetchedAt: AT },
			{ id: 'p2', url: 'bad url', title: '', status: 'failed', error: 'Timeout', fetchedAt: null },
		];
		let fetchAgain = () => problem(500, 'x');
		const { server, hosts } = await startAdmin({
			features: ['knowledge_editor', 'knowledge_pages'],
			routes: {
				'GET /v1/admin/knowledge/entries': (call) =>
					answer(200, {
						items: call.url.searchParams.get('cursor')
							? [{ id: 'e2', kind: 'other', title: 'More', text: '', updatedAt: AT }]
							: entries,
						nextCursor: 'k2',
						hasMore: !call.url.searchParams.get('cursor'),
					}),
				'POST /v1/admin/knowledge/entries': () => save(),
				'PUT /v1/admin/knowledge/entries/e1': () => answer(200, { entry: {} }),
				'DELETE /v1/admin/knowledge/entries/e1': () => answer(204),
				'GET /v1/admin/knowledge/pages': () => answer(200, { items: pages }),
				'POST /v1/admin/knowledge/pages': () => answer(201, { page: {} }),
				'POST /v1/admin/knowledge/pages/p1/fetch': () => fetchAgain(),
				'DELETE /v1/admin/knowledge/pages/p2': () => answer(204),
			},
		});
		const root = shadow(hosts.knowledge);
		expect(textsIn(root, 'ul:first-of-type > li > .meta')[0]).toContain(TEXTS['knowledge.faq']);
		await click(buttonIn(root, TEXTS['knowledge.more']));
		expect(server.last('GET /v1/admin/knowledge/entries')?.url.searchParams.get('cursor')).toBe('k2');
		fieldIn(root, TEXTS['knowledge.search']).value = 'ret';
		await submit(fieldIn(root, TEXTS['knowledge.search']));
		expect(server.last('GET /v1/admin/knowledge/entries')?.url.searchParams.get('q')).toBe('ret');

		// add
		await change(fieldIn(root, TEXTS['knowledge.kind']), 'article');
		fieldIn(root, TEXTS['knowledge.entryTitle']).value = 'Shipping';
		fieldIn(root, TEXTS['knowledge.entryText']).value = 'Two days';
		save = () => problem(422, 'validation_failed', { errors: [{ message: 'Too long' }] });
		await submit(fieldIn(root, TEXTS['knowledge.entryTitle']));
		expect(root.textContent).toContain('Too long');
		save = () => answer(201, { entry: {} });
		await submit(fieldIn(root, TEXTS['knowledge.entryTitle']));
		expect(server.last('POST /v1/admin/knowledge/entries')?.body).toEqual({
			kind: 'article',
			title: 'Shipping',
			text: 'Two days',
		});
		expect(root.textContent).toContain(TEXTS['knowledge.saved']);

		// edit and cancel
		await click(buttonIn(root, TEXTS['common.edit']));
		expect(root.textContent).toContain(TEXTS['knowledge.edit']);
		await click(buttonIn(root, TEXTS['knowledge.cancel']));
		expect(fieldIn(root, TEXTS['knowledge.entryTitle']).value).toBe('');
		await click(buttonIn(root, TEXTS['common.edit']));
		fieldIn(root, TEXTS['knowledge.entryText']).value = '60 days';
		await submit(fieldIn(root, TEXTS['knowledge.entryTitle']));
		expect(server.last('PUT /v1/admin/knowledge/entries/e1')?.body).toEqual({
			kind: 'faq',
			title: 'Returns?',
			text: '60 days',
		});

		// delete with confirmation
		const entryList = /** @type {HTMLElement} */ (root.querySelector('ul'));
		await click(buttonIn(entryList, TEXTS['common.delete']));
		expect(server.all('DELETE /v1/admin/knowledge/entries/e1')).toHaveLength(0);
		entries = [];
		await click(buttonIn(entryList, TEXTS['knowledge.confirmDelete']));
		expect(server.all('DELETE /v1/admin/knowledge/entries/e1')).toHaveLength(1);
		expect(root.textContent).toContain(TEXTS['knowledge.empty']);

		// pages
		const pageList = /** @type {HTMLElement} */ ([...root.querySelectorAll('section.part')].at(-1));
		expect(pageList.querySelector('a')?.getAttribute('href')).toBe('https://shop.test/about');
		expect(pageList.textContent).toContain('Could not be fetched: Timeout');
		const fetchButtons = [...pageList.querySelectorAll('button')].filter((b) => b.textContent === TEXTS['knowledge.pageFetch']);
		await click(/** @type {HTMLElement} */ (fetchButtons[0]));
		expect(pageList.textContent).toContain(TEXTS['common.error']);
		fetchAgain = () => answer(200, { page: {} });
		await click(
			/** @type {HTMLElement} */ (
				[...pageList.querySelectorAll('button')].find((b) => b.textContent === TEXTS['knowledge.pageFetch'])
			),
		);
		expect(pageList.textContent).toContain(TEXTS['knowledge.pageFetchedNow']);
		const deletes = [...pageList.querySelectorAll('button')].filter((b) => b.textContent === TEXTS['common.delete']);
		await click(/** @type {HTMLElement} */ (deletes[0]));
		expect(pageList.textContent).toContain(TEXTS['common.error']);
		await click(
			/** @type {HTMLElement} */ (
				[...pageList.querySelectorAll('button')].filter((b) => b.textContent === TEXTS['common.delete'])[1]
			),
		);
		expect(server.all('DELETE /v1/admin/knowledge/pages/p2')).toHaveLength(1);
		fieldIn(root, TEXTS['knowledge.pageUrl']).value = 'https://shop.test/faq';
		await submit(fieldIn(root, TEXTS['knowledge.pageUrl']));
		expect(server.last('POST /v1/admin/knowledge/pages')?.body).toEqual({ url: 'https://shop.test/faq' });
		expect(pageList.textContent).toContain(TEXTS['knowledge.pageAdded']);
	});

	it('hides what the ticket does not allow and shows Signed out', async () => {
		const getTicket = vi.fn().mockResolvedValueOnce(ticket()).mockResolvedValueOnce(null);
		let pages = () => problem(403, 'forbidden');
		const { hosts, time } = await startAdmin({
			features: ['knowledge_editor', 'knowledge_pages'],
			getTicket,
			routes: {
				'GET /v1/admin/knowledge/entries': () => problem(403, 'forbidden'),
				'GET /v1/admin/knowledge/pages': () => pages(),
				'POST /v1/admin/knowledge/pages': () => problem(500, 'x'),
			},
		});
		const root = shadow(hosts.knowledge);
		expect(root.textContent).toContain(TEXTS['knowledge.noAccess']);
		expect(/** @type {HTMLElement} */ ([...root.querySelectorAll('form.part')][0]).hidden).toBe(true);
		expect(/** @type {HTMLElement} */ ([...root.querySelectorAll('section.part')].at(-1)).hidden).toBe(true);
		pages = () => problem(500, 'x');
		await time.advance(14 * 60_000);
		expect(root.querySelector('[role="status"]')?.textContent).toBe(TEXTS['knowledge.signedOut']);
		fieldIn(root, TEXTS['knowledge.pageUrl']).value = 'https://shop.test/faq';
		await submit(fieldIn(root, TEXTS['knowledge.pageUrl']));
		expect(root.textContent).toContain(TEXTS['knowledge.signedOut']);
	});
});

describe('reports', () => {
	it('shows the last 30 days by default and the numbers', async () => {
		let report = () =>
			answer(200, {
				from: '2026-09-02',
				to: '2026-10-01',
				timeZone: 'Europe/Berlin',
				days: [
					{ date: '2026-09-30', conversations: 2 },
					{ date: '2026-10-01', conversations: 4 },
				],
				visitorMessages: 12,
				aiOnly: 3,
				handedOff: 3,
				medianFirstReplySeconds: 95,
				resolved: 5,
				rating: { average: 4.25, count: 4 },
				leads: 1,
				aiTokens: 12000,
			});
		const { hosts, server } = await startAdmin({
			features: ['reports'],
			routes: { 'GET /v1/admin/reports': () => report() },
		});
		const root = shadow(hosts.reports);
		const query = server.last('GET /v1/admin/reports')?.url.searchParams;
		expect(query?.get('to')).toBe(fieldIn(root, TEXTS['reports.to']).value);
		expect(Date.parse(String(query?.get('to'))) - Date.parse(String(query?.get('from')))).toBe(29 * 86_400_000);
		const numbers = Object.fromEntries(textsIn(root, 'dt').map((label, index) => [label, textsIn(root, 'dd')[index]]));
		expect(numbers[TEXTS['reports.conversations']]).toBe('6');
		expect(numbers[TEXTS['reports.firstReply']]).toBe('1 min 35 s');
		expect(numbers[TEXTS['reports.rating']]).toBe('4.3 from 4 ratings');
		expect(/** @type {HTMLElement} */ (root.querySelector('.bar')).style.width).toBe('50%');
		expect(root.textContent).toContain('Days in Europe/Berlin');
		report = () => answer(200, { days: null, medianFirstReplySeconds: 40, rating: null });
		fieldIn(root, TEXTS['reports.from']).value = '2026-01-01';
		await submit(fieldIn(root, TEXTS['reports.from']));
		expect(server.last('GET /v1/admin/reports')?.url.searchParams.get('from')).toBe('2026-01-01');
		const again = textsIn(root, 'dd');
		expect(again[0]).toBe('0');
		expect(again[1]).toBe(TEXTS['reports.none']);
		expect(again[4]).toBe('40 s');
		expect(again[6]).toBe(TEXTS['reports.none']);
		report = () => answer(200, { days: [], medianFirstReplySeconds: null });
		await submit(fieldIn(root, TEXTS['reports.from']));
		expect(textsIn(root, 'dd')[4]).toBe(TEXTS['reports.none']);
		report = () => problem(422, 'validation_failed', { detail: 'Range too long' });
		await submit(fieldIn(root, TEXTS['reports.from']));
		expect(root.textContent).toContain('Range too long');
		expect(textsIn(root, 'dd')).toEqual([]);
		report = () => problem(500, 'x');
		await submit(fieldIn(root, TEXTS['reports.from']));
		expect(root.querySelector('[role="status"]')?.textContent).toBe(TEXTS['common.error']);
	});

	it('shows no access and Signed out', async () => {
		const getTicket = vi.fn().mockResolvedValueOnce(ticket()).mockRejectedValueOnce(new Error('x'));
		const { hosts, time } = await startAdmin({
			features: ['reports'],
			getTicket,
			routes: { 'GET /v1/admin/reports': () => problem(403, 'forbidden') },
		});
		const root = shadow(hosts.reports);
		expect(root.querySelector('[role="status"]')?.textContent).toBe(TEXTS['reports.noAccess']);
		await time.advance(14 * 60_000);
		await submit(fieldIn(root, TEXTS['reports.from']));
		expect(root.querySelector('[role="status"]')?.textContent).toBe(TEXTS['reports.signedOut']);
	});
});

describe('context panel shop info', () => {
	/** @param {unknown} shop */
	const open = async (shop) => {
		const { hosts } = await startAdmin({
			features: ['inbox', 'context_panel'],
			routes: {
				'GET /v1/admin/conversations': () => answer(200, { items: [item()], hasMore: false, unread: 0 }),
				'GET /v1/admin/conversations/c1': () =>
					answer(200, { conversation: full({ context: { ...full().context, shop } }), messages: [] }),
				'POST /v1/admin/conversations/c1/read': () => answer(204),
			},
		});
		const root = shadow(hosts.inbox);
		await click(buttonIn(root, 'Ana'));
		return root;
	};

	it('shows the signed-in visitor’s last orders with status and total, and loyalty points', async () => {
		const root = await open({
			orders: [
				{ number: 'A-1001', status: 'On its way', total: 'PKR 1,250.00', createdAt: null },
				{ number: 'A-1000', status: 'Delivered', total: 'PKR 99.00', createdAt: AT },
			],
			loyaltyPoints: 120,
		});
		expect(root.querySelector('.shop')?.hasAttribute('hidden')).toBe(false);
		expect(textsIn(root, '.shop li')).toEqual([
			'A-1001 · On its way · PKR 1,250.00',
			'A-1000 · Delivered · PKR 99.00',
			'Loyalty points: 120',
		]);
		expect(root.textContent).toContain(TEXTS['inbox.orders']);
	});

	it('says there are no orders yet, and shows nothing without shop info', async () => {
		const empty = await open({ orders: [], loyaltyPoints: null });
		expect(textsIn(empty, '.shop li')).toEqual([TEXTS['inbox.noOrders']]);
		resetPage();
		const none = await open(null);
		expect(none.querySelector('.shop')?.hasAttribute('hidden')).toBe(true);
		expect(textsIn(none, '.shop li')).toEqual([]);
	});
});
