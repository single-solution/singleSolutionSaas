// @vitest-environment jsdom
/**
 * The Store details view in the browser (jsdom) on a faked dashboard API: who the store is is the website's, set once in
 * the Portal, so the view shows what the Portal says, read only, with a link to where it is changed. It has no field,
 * no picture slot and no save.
 */
import { act } from 'react';
import { emptyWebsiteSettings } from '@ss/contracts/website-settings';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@ss/ui/testing';
import { StoreDetailsView, factsOf } from '../app/dashboard/store-details.js';
import { inDashboard } from './dashboard-provider.js';

const WEBSITE = 'web_1';
const BASE = `/v1/dashboard/websites/${WEBSITE}`;

/** What the merchant saved in the Portal (Business and Region and format). */
const settings = () => {
	const empty = emptyWebsiteSettings(WEBSITE);
	return {
		...empty,
		version: 3,
		business: {
			...empty.business,
			name: 'Example Store',
			email: 'hello@example-store.test',
			phone: '+1 555 0100',
			address: { ...empty.business.address, line1: '1 Main Street', city: 'Springfield', country: 'US' },
		},
		region: { ...empty.region, timeZone: 'America/Chicago' },
	};
};

/** @type {string[]} */
let calls = [];
/** @param {unknown} answer the website settings the dashboard API answers */
const serve = (answer) => {
	calls = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (/** @type {string} */ path, /** @type {RequestInit} */ init = {}) => {
			calls.push(`${init.method ?? 'GET'} ${path}`);
			return path === `${BASE}/website-settings`
				? new Response(JSON.stringify({ settings: answer }), { status: 200 })
				: new Response(JSON.stringify({ status: 404 }), { status: 404 });
		}),
	);
};

const settle = async () => {
	for (let i = 0; i < 6; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe('the facts the view lists', () => {
	it('are the Portal’s name, contacts, address and time zone, with a dash for what is not set', () => {
		expect(factsOf(settings())).toEqual([
			{ label: 'Store name', value: 'Example Store' },
			{ label: 'Email address', value: 'hello@example-store.test' },
			{ label: 'Phone number', value: '+1 555 0100' },
			{ label: 'Address', value: '1 Main Street, Springfield, US' },
			{ label: 'Time zone', value: 'America/Chicago' },
		]);
		expect(factsOf(emptyWebsiteSettings(WEBSITE)).map((fact) => fact.value)).toEqual(['—', '—', '—', '—', '—']);
	});
});

describe('the Store details view', () => {
	it('shows what the Portal says, read only, with the link to change it, and what the website reads', async () => {
		serve(settings());
		const { container } = render(
			inDashboard(<StoreDetailsView websiteId={WEBSITE} portal="https://portal.example.com" merchantId="mer_1" />),
		);
		await settle();
		const text = container.textContent ?? '';
		for (const words of ['Set in the Portal', 'Example Store', 'hello@example-store.test', '1 Main Street, Springfield, US'])
			expect(text).toContain(words);
		expect(text).toContain('/v1/shop/store');
		expect(text).toContain('/v1/shop/store/business-json');
		const link = [...container.querySelectorAll('a')].find((node) => node.textContent === 'Open Website settings');
		expect(link?.getAttribute('href')).toBe('https://portal.example.com/websites/web_1/settings#business');
		// nothing to type into and nothing to save
		expect(container.querySelectorAll('input, textarea, select')).toHaveLength(0);
		expect([...container.querySelectorAll('button')].map((node) => node.textContent)).not.toContain('Save');
		expect(calls).toEqual([`GET ${BASE}/website-settings`]);
	});

	it('links an Owner or Support admin to the merchant’s page of the website', async () => {
		serve(settings());
		const { container } = render(
			inDashboard(<StoreDetailsView websiteId={WEBSITE} portal="https://portal.example.com" merchantId="mer_1" admin />),
		);
		await settle();
		const link = [...container.querySelectorAll('a')].find((node) => node.textContent === 'Open Website settings');
		expect(link?.getAttribute('href')).toBe(
			'https://portal.example.com/admin/merchants/mer_1/websites/web_1/settings#business',
		);
	});

	it('says the feature is off when it is, and shows dashes while the Portal holds nothing yet', async () => {
		serve(emptyWebsiteSettings(WEBSITE));
		const { container } = render(inDashboard(<StoreDetailsView websiteId={WEBSITE} off />));
		await settle();
		expect(container.textContent).toContain('This feature is off.');
		expect(container.textContent).toContain('—');
		// without the Portal's address there is no link, only the note
		expect([...container.querySelectorAll('a')].some((node) => node.textContent === 'Open Website settings')).toBe(false);
	});
});
