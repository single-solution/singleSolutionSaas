// @vitest-environment jsdom
/**
 * The Store details editor in the browser (jsdom) on a faked dashboard API: it shows the saved record, its logo, and
 * saves every field with one PUT (the five pictures stay as they are saved), with the hours, phones and links as the
 * lines the merchant types.
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { byLabel, byText, cleanup, click, render, type } from '@ss/ui/testing';
import { StoreDetailsEditor, draftOf, valueOf } from '../app/dashboard/store-details.js';
import { checkStoreDetails } from '../core/store-details.js';
import { inDashboard } from './dashboard-provider.js';

const WEBSITE = 'web_1';
const BASE = `/v1/dashboard/websites/${WEBSITE}`;
const LOGO = { key: 'ecommerce/store/logo-abcdefghij.png', type: 'image/png', size: 900, alt: 'Logo' };
const DARK = { key: 'ecommerce/store/logoDark-abcdefghij.png', type: 'image/png', size: 900, alt: 'Dark logo' };
const FAVICON = { key: 'ecommerce/store/favicon-abcdefghij.png', type: 'image/png', size: 90, alt: 'Favicon' };

/** The records the editor saved. @type {any[]} */
let saved = [];

const serve = () => {
	saved = [];
	/** @type {any} */
	let record = checkStoreDetails({
		name: 'Example Store',
		logo: LOGO,
		favicon: FAVICON,
		phones: [{ label: 'Landline', number: '021 111 222' }],
		hours: {
			weekly: [{ day: 1, start: '09:00', end: '17:00' }],
			exceptions: [
				{ date: '2026-12-24', name: 'Christmas Eve', hours: [{ start: '09:00', end: '12:00' }] },
				{ date: '2026-12-25', name: 'Christmas', hours: [] },
			],
		},
		social: [{ label: 'Instagram', url: 'https://instagram.com/examplestore' }],
	});
	record = /** @type {any} */ (record).value;
	vi.stubGlobal(
		'fetch',
		vi.fn(async (/** @type {string} */ path, /** @type {RequestInit} */ init = {}) => {
			if (path === `${BASE}/store-details/files`)
				return new Response(
					JSON.stringify({
						logo: { ...LOGO, url: 'https://cdn.example.com/logo.png' },
						logoDark: null,
						icon: null,
						favicon: { ...FAVICON, url: 'https://cdn.example.com/favicon.png' },
						faviconDark: null,
					}),
					{ status: 200 },
				);
			if (path !== `${BASE}/lists/store_details`) return new Response(JSON.stringify({ status: 404 }), { status: 404 });
			if (init.method === 'PUT') {
				const { value } = JSON.parse(String(init.body));
				saved.push(value);
				const checked = checkStoreDetails(value);
				if (!checked.ok) return new Response(JSON.stringify({ status: 422, errors: checked.errors }), { status: 422 });
				record = checked.value;
			}
			return new Response(JSON.stringify({ value: record }), { status: 200 });
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

describe('the store details drafts', () => {
	it('turn the hours exceptions, phones and social links into lines and back, keeping the files', () => {
		const record = /** @type {any} */ (
			checkStoreDetails({
				name: 'Shop',
				logo: LOGO,
				logoDark: DARK,
				phones: [
					{ label: 'Landline', number: '021 111 222' },
					{ label: '', number: '+1 555 0100' },
				],
				hours: { weekly: [], exceptions: [{ date: '2026-12-24', name: 'Eve', hours: [{ start: '09:00', end: '12:00' }] }] },
				social: [{ label: 'X', url: 'https://x.com/shop' }],
			})
		).value;
		const draft = draftOf(record);
		expect(draft.exceptions).toBe('2026-12-24 Eve | 09:00-12:00');
		expect(draft.social).toBe('X | https://x.com/shop');
		expect(draft.phones).toBe('Landline | 021 111 222\n+1 555 0100');
		expect(valueOf(draft, record)).toMatchObject({
			logo: LOGO,
			logoDark: DARK,
			icon: null,
			favicon: null,
			faviconDark: null,
			phones: [
				{ label: 'Landline', number: '021 111 222' },
				{ label: '', number: '+1 555 0100' },
			],
			hours: { exceptions: [{ date: '2026-12-24', name: 'Eve', hours: [{ start: '09:00', end: '12:00' }] }] },
			social: [{ label: 'X', url: 'https://x.com/shop' }],
		});
	});
});

describe('the store details editor', () => {
	it('shows the saved record and its logo, and saves every field with one PUT', async () => {
		serve();
		const { container } = render(inDashboard(<StoreDetailsEditor websiteId={WEBSITE} />));
		await settle();
		expect(/** @type {HTMLInputElement} */ (byLabel(container, 'Store name')).value).toBe('Example Store');
		expect(/** @type {HTMLImageElement} */ (container.querySelector('[data-file="logo"] img')).src).toBe(
			'https://cdn.example.com/logo.png',
		);
		expect(/** @type {HTMLImageElement} */ (container.querySelector('[data-file="favicon"] img')).src).toBe(
			'https://cdn.example.com/favicon.png',
		);
		// every picture has its own slot
		expect([...container.querySelectorAll('[data-file]')].map((slot) => slot.getAttribute('data-file'))).toEqual([
			'logo',
			'logoDark',
			'icon',
			'favicon',
			'faviconDark',
		]);
		expect(
			/** @type {HTMLTextAreaElement} */ (/** @type {unknown} */ (byLabel(container, 'More phone numbers (one per line)')))
				.value,
		).toBe('Landline | 021 111 222');
		expect(container.querySelectorAll('[data-window]')).toHaveLength(1);
		type(byLabel(container, 'More phone numbers (one per line)'), 'Landline | 021 111 222\nSales | +1 555 0123');
		type(byLabel(container, 'Tagline'), 'Everything for the home');
		type(byLabel(container, 'WhatsApp number'), '+1 555 0199');
		type(byLabel(container, 'City'), 'Springfield');
		click(byText(container, 'Add hours'));
		await settle();
		expect(container.querySelectorAll('[data-window]')).toHaveLength(2);
		click(byText(container, 'Save list'));
		await settle();
		expect(saved).toHaveLength(1);
		expect(saved[0]).toMatchObject({
			name: 'Example Store',
			tagline: 'Everything for the home',
			whatsapp: '+1 555 0199',
			address: { city: 'Springfield' },
			logo: LOGO,
			favicon: FAVICON,
			phones: [
				{ label: 'Landline', number: '021 111 222' },
				{ label: 'Sales', number: '+1 555 0123' },
			],
			hours: {
				weekly: [
					{ day: 1, start: '09:00', end: '17:00' },
					{ day: 1, start: '09:00', end: '17:00' },
				],
			},
		});
		// two windows on one day overlap: the server's check is shown, nothing is lost
		expect(container.textContent).toContain('overlap');
	});
});
