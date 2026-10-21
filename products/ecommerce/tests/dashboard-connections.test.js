// @vitest-environment jsdom
/**
 * Connections on the shared dashboard tab with Ecommerce's forms and hints: each courier API connection (`courier_1` …
 * `courier_5`, E25) takes the courier form (booking and tracking addresses, key, headers, body) and the courier hint;
 * the database, the storage, the AI key and the links to other products are the Portal's: a note, no form.
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, click, render } from '@ss/ui/testing';
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
	it('a courier API connection takes the courier form and hint; the storage, the AI key and a link are the Portal’s: a note, no form', async () => {
		const answer = {
			connections: [
				connection('courier_2', 'secret'),
				{ ...connection('storage', 'storage'), managed: true },
				{ ...connection('ai', 'secret'), managed: true },
				{ ...connection('link_accounts', 'link'), managed: true },
			],
		};
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(JSON.stringify(answer), { status: 200 })),
		);
		const Connections = TABS.connections;
		const { container } = render(inDashboard(<Connections {...props} />));
		const settle = async () => {
			for (let i = 0; i < 4; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
		};
		await settle();
		// one connection per row of the list: open each
		for (const name of ['courier_2', 'storage', 'ai', 'link_accounts']) {
			click(/** @type {HTMLElement} */ (container.querySelector(`[role="option"][data-ss-id="connection-${name}"]`)));
			await settle();
		}
		const courier = container.querySelector('[id="section-connection-courier_2"]')?.textContent ?? '';
		expect(courier).toContain(TEXTS.connections.fields.bookUrl);
		expect(courier).toContain(TEXTS.connections.fields.trackingPath);
		expect(courier).toContain(TEXTS.connections.hints.courier);
		// the storage, the AI key and the links to other products are set in the Portal: a note and a link, no field to type in
		for (const name of ['storage', 'ai', 'link_accounts']) {
			const section = container.querySelector(`[id="section-connection-${name}"]`);
			expect(section?.textContent).not.toContain('Bucket');
			expect(section?.textContent).not.toContain('Model');
			expect(section?.querySelector('input')).toBeNull();
			expect(section?.querySelector('a[href*="/settings#"]')).not.toBeNull();
		}
	});
});
