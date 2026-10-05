// @vitest-environment jsdom
/**
 * Merchant Console: per-website element texts (F.18) — loads the website's overrides, edits one element and language,
 * saves them through `PUT …/delivery/strings/:appId/:element/:language`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@ss/ui';
import { byLabel, cleanup, render, type } from '@ss/ui/testing';
import { TextsPanel, formatTexts, parseTexts } from '../../src/console/views/texts.js';
import { button, clickEl, settle, shows } from './merchant-harness.js';

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const M = 'mer_0123456789abcdefghjkmnpq';
const W = 'web_0123456789abcdefghjkmnpq';
const APP = 'app_0123456789abcdefghjkmnpq';
const product = {
	appId: APP,
	elements: [
		{ key: 'grid', name: 'Grid', modes: ['A', 'B'] },
		{ key: 'api', name: 'API', modes: ['C'] },
	],
};

describe('texts panel', () => {
	it('parses and formats `key = text` lines', () => {
		expect(parseTexts('a.b = Hello = world\n\nnope\n = x\nc=d')).toEqual({ 'a.b': 'Hello = world', c: 'd' });
		expect(formatTexts({ a: 'b' })).toBe('a = b');
		expect(formatTexts(undefined)).toBe('');
	});

	it('loads, edits and saves an element’s texts for a language', async () => {
		/** @type {Array<{ url: string, init: any }>} */
		const calls = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (/** @type {string} */ url, /** @type {any} */ init) => {
				calls.push({ url, init });
				if (init?.method === 'PUT') {
					const body = JSON.parse(init.body);
					return Response.json({ appId: APP, element: 'grid', languages: { de: body.strings }, updatedAt: null });
				}
				return Response.json({ items: [{ appId: APP, element: 'grid', languages: { de: { 'grid.title': 'Alles' } } }] });
			}),
		);
		render(
			<ToastProvider>
				<TextsPanel merchantId={M} website={{ websiteId: W, language: 'de' }} product={product} />
			</ToastProvider>,
		);
		await settle(5);
		expect(byLabel(document, 'Texts').value).toBe('grid.title = Alles');
		type(byLabel(document, 'Texts'), 'grid.title = Unsere Auswahl');
		await clickEl(button('Save texts'));
		await settle(5);
		const put = calls.find((c) => c.init?.method === 'PUT');
		expect(put?.url).toBe(`/v1/merchants/${M}/websites/${W}/delivery/strings/${APP}/grid/de`);
		expect(JSON.parse(put?.init.body)).toEqual({ strings: { 'grid.title': 'Unsere Auswahl' } });
		expect(shows('Texts saved')).toBe(true);
		type(byLabel(document, 'Language'), '');
		await settle(2);
		expect(byLabel(document, 'Texts').value).toBe('');
	});

	it('shows load and save problems, and products without drop-in elements', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Response.json({ title: 'Forbidden', status: 403 }, { status: 403 })),
		);
		render(
			<ToastProvider>
				<TextsPanel merchantId={M} website={{ websiteId: W }} product={product} />
			</ToastProvider>,
		);
		await settle(5);
		expect(shows('You do not have permission')).toBe(true);
		cleanup();
		vi.stubGlobal(
			'fetch',
			vi.fn(async (/** @type {string} */ _url, /** @type {any} */ init) =>
				init?.method === 'PUT'
					? Response.json(
							{ title: 'Validation failed', status: 422, detail: 'The string override is invalid.' },
							{ status: 422 },
						)
					: Response.json({ items: [] }),
			),
		);
		render(
			<ToastProvider>
				<TextsPanel merchantId={M} website={{ websiteId: W }} product={product} />
			</ToastProvider>,
		);
		await settle(5);
		await clickEl(button('Save texts'));
		await settle(5);
		expect(document.querySelector('[role="alert"]'), document.body.textContent ?? '').not.toBeNull();
		cleanup();
		render(<TextsPanel merchantId={M} website={{ websiteId: W }} product={{ elements: [] }} />);
		expect(shows('no drop-in elements')).toBe(true);
	});
});
