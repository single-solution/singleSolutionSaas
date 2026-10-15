/**
 * Conversation tags, topics and priorities (C7): the merchant's lists, what staff set on a conversation, AI tagging
 * that may only pick the merchant's keys, and the counts reports show.
 */
import { describe, expect, it } from 'vitest';
import {
	PRIORITY_SEED,
	checkLabeled,
	checkPriorities,
	checkTags,
	labelCounts,
	labeledDetail,
	parseTagging,
	taggingPrompt,
} from '../core/labels.js';

const LABELS = {
	tags: [
		{ key: 'vip', name: 'VIP', description: 'A repeat customer' },
		{ key: 'refund', name: 'Refund', description: '' },
	],
	topics: [
		{ key: 'billing', name: 'Billing', description: 'Payments and invoices' },
		{ key: 'delivery', name: 'Delivery', description: '' },
	],
	priorities: [...PRIORITY_SEED],
};

describe('tags, topics and priorities (C7)', () => {
	it('seeds four priorities, most urgent first; checks each list', () => {
		expect(PRIORITY_SEED.map((p) => p.key)).toEqual(['urgent', 'high', 'normal', 'low']);
		expect(checkPriorities([...PRIORITY_SEED]).ok).toBe(true);
		expect(checkTags([{ key: 'vip', name: ' VIP ' }])).toEqual({
			ok: true,
			value: [{ key: 'vip', name: 'VIP', description: '' }],
		});
		expect(checkTags([{ key: 'VIP', name: 'VIP' }]).ok).toBe(false);
		expect(checkTags([{ key: 'vip', name: '' }]).ok).toBe(false);
		expect(checkPriorities(Array.from({ length: 11 }, (_, i) => ({ key: `p${i}`, name: 'P' }))).ok).toBe(false);
	});

	it('takes only keys of the lists from staff; null clears', () => {
		expect(checkLabeled({ tags: ['vip', 'vip', 'refund'], topic: 'billing', priority: null }, LABELS)).toEqual({
			ok: true,
			value: { tags: ['vip', 'refund'], topic: 'billing', priority: null },
		});
		expect(checkLabeled({ tags: ['angry'] }, LABELS).ok).toBe(false);
		expect(checkLabeled({ topic: 'other' }, LABELS).ok).toBe(false);
		expect(checkLabeled({ priority: 3 }, LABELS).ok).toBe(false);
		expect(checkLabeled({}, LABELS)).toEqual({ ok: true, value: {} });
		expect(labeledDetail({ tags: ['vip'], priority: 'high' }, LABELS)).toBe('Tags: VIP; Priority: High');
		expect(labeledDetail({ tags: [], topic: null }, LABELS)).toBe('Tags: none; Topic: none');
	});

	it('the AI picks only from the lists: anything else is dropped', () => {
		const prompt = taggingPrompt(LABELS);
		expect(prompt).toContain('- billing: Billing — Payments and invoices');
		expect(prompt).toContain('never invent one');
		expect(parseTagging('Sure: {"topic": "billing", "tags": ["vip", "angry", "vip"], "priority": "critical"}', LABELS)).toEqual(
			{ topic: 'billing', tags: ['vip'], priority: null },
		);
		expect(parseTagging('no idea', LABELS)).toBeNull();
		expect(parseTagging('{"topic": ', LABELS)).toBeNull();
	});

	it('counts conversations by tag, topic and priority in the lists’ order', () => {
		const rows = [
			{ tags: ['vip'], topic: 'billing', priority: 'high' },
			{ tags: ['vip', 'refund'], topic: 'billing', priority: null },
			{ topic: null },
		];
		expect(labelCounts(rows, LABELS)).toEqual({
			tags: [
				{ key: 'vip', name: 'VIP', conversations: 2 },
				{ key: 'refund', name: 'Refund', conversations: 1 },
			],
			topics: [
				{ key: 'billing', name: 'Billing', conversations: 2 },
				{ key: 'delivery', name: 'Delivery', conversations: 0 },
			],
			priorities: [
				{ key: 'urgent', name: 'Urgent', conversations: 0 },
				{ key: 'high', name: 'High', conversations: 1 },
				{ key: 'normal', name: 'Normal', conversations: 0 },
				{ key: 'low', name: 'Low', conversations: 0 },
			],
		});
	});
});
