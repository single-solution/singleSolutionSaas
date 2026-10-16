// @vitest-environment jsdom
/**
 * Connections on the shared dashboard tab with Ecommerce's forms and hints: each courier API connection (`courier_1` …
 * `courier_5`, E25) takes the courier form (booking and tracking addresses, key, headers, body) and the courier hint;
 * storage and the AI key their own forms; a token connection the one value field.
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@ss/ui/testing';
import { TABS } from '../app/dashboard/tabs.js';
import { TEXTS } from '../app/dashboard/texts.js';
import { inDashboard } from './dashboard-provider.js';

const WEBSITE = 'web_1';

const props = {
	websiteId: WEBSITE,
	domain: 'shop.example.com',
	who: /** @type {const} */ ({ kind: 'admin', id: 'a_1', name: 'Admin', role: 'owner' }),
	support: { channels: [] },
	portal: 'https://portal.example.com',
	open: () => undefined,
};

/** @param {string} name @param {string} kind */
const connection = (name, kind) => ({ name, label: name, kind, neededBy: [], status: 'not_connected' });

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe('Ecommerce’s connection forms', () => {
	it('a courier API connection takes the courier form and hint; a token the one value field', async () => {
		const answer = {
			connections: [connection('courier_2', 'secret'), connection('storage', 'storage'), connection('accounts', 'token')],
		};
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(JSON.stringify(answer), { status: 200 })),
		);
		const Connections = TABS.connections;
		const { container } = render(inDashboard(<Connections {...props} />));
		for (let i = 0; i < 4; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
		const cards = [...container.querySelectorAll('section, article, [class*="card"]')].filter((node) =>
			node.textContent?.startsWith('courier_2'),
		);
		const courier = cards.at(-1)?.textContent ?? '';
		expect(courier).toContain(TEXTS.connections.fields.bookUrl);
		expect(courier).toContain(TEXTS.connections.fields.trackingPath);
		expect(courier).toContain(TEXTS.connections.hints.courier);
		const text = container.textContent ?? '';
		expect(text).toContain(TEXTS.connections.fields.bucket);
		expect(text).toContain(TEXTS.connections.token);
	});
});
