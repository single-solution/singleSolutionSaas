import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_ORIGIN, ORIGIN, setup } from './helpers.js';

/** @type {Awaited<ReturnType<typeof setup>>} */
let env;

beforeAll(async () => {
	env = await setup();
});
afterAll(async () => {
	await env.product.close();
});

describe('notes routes', () => {
	it('refuse everything while the feature is off', async () => {
		expect((await env.call('POST', '/v1/notes', { token: env.browser, origin: ORIGIN, body: { text: 'Hi' } })).status).toBe(
			403,
		);
	});

	it('need the merchant database once the feature is on', async () => {
		await env.switchOn(['notes']);
		const response = await env.call('GET', '/v1/notes', { token: env.server });
		expect(response.status).toBe(403);
		expect((await response.json()).type).toMatch(/database_not_connected$/);
		await env.connectDatabase();
	});

	it('take a visitor note with the browser token from the website', async () => {
		const response = await env.call('POST', '/v1/notes', {
			token: env.browser,
			origin: ORIGIN,
			body: { text: 'Do you ship abroad?', email: 'Visitor@Example.com' },
		});
		expect(response.status).toBe(201);
		expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
		expect(await response.json()).toMatchObject({ id: expect.stringMatching(/^note_/), createdAt: '2026-10-01T10:00:00.000Z' });
		const local = await env.call('POST', '/v1/notes', {
			token: env.browser,
			origin: 'http://localhost:5173',
			body: { text: 'Local' },
		});
		expect(local.status).toBe(201);
	});

	it('refuse invalid notes, other origins and missing tokens', async () => {
		const invalid = await env.call('POST', '/v1/notes', { token: env.browser, origin: ORIGIN, body: { text: '' } });
		expect(invalid.status).toBe(422);
		expect((await invalid.json()).errors).toEqual([expect.objectContaining({ path: '/text', code: 'empty' })]);
		expect(
			(await env.call('POST', '/v1/notes', { token: env.browser, origin: 'https://evil.example', body: { text: 'x' } }))
				.status,
		).toBe(401);
		expect((await env.call('POST', '/v1/notes', { origin: ORIGIN, body: { text: 'x' } })).status).toBe(401);
		expect((await env.call('GET', '/v1/notes', { token: env.server, origin: ORIGIN })).status).toBe(401);
	});

	it('use the longest-note setting', async () => {
		const cookie = await env.adminSession();
		const saved = await env.dashboard(cookie, 'PUT', `/v1/dashboard/websites/${env.websiteId}/settings/notes.maxLength`, {
			value: 20,
		});
		expect(saved.status).toBe(204);
		const long = await env.call('POST', '/v1/notes', { token: env.browser, origin: ORIGIN, body: { text: 'x'.repeat(21) } });
		expect(long.status).toBe(422);
		await env.dashboard(cookie, 'DELETE', `/v1/dashboard/websites/${env.websiteId}/settings/notes.maxLength`);
	});

	it('list the notes for the merchant server, newest first, paged', async () => {
		env.advance(1000);
		await env.call('POST', '/v1/notes', { token: env.browser, origin: ORIGIN, body: { text: 'Newest' } });
		const first = await env.call('GET', '/v1/notes?limit=2', { token: env.server });
		expect(first.status).toBe(200);
		expect(first.headers.get('access-control-allow-origin')).toBeNull();
		const page = await first.json();
		expect(page.items.map((/** @type {{ text: string }} */ note) => note.text)[0]).toBe('Newest');
		expect(page.items).toHaveLength(2);
		const next = await env.call('GET', `/v1/notes?limit=2&cursor=${page.nextCursor}`, { token: env.server });
		const rest = await next.json();
		expect(rest).toMatchObject({ hasMore: false, nextCursor: null });
		expect(rest.items).toHaveLength(1);
		// the count takes the list's filters: it equals the list's length
		const count = await env.call('GET', '/v1/notes/count', { token: env.server });
		expect(await count.json()).toEqual({ count: 3, capped: false });
	});

	it('list the notes for the admin widget with a ticket from its origin only', async () => {
		const ticket = await env.ticket();
		const response = await env.call('GET', '/v1/admin/notes', { token: ticket, origin: ADMIN_ORIGIN });
		expect(response.status).toBe(200);
		expect(response.headers.get('access-control-allow-origin')).toBe(ADMIN_ORIGIN);
		expect((await response.json()).items).toHaveLength(3);
		const count = await env.call('GET', '/v1/admin/notes/count', { token: ticket, origin: ADMIN_ORIGIN });
		expect(await count.json()).toEqual({ count: 3, capped: false });
		expect((await env.call('GET', '/v1/admin/notes', { token: ticket, origin: ORIGIN })).status).toBe(401);
		const without = await env.ticket([]);
		expect((await env.call('GET', '/v1/admin/notes', { token: without, origin: ADMIN_ORIGIN })).status).toBe(403);
	});

	it('serve one public widget.js, the widget config with the browser token, and the public docs', async () => {
		const script = await env.call('GET', '/widget.js');
		expect(script.status).toBe(200);
		expect(script.headers.get('content-type')).toMatch(/^text\/javascript/);
		expect(await script.text()).toContain('/v1/widget/config');
		const config = await env.call('GET', '/v1/widget/config', { token: env.browser, origin: ORIGIN });
		expect(config.status).toBe(200);
		expect(await config.json()).toMatchObject({
			features: ['notes'],
			settings: { maxLength: 500 },
			texts: { 'form.title': 'Leave us a note' },
		});
		const docs = await env.call('GET', '/docs');
		expect(docs.status).toBe(200);
		const html = await docs.text();
		for (const part of [
			'/v1/tickets',
			'SS_SERVER_TOKEN',
			'curl -X POST',
			'business.json',
			'localhost',
			'data-token',
			'notes.read',
		])
			expect(html).toContain(part);
		expect(html).toContain('/widget.js&#34; data-token');
	});

	it('export and delete a visitor’s notes (data rights)', async () => {
		const user = { email: 'visitor@example.com' };
		const exported = await env.call('POST', '/v1/data-rights/export', { token: env.server, body: { user } });
		expect((await exported.json()).records.notes).toEqual([expect.objectContaining({ text: 'Do you ship abroad?' })]);
		const none = await env.call('POST', '/v1/data-rights/export', { token: env.server, body: { user: { id: 'u_9' } } });
		expect((await none.json()).records).toEqual({});
		const deleted = await env.call('POST', '/v1/data-rights/delete', { token: env.server, body: { user } });
		expect(await deleted.json()).toEqual({ deleted: 1, anonymised: 0 });
		const nothing = await env.call('POST', '/v1/data-rights/delete', { token: env.server, body: { user: { id: 'u_9' } } });
		expect(await nothing.json()).toEqual({ deleted: 0, anonymised: 0 });
	});
});
