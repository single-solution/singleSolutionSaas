// @vitest-environment jsdom
/* global document */
/**
 * Merchant Console → Website settings → Identity, rendered in the browser (jsdom) against a live in-process Portal
 * (identity module): load, register inline keys, refresh refusal, remove; and the pure form helpers.
 */
import { generateKeyPairSync } from 'node:crypto';
import { createElement } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadIdentity } from '../../../src/console/loaders.js';
import { WEBSITE_TABS, routes } from '../../../src/console/paths.js';
import { IdentityView, formOf, issuerBody, keysError } from '../../../src/console/views/identity.js';
import { act, byLabel, cleanup, render, type } from '../../../../packages/ui/test/dom.js';
import { PORTAL_URL, boot, setupMongo, teardownMongo } from './boot.js';

vi.setConfig({ testTimeout: 60_000 });
beforeAll(setupMongo, 120_000);
afterAll(teardownMongo, 60_000);
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const ED = { ...generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }), kid: 'site-1' };

const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** @param {() => boolean} check */
const until = async (check) => {
	const end = Date.now() + 10_000;
	while (!check()) {
		if (Date.now() > end) throw new Error('timed out waiting for the UI');
		await act(async () => {
			await sleep(20);
		});
	}
};
/** @param {string} label */
const press = async (label) => {
	const found = [...document.querySelectorAll('button')].filter((b) => b.textContent?.trim() === label);
	const button = found.at(-1);
	if (!button) throw new Error(`no button “${label}”`);
	await act(async () => {
		button.click();
	});
};
/** @param {string} snippet */
const shows = (snippet) => document.body.textContent?.replace(/\s+/g, ' ').includes(snippet) ?? false;

describe('identity form helpers', () => {
	it('maps stored issuers to forms and forms to request bodies', () => {
		expect(formOf(null)).toMatchObject({ issuer: '', source: 'jwks_url', subject: 'sub' });
		expect(formOf({ issuer: 'a', source: 'inline', audience: 'x', claimMap: { subject: 'uid', email: 'mail' } })).toMatchObject(
			{ source: 'inline', audience: 'x', subject: 'uid', email: 'mail', phone: '' },
		);
		const base = formOf(null);
		expect(issuerBody(base)).toEqual({
			ok: false,
			errors: { issuer: expect.any(String), jwksUrl: expect.any(String) },
		});
		expect(issuerBody({ ...base, issuer: 'a', jwksUrl: 'https://x.example/jwks', audience: 'shop', email: 'email' })).toEqual({
			ok: true,
			body: { issuer: 'a', jwksUrl: 'https://x.example/jwks', audience: 'shop', claimMap: { subject: 'sub', email: 'email' } },
		});
		const inline = { ...base, issuer: 'a', source: /** @type {const} */ ('inline') };
		expect(issuerBody({ ...inline, keys: JSON.stringify({ keys: [ED] }), phone: 'tel' })).toEqual({
			ok: true,
			body: { issuer: 'a', publicJwks: [ED], claimMap: { subject: 'sub', phone: 'tel' } },
		});
		expect(issuerBody({ ...inline, keys: JSON.stringify(ED) })).toMatchObject({ ok: true, body: { publicJwks: [ED] } });
		expect(issuerBody({ ...inline, keys: '[]' })).toMatchObject({ ok: false, errors: { publicJwks: expect.any(String) } });
		expect(issuerBody({ ...inline, keys: '{', subject: ' ' })).toMatchObject({
			ok: false,
			errors: { publicJwks: expect.any(String), 'claimMap.subject': expect.any(String) },
		});
		expect(keysError({ 'publicJwks.1': 'bad' })).toBe('bad');
		expect(keysError({})).toBeUndefined();
		expect(WEBSITE_TABS.at(-1)).toMatchObject({ key: 'identity', label: 'Identity' });
		expect(routes.identity('web_1')).toBe('/websites/web_1/identity');
	});
});

