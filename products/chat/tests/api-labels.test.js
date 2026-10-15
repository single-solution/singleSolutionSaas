/**
 * Conversation tags, topics and priorities through the API (C7): the merchant's lists (priorities seeded), staff set
 * them on a conversation (inbox and server API, with an activity-log entry), the inbox filters by them, reports count
 * by them, and AI tagging (an inbox setting) picks only keys of the lists when a chat is handed to a person.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { AI_KEY, ready } from './helpers.js';

/** @type {Array<Awaited<ReturnType<typeof ready>>>} */
const systems = [];
afterAll(async () => {
	for (const sys of systems) await sys.product.close();
});
/** @param {string[]} on */
const start = async (on) => {
	const sys = await ready(on);
	systems.push(sys);
	return sys;
};

const ON = ['visitor_chat', 'guest_chat', 'ai_replies', 'inbox', 'handoff', 'reports'];
const TAGS = [
	{ key: 'vip', name: 'VIP', description: 'A repeat customer' },
	{ key: 'refund', name: 'Refund', description: 'Asks for money back' },
];
const TOPICS = [
	{ key: 'billing', name: 'Billing', description: 'Payments and invoices' },
	{ key: 'delivery', name: 'Delivery', description: 'Where an order is' },
];

describe('tags, topics and priorities (C7)', () => {
	it('staff set them, the inbox filters by them, reports count them', async () => {
		const sys = await start(ON);
		expect((await sys.serverCall('GET', '/v1/lists/priorities')).json.value.map((/** @type {any} */ p) => p.key)).toEqual([
			'urgent',
			'high',
			'normal',
			'low',
		]);
		await sys.list('tags', TAGS);
		await sys.list('topics', TOPICS);
		const ann = sys.visitor();
		const bob = sys.visitor();
		await ann('POST', '/v1/chat/messages', { text: 'Where is my invoice?' });
		await bob('POST', '/v1/chat/messages', { text: 'Where is my parcel?' });
		const ticket = await sys.ticket();
		const items = (await sys.admin(ticket, 'GET', '/v1/admin/conversations')).json.items;
		const [second, first] = items;
		expect(first).toMatchObject({ tags: [], topic: null, priority: null });

		const set = await sys.admin(ticket, 'PATCH', `/v1/admin/conversations/${first.id}`, {
			tags: ['vip', 'refund'],
			topic: 'billing',
			priority: 'high',
		});
		expect(set.status).toBe(200);
		expect(set.json.conversation).toMatchObject({ tags: ['vip', 'refund'], topic: 'billing', priority: 'high' });
		// only the merchant's keys
		expect((await sys.admin(ticket, 'PATCH', `/v1/admin/conversations/${first.id}`, { tags: ['angry'] })).status).toBe(422);
		expect((await sys.admin(ticket, 'PATCH', `/v1/admin/conversations/${first.id}`, { topic: 'nope' })).status).toBe(422);
		await sys.serverCall('PATCH', `/v1/conversations/${second.id}`, { topic: 'delivery', tags: ['vip'] });

		// the inbox's filters and counts
		const byTag = (await sys.admin(ticket, 'GET', '/v1/admin/conversations?tag=vip')).json.items;
		expect(byTag.map((/** @type {any} */ c) => c.id).sort()).toEqual([first.id, second.id].sort());
		const byTopic = (await sys.admin(ticket, 'GET', '/v1/admin/conversations?topic=billing')).json.items;
		expect(byTopic.map((/** @type {any} */ c) => c.id)).toEqual([first.id]);
		expect((await sys.admin(ticket, 'GET', '/v1/admin/conversations?priority=high')).json.items).toHaveLength(1);
		expect((await sys.serverCall('GET', '/v1/conversations/count?tag=refund')).json).toMatchObject({ count: 1 });
		const counts = await sys.serverCall('GET', '/v1/conversations/counts?by=topic');
		expect(counts.json).toEqual({ total: 2, groups: { billing: 1, delivery: 1 } });

		// an activity-log entry in the lists' words
		const log = (await sys.serverCall('GET', '/v1/activity?action=conversation.labels_changed')).json.items;
		expect(log.map((/** @type {any} */ e) => e.detail)).toContain('Tags: VIP, Refund; Topic: Billing; Priority: High');

		// reports by tag, topic and priority, in the lists' order
		const report = (await sys.serverCall('GET', '/v1/reports')).json;
		expect(report.tags).toEqual([
			{ key: 'vip', name: 'VIP', conversations: 2 },
			{ key: 'refund', name: 'Refund', conversations: 1 },
		]);
		expect(report.topics).toEqual([
			{ key: 'billing', name: 'Billing', conversations: 1 },
			{ key: 'delivery', name: 'Delivery', conversations: 1 },
		]);
		expect(report.priorities[1]).toEqual({ key: 'high', name: 'High', conversations: 1 });

		// the admin widgets get the lists; visitors never do
		const adminConfig = await sys.admin(ticket, 'GET', '/v1/widget/admin/config');
		expect(adminConfig.json.settings.labels.tags).toEqual(TAGS);
		const visitorConfig = await sys.call('GET', '/v1/widget/config', {
			token: sys.browser,
			origin: 'https://shop.example.com',
		});
		expect(visitorConfig.json.settings.labels).toBeUndefined();
	});

	it('AI tagging picks only the merchant’s keys, and never overrides what staff set', async () => {
		const sys = await start(ON);
		await sys.connect('ai', AI_KEY);
		await sys.list('tags', TAGS);
		await sys.list('topics', TOPICS);
		await sys.setting('inbox', 'aiTagging', true);
		await sys.setting('handoff', 'askPhrases', ['human']);
		const v = sys.visitor();
		sys.ai({ text: 'Let me check.' });
		await v('POST', '/v1/chat/messages', { text: 'I was charged twice' });
		// staff already chose the priority: the AI leaves it
		const [open] = (await sys.serverCall('GET', '/v1/conversations')).json.items;
		await sys.serverCall('PATCH', `/v1/conversations/${open.id}`, { priority: 'low' });
		sys.ai({ text: '{"topic": "billing", "tags": ["refund", "angry"], "priority": "urgent"}' });
		await v('POST', '/v1/chat/messages', { text: 'human please' });
		const ticket = await sys.ticket();
		const [c] = (await sys.admin(ticket, 'GET', '/v1/admin/conversations')).json.items;
		expect(c).toMatchObject({ topic: 'billing', tags: ['refund'], priority: 'low' });
		const prompt = sys.aiCalls().at(-1).messages[0].content;
		expect(prompt).toContain('- refund: Refund — Asks for money back');
	});
});
