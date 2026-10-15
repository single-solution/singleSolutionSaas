// @vitest-environment jsdom
/**
 * Settings → the merchant's own lists in the browser (jsdom), on a faked dashboard API (fixed-choices N2, N6, N7): add,
 * rename, reorder and remove rows, saved whole with `PUT …/lists/<name>`, and a refused save shown by row.
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { byLabel, byText, cleanup, click, render, type } from '@ss/ui/testing';
import { FallbackChainsCard, MerchantLists, QuietHoursCard, TopicsCard } from '../app/dashboard/lists.js';
import { TEXTS } from '../app/dashboard/texts.js';

const WEBSITE = 'web_lists';
const BASE = `/v1/dashboard/websites/${WEBSITE}/lists`;
const L = TEXTS.settings.lists;

/** @type {Array<{ path: string, method: string, body: any }>} */
let calls = [];
/**
 * Serve the lists: each GET answers its value; a PUT answers what `answer` says.
 * @param {Record<string, unknown[]>} lists
 * @param {(body: any) => { status: number, body: unknown }} [answer]
 */
const serve = (lists, answer = (body) => ({ status: 200, body })) => {
	calls = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (/** @type {string} */ path, /** @type {RequestInit} */ init = {}) => {
			const body = init.body ? JSON.parse(String(init.body)) : undefined;
			calls.push({ path, method: init.method ?? 'GET', body });
			const name = path.slice(BASE.length + 1);
			const reply = init.method === 'PUT' ? answer(body) : { status: 200, body: { value: lists[name] ?? [] } };
			return new Response(JSON.stringify(reply.body), {
				status: reply.status,
				headers: { 'content-type': 'application/json' },
			});
		}),
	);
};
const settle = async () => {
	for (let i = 0; i < 6; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};
const puts = () => calls.filter((call) => call.method === 'PUT');

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('unsubscribe topics', () => {
	it('adds, renames, reorders and removes topics, then saves the list whole', async () => {
		serve({ topics: [{ id: 'promotions', name: 'Promotions' }] });
		const { container } = render(<TopicsCard websiteId={WEBSITE} off={false} />);
		await settle();
		expect(container.textContent).toContain('Id: promotions (kept when you rename it)');
		await click(byText(container, L.add, 'button'));
		await type(byLabel(container, 'Topic 2'), 'Back in stock');
		await type(byLabel(container, 'Topic 1'), 'Deals');
		// Back in stock first
		await click(/** @type {Element} */ ([...container.querySelectorAll('button')].filter((b) => b.textContent === L.up)[1]));
		await click(byText(container, TEXTS.save, 'button'));
		await settle();
		expect(puts()[0]).toEqual({
			path: `${BASE}/topics`,
			method: 'PUT',
			body: { value: [{ name: 'Back in stock' }, { id: 'promotions', name: 'Deals' }] },
		});
		// remove one
		await click(/** @type {Element} */ ([...container.querySelectorAll('button')].find((b) => b.textContent === L.remove)));
		await click(byText(container, TEXTS.save, 'button'));
		await settle();
		expect(puts()).toHaveLength(2);
	});

	it('shows a refused save by row', async () => {
		serve({ topics: [] }, () => ({
			status: 422,
			body: { type: 'validation_failed', title: 'x', errors: [{ path: '/value/0/name', message: 'Name the topic.' }] },
		}));
		const { container } = render(<TopicsCard websiteId={WEBSITE} off={false} />);
		await settle();
		await click(byText(container, L.add, 'button'));
		await click(byText(container, TEXTS.save, 'button'));
		await settle();
		expect(container.textContent).toContain('Row 1: Name the topic.');
	});
});

describe('fallback channels and quiet hours', () => {
	it('keeps the order the channels are picked in', async () => {
		serve({ fallback_chains: [] });
		const { container } = render(<FallbackChainsCard websiteId={WEBSITE} off={false} />);
		await settle();
		await click(byText(container, L.add, 'button'));
		await click(byLabel(container, 'Email'));
		await click(byLabel(container, 'SMS'));
		expect(container.textContent).toContain('In this order: Email → SMS');
		await click(byText(container, TEXTS.save, 'button'));
		await settle();
		expect(puts()[0]?.body).toEqual({ value: [{ channel: 'whatsapp', then: ['email', 'sms'] }] });
	});

	it('edits a quiet window: days, times and channels', async () => {
		serve({ quiet_hours: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '21:00', until: '08:00', channels: [] }] });
		const { container } = render(<QuietHoursCard websiteId={WEBSITE} off={false} />);
		await settle();
		await click(byLabel(container, 'Sunday'));
		await type(byLabel(container, L.quiet.from), '22:30');
		await click(byLabel(container, 'SMS'));
		await click(byText(container, TEXTS.save, 'button'));
		await settle();
		expect(puts()[0]?.body).toEqual({
			value: [{ days: [1, 2, 3, 4, 5, 6], from: '22:30', until: '08:00', channels: ['sms'] }],
		});
	});

	it('shows each list while one of its features is listed', async () => {
		serve({});
		const { container } = render(
			<MerchantLists
				websiteId={WEBSITE}
				features={[
					{ key: 'email', on: true },
					{ key: 'quiet_hours', on: false },
				]}
			/>,
		);
		await settle();
		expect(container.textContent).toContain(L.topics.title);
		expect(container.textContent).toContain(L.templates.title);
		expect(container.textContent).toContain(L.quiet.title);
		expect(container.textContent).not.toContain(L.fallback.title);
	});
});
