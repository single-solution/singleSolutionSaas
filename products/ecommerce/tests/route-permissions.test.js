/**
 * A route of the merchant's server and its twin for the dashboard widgets do the same work, so they ask for the same
 * permission (SR-5b-3, SR-5b-4: a copy-and-paste slip let a reviews moderator list and delete products, and an orders
 * manager change a return's status). The twin of `METHOD /v1/<path>` is `METHOD /v1/admin/<path>`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
beforeAll(async () => {
	shop = await readyShop();
});
afterAll(async () => shop.product.close());

describe('server routes and their dashboard twins', () => {
	it('ask for the same permission', () => {
		const routes = /** @type {Array<{ method: string, path: string, auth: string, permission?: string }>} */ (shop.routes);
		const ticket = new Map(routes.filter((r) => r.auth === 'ticket').map((r) => [`${r.method} ${r.path}`, r]));
		const pairs = routes
			.filter((r) => r.auth === 'server' && r.permission !== undefined)
			.map((r) => ({
				route: `${r.method} ${r.path}`,
				server: r.permission,
				twin: ticket.get(`${r.method} ${r.path.replace('/v1/', '/v1/admin/')}`),
			}))
			.filter((pair) => pair.twin !== undefined);
		// the table is read, not empty
		expect(pairs.length).toBeGreaterThan(100);
		const different = pairs.filter((pair) => pair.server !== pair.twin?.permission);
		expect(different.map((pair) => `${pair.route}: server ${pair.server}, ticket ${pair.twin?.permission}`)).toEqual([]);
	});

	it('every staff route of the server names a permission or says it is for any staff member', () => {
		const routes =
			/** @type {Array<{ method: string, path: string, auth: string, permission?: string, staff?: boolean, runtime?: boolean, scope?: string }>} */ (
				shop.routes
			);
		const loose = routes.filter(
			(r) =>
				r.auth === 'server' && r.permission === undefined && r.staff !== true && r.runtime !== true && r.scope === undefined,
		);
		expect(loose.map((r) => `${r.method} ${r.path}`)).toEqual([]);
	});
});