describe('identity page (jsdom)', () => {
	it('registers, shows, refuses a refresh of inline keys and removes the issuer', async () => {
		const h = await boot();
		const owner = await h.signupOwner('o@example.com');
		const created = await owner.client.post(`/v1/merchants/${owner.merchantId}/websites`, { domain: 'shop.example.com' });
		const websiteId = created.json.website.websiteId;
		/** @type {Array<{ method: string, status: number }>} */
		const calls = [];
		vi.stubGlobal(
			'fetch',
			/** @type {typeof fetch} */ (
				async (input, init = {}) => {
					const method = init.method ?? 'GET';
					const headers = new Headers(/** @type {any} */ (init.headers));
					headers.set('cookie', owner.client.cookie);
					headers.set('origin', PORTAL_URL);
					headers.set('sec-fetch-site', 'same-origin');
					const response = await h.portal.handle(
						new Request(new URL(String(input), PORTAL_URL), {
							method,
							headers,
							...(init.body === undefined ? {} : { body: /** @type {any} */ (init.body) }),
						}),
					);
					calls.push({ method, status: response.status });
					return response;
				}
			),
		);
		const api = {
			/** @param {string} path */
			get: async (path) => {
				const res = await owner.client.get(path);
				return res.status < 400
					? { ok: true, status: res.status, data: res.json }
					: { ok: false, status: res.status, problem: res.json };
			},
		};
		const loaded = await loadIdentity(/** @type {any} */ (api), owner.merchantId, websiteId);
		expect(loaded).toMatchObject({ ok: true, issuer: null });
		expect(await loadIdentity(/** @type {any} */ (api), owner.merchantId, 'web_00000000000000000000000000')).toMatchObject({
			ok: false,
			status: 404,
		});

		render(createElement(IdentityView, loaded));
		expect(shows('Register your identity issuer')).toBe(true);
		await press('Register issuer'); // client-side validation first
		expect(shows('Enter the issuer')).toBe(true);
		type(byLabel(document, 'Issuer'), 'https://login.shop.example.com/');
		await act(async () => {
			/** @type {HTMLInputElement} */ (document.querySelector('input[value="inline"]')).click();
		});
		type(byLabel(document, 'Public keys (JSON)'), JSON.stringify([{ ...ED, d: 'private' }]));
		await press('Register issuer');
		await until(() => shows('Private key material'));
		type(byLabel(document, 'Public keys (JSON)'), JSON.stringify({ keys: [ED] }));
		type(byLabel(document, 'E-mail claim (optional)'), 'email');
		await press('Register issuer');
		await until(() => shows('Current issuer'));
		expect(shows('site-1 · EdDSA')).toBe(true);
		expect(shows('email ← email')).toBe(true);
		expect(await h.service.identityFor(websiteId)).toMatchObject({ issuer: 'https://login.shop.example.com/' });

		await press('Remove');
		await press('Remove issuer');
		await until(() => shows('Register your identity issuer'));
		expect(await h.service.identityFor(websiteId)).toBeNull();
		expect(calls.map((c) => `${c.method} ${c.status}`)).toEqual(['PUT 422', 'PUT 200', 'DELETE 200']);
		cleanup();

		// a JWKS-URL issuer offers "Refresh keys"; a failing refresh shows the problem
		render(
			createElement(IdentityView, {
				...loaded,
				issuer: {
					issuer: 'acme',
					source: 'jwks_url',
					jwksUrl: 'https://x.example/jwks',
					claimMap: { subject: 'sub' },
					keys: [],
					lastError: 'the JWKS URL answered 500',
				},
			}),
		);
		expect(shows('The last key refresh failed')).toBe(true);
		await press('Refresh keys');
		await until(() => calls.length === 4);
		expect(calls.at(-1)).toEqual({ method: 'POST', status: 404 });
		cleanup();
		render(createElement(IdentityView, { ok: false, status: 404, problem: { status: 404, title: 'Not found' } }));
		expect(shows('Not found')).toBe(true);
	});
});
