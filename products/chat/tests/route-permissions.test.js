/**
 * A route of the merchant's server and its twin for the dashboard widgets do the same work, so they ask for the same
 * permission (SR-5b-3, SR-5b-4 in Ecommerce: a copy-and-paste slip let the wrong role in). The twin of
 * `METHOD /v1/<path>` is `METHOD /v1/admin/<path>`.
 */
import { describe, expect, it } from 'vitest';
import { ready } from './helpers.js';

/** @typedef {{ method: string, path: string, auth: string, permission?: string, staff?: boolean, runtime?: boolean, scope?: string }} Route */

describe('server routes and their dashboard twins', () => {
	it('ask for the same permission, and no staff route of the server is left without one', async () => {
		const sys = await ready(['visitor_chat', 'inbox']);
		try {
			const routes = /** @type {Route[]} */ (sys.routes);
			const ticket = new Map(routes.filter((r) => r.auth === 'ticket').map((r) => [`${r.method} ${r.path}`, r]));
			const pairs = routes
				.filter((r) => r.auth === 'server' && r.permission !== undefined)
				.map((r) => ({
					route: `${r.method} ${r.path}`,
					server: r.permission,
					twin: ticket.get(`${r.method} ${r.path.replace('/v1/', '/v1/admin/')}`),
				}))
				.filter((pair) => pair.twin !== undefined);
			expect(pairs.length).toBeGreaterThan(20);
			const different = pairs.filter((pair) => pair.server !== pair.twin?.permission);
			expect(different.map((pair) => `${pair.route}: server ${pair.server}, ticket ${pair.twin?.permission}`)).toEqual([]);
			const loose = routes.filter(
				(r) =>
					r.auth === 'server' &&
					r.permission === undefined &&
					r.staff !== true &&
					r.runtime !== true &&
					r.scope === undefined,
			);
			expect(loose.map((r) => `${r.method} ${r.path}`)).toEqual([]);
		} finally {
			await sys.product.close();
		}
	});
});
