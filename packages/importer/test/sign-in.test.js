import { describe, expect, it } from 'vitest';
import { requestProduct } from '../src/http.js';

/** A fetch that keeps the headers it was sent. */
const recording = () => {
	/** @type {Array<{ route: string, headers: Record<string, string> }>} */
	const seen = [];
	/** @type {typeof globalThis.fetch} */
	const fetch = async (url, init) => {
		seen.push({ route: new URL(String(url)).pathname, headers: /** @type {Record<string, string>} */ (init?.headers) });
		return new Response('{}', { headers: { 'content-type': 'application/json' } });
	};
	return { fetch, seen };
};

describe('the staff member’s sign-in', () => {
	it('goes with the settings and the count routes, never with the import routes', async () => {
		const { fetch, seen } = recording();
		const target = { url: 'https://shop.example.test/', token: 'server-token', signIn: 'a.sign.in' };
		await requestProduct(fetch, target, 'PUT', '/v1/settings/catalog.pageSize', { body: '{}' });
		await requestProduct(fetch, target, 'GET', '/v1/products/count');
		await requestProduct(fetch, target, 'POST', '/v1/import/products', { body: '' });
		await requestProduct(fetch, target, 'GET', '/v1/import/status');
		expect(seen.map((call) => [call.route, call.headers['ss-sign-in'] ?? null])).toEqual([
			['/v1/settings/catalog.pageSize', 'a.sign.in'],
			['/v1/products/count', 'a.sign.in'],
			['/v1/import/products', null],
			['/v1/import/status', null],
		]);
		expect(seen.every((call) => call.headers.authorization === 'Bearer server-token')).toBe(true);
	});

	it('is not sent when there is none', async () => {
		const { fetch, seen } = recording();
		await requestProduct(fetch, { url: 'https://shop.example.test', token: 't' }, 'GET', '/v1/settings');
		expect(seen[0]?.headers['ss-sign-in']).toBeUndefined();
	});
});
