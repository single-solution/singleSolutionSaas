/**
 * Cross-credential refuse: a credential minted for one trust boundary must not authorize another (PLAN §2 / §6).
 * Configure ≠ operate: the dashboard cookie may change settings, never mint tickets or mutate live records.
 * @module
 */
import { describe, expect, it } from 'vitest';
import { allows } from '../src/staff.js';
import { setup, productRoutes } from './helpers.js';

const ADMIN = 'https://admin.example.com';

describe('cross-credential refuse (PLAN)', () => {
	it('a configure (dashboard) session cannot call a staff/ticket route', async () => {
		const { call, session, settle } = await setup({ routes: productRoutes() });
		const cookie = await session({ kind: 'merchant' });
		await settle();
		const response = await call('GET', '/v1/inbox/open', { cookie, bare: true });
		expect(response.status).toBe(401);
	});

	it('a configure session cannot mint tickets or mutate live records (operate)', async () => {
		const { call, session, settle, websiteId } = await setup({ routes: productRoutes() });
		const cookie = await session({ kind: 'merchant' });
		await settle();
		const refused = [];
		for (const [method, path, init] of /** @type {Array<[string, string, Record<string, unknown>]>} */ ([
			['POST', '/v1/tickets', { body: { permissions: ['notes.read'], origin: ADMIN } }],
			['GET', '/v1/inbox', {}],
			['GET', '/v1/inbox/open', {}],
			['POST', '/v1/notes', { body: { text: 'live' }, origin: 'https://shop.example.com' }],
			['GET', '/v1/notes', { origin: 'https://shop.example.com' }],
			['GET', '/v1/server/notes', {}],
		])) {
			const response = await call(method, path, { cookie, bare: true, ...init });
			refused.push([method, path, response.status]);
		}
		expect(refused).toEqual([
			['POST', '/v1/tickets', 401],
			['GET', '/v1/inbox', 401],
			['GET', '/v1/inbox/open', 401],
			['POST', '/v1/notes', 401],
			['GET', '/v1/notes', 401],
			['GET', '/v1/server/notes', 401],
		]);
		// positive control: configure session is accepted on dashboard routes
		const sessionOk = await call('GET', '/v1/dashboard/session', { cookie, bare: true });
		expect(sessionOk.status).toBe(200);
		const overview = await call('GET', `/v1/dashboard/websites/${websiteId}/overview`, { cookie, bare: true });
		expect(overview.status).toBe(200);
	});

	it('allows() never grants from a bare server token (ticket and staff only)', () => {
		expect(allows({}, 'notes.read')).toBe(false);
		expect(allows({ ticket: { permissions: ['notes.read'] } }, 'notes.read')).toBe(true);
		expect(allows({ staff: { can: (p) => p === 'notes.read' } }, 'notes.read')).toBe(true);
		expect(allows({ staff: { can: () => false } }, 'notes.read')).toBe(false);
	});
});
