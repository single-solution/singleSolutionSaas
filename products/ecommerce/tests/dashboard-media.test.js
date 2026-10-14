// @vitest-environment jsdom
/**
 * The dashboard's setup prompt for the public address of the images (SEO audit G1): once storage is connected, Overview
 * asks for the catalog setting mediaBaseUrl until it is set (images then keep one address, browsers keep them), with a
 * link to the settings; nothing while storage is not connected.
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@ss/ui/testing';
import { TABS } from '../app/dashboard/tabs.js';

const WEBSITE = 'web_1';
const BASE = `/v1/dashboard/websites/${WEBSITE}`;

/**
 * The overview's loads.
 * @param {{ storage: string, mediaBaseUrl: string }} state
 */
const serve = ({ storage, mediaBaseUrl }) => {
	/** @type {Record<string, unknown>} */
	const answers = {
		[`${BASE}/overview`]: {
			status: { status: 'active', graceEndsAt: null },
			featuresOn: ['catalog'],
			todayMillicredits: 0,
			checklist: {
				connections: [{ name: 'storage', label: 'Storage', neededBy: ['catalog'], status: storage, testedAt: null }],
				widget: null,
				business: { found: true },
			},
			recentChanges: [],
		},
		[`${BASE}/connections`]: { connections: [] },
		[`${BASE}/settings`]: { features: [{ key: 'catalog', on: true, values: { mediaBaseUrl: { value: mediaBaseUrl } } }] },
	};
	vi.stubGlobal(
		'fetch',
		vi.fn(async (/** @type {string} */ path) =>
			path in answers
				? new Response(JSON.stringify(answers[path]), { status: 200 })
				: new Response(JSON.stringify({ status: 404, title: 'Not found' }), { status: 404 }),
		),
	);
};

const settle = async () => {
	for (let i = 0; i < 6; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};

const props = {
	websiteId: WEBSITE,
	who: /** @type {const} */ ({ kind: 'merchant', id: 'm_1', name: 'Merchant' }),
	support: { email: 'help@example.com', phone: '' },
	portal: 'https://portal.example.com',
};

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe('Overview: the public address of the images', () => {
	it('asks for it once storage is connected, with a link to the settings', async () => {
		serve({ storage: 'connected', mediaBaseUrl: '' });
		const Overview = TABS.overview;
		const { container } = render(<Overview {...props} />);
		await settle();
		const text = container.textContent ?? '';
		expect(text).toContain('Public address of your images');
		expect(text).toContain('Not set');
		expect(text).toContain('Set it in Settings → Catalog right after connecting storage');
		const link = [...container.querySelectorAll('a')].find((node) => node.textContent === 'Set it');
		expect(link?.getAttribute('href')).toBe(`?websiteId=${WEBSITE}&view=settings`);
	});

	it('shows the address once set, and nothing before storage is connected', async () => {
		serve({ storage: 'connected', mediaBaseUrl: 'https://cdn.shop.example.com' });
		const Overview = TABS.overview;
		const set = render(<Overview {...props} />);
		await settle();
		expect(set.container.textContent).toContain('Public address of your imageshttps://cdn.shop.example.comSet');
		expect(set.container.textContent).not.toContain('Not set');
		cleanup();
		serve({ storage: 'not_connected', mediaBaseUrl: '' });
		const before = render(<Overview {...props} />);
		await settle();
		expect(before.container.textContent).not.toContain('Public address of your images');
	});
});
