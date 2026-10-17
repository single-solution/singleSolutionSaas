// @vitest-environment jsdom
/**
 * The dashboard's setup prompt for the public address of the images (SEO audit G1): once storage is connected, Overview
 * asks for the catalog setting mediaBaseUrl in Needs you until it is set (images then keep one address, browsers keep
 * them), with a button to the settings, and ticks it in the setup list once set; nothing while storage is not
 * connected.
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@ss/ui/testing';
import { TABS } from '../app/dashboard/tabs.js';
import { inDashboard } from './dashboard-provider.js';

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
			website: { domain: 'shop.example.com' },
			status: { status: 'active', graceEndsAt: null },
			featuresOn: ['catalog'],
			todayMillicredits: 0,
			checklist: {
				connections: [{ name: 'storage', label: 'Storage', neededBy: ['catalog'], status: storage, testedAt: null }],
				widget: null,
				website: { version: 1, requires: [], missing: [] },
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

/** @type {string[]} the sections the Overview's buttons opened */
const opened = [];
const props = {
	websiteId: WEBSITE,
	who: /** @type {const} */ ({ kind: 'merchant', id: 'm_1', name: 'Merchant' }),
	support: { channels: [{ type: /** @type {const} */ ('email'), label: 'Email', url: 'mailto:help@example.com' }] },
	domain: 'shop.example.com',
	portal: 'https://portal.example.com',
	open: (/** @type {string} */ tab) => void opened.push(tab),
};

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe('Overview: the public address of the images', () => {
	it('asks for it once storage is connected, with a button to the settings', async () => {
		serve({ storage: 'connected', mediaBaseUrl: '' });
		const Overview = TABS.overview;
		const { container } = render(inDashboard(<Overview {...props} />));
		await settle();
		const text = container.textContent ?? '';
		expect(text).toContain('The public address of your images is not set');
		expect(text).toContain('Set it in Settings → Catalog: a public bucket, or a CDN in front of it.');
		const button = [...container.querySelectorAll('button')].find((node) => node.textContent === 'Set it');
		await act(async () => button?.click());
		expect(opened).toEqual(['settings']);
	});

	it('shows the address once set, and nothing before storage is connected', async () => {
		serve({ storage: 'connected', mediaBaseUrl: 'https://cdn.shop.example.com' });
		const Overview = TABS.overview;
		const set = render(inDashboard(<Overview {...props} />));
		await settle();
		expect(set.container.textContent).toContain('Set the public address of your imageshttps://cdn.shop.example.com');
		expect(set.container.textContent).not.toContain('is not set');
		cleanup();
		serve({ storage: 'not_connected', mediaBaseUrl: '' });
		const before = render(inDashboard(<Overview {...props} />));
		await settle();
		expect(before.container.textContent).not.toContain('public address of your images');
	});
});
