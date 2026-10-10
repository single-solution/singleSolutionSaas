import { beforeAll, describe, expect, it } from 'vitest';
import { createDashboardSearch } from '../server/dashboard-search.js';
import { setup } from './helpers.js';

/** @typedef {Awaited<ReturnType<typeof setup>>} Harness */

describe('GET /v1/dashboard/websites/:websiteId/search-index', () => {
	/** @type {Harness} */
	let t;
	/** @type {(request: Request) => Promise<Response>} */
	let handler;
	/** @type {string} */
	let cookie;

	beforeAll(async () => {
		t = await setup();
		// the route on its own handler (server/routes.js mounts it beside the dashboard's list routes)
		handler = t.product.handler(createDashboardSearch(t.product));
		cookie = await t.adminSession();
		await t.switchOn(['catalog']);
	});

	/** @param {string | null} session */
	const read = async (session) => {
		const response = await handler(
			new Request(`https://ecommerce.example.dev/v1/dashboard/websites/${t.websiteId}/search-index`, {
				headers: session ? { cookie: session } : {},
			}),
		);
		return { status: response.status, json: await response.json() };
	};

	it('answers basic search with the default index and no state before any Atlas search', async () => {
		const found = await read(cookie);
		expect(found.status).toBe(200);
		expect(found.json).toEqual({ search: 'basic', index: 'ss_ecommerce_products_search', state: null });
	});

	it('follows the catalog settings and the last Atlas search', async () => {
		await t.setting('catalog', 'search', 'atlas');
		await t.setting('catalog', 'searchIndex', 'shop_search');
		expect((await read(cookie)).json).toEqual({ search: 'atlas', index: 'shop_search', state: null });

		await t.product.searchState.set(t.websiteId, true, 'IndexNotFound');
		const missing = (await read(cookie)).json;
		expect(missing.state).toEqual({ missing: true, at: new Date(t.now()).toISOString(), message: 'IndexNotFound' });

		t.advance(60_000);
		await t.product.searchState.set(t.websiteId, false);
		expect((await read(cookie)).json.state).toEqual({ missing: false, at: new Date(t.now()).toISOString(), message: '' });
	});

	it('falls back to the default index when the setting is emptied', async () => {
		await t.setting('catalog', 'searchIndex', '');
		expect((await read(cookie)).json.index).toBe('ss_ecommerce_products_search');
	});

	it('needs a dashboard session', async () => {
		expect((await read(null)).status).toBe(401);
	});
});
