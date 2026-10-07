import { afterAll, describe, expect, it } from 'vitest';
import { DOMAIN, setup } from './helpers.js';

const SITE = `https://${DOMAIN}`;
const ADMIN = 'https://admin.shop.example.com';
/** @type {Array<{ product: { close: () => Promise<void> } }>} */
const opened = [];

afterAll(async () => {
	for (const env of opened) await env.product.close();
});

describe('widget config', () => {
	it('answers texts, theme, switched-on features and the product’s widget settings to the browser token', async () => {
		const env = await setup({ hooks: { widgetConfig: async () => ({ maxNotes: 5 }) } });
		opened.push(env);
		const { call, browser, server, switchOn, connectDatabase, settle, store, websiteId } = env;
		// the merchant database is needed first, like every website route
		const early = await call('GET', '/v1/widget/config', { token: browser.token, origin: SITE });
		expect(early.status).toBe(403);
		await connectDatabase();
		const off = await (await call('GET', '/v1/widget/config', { token: browser.token, origin: SITE })).json();
		expect(off).toMatchObject({
			features: [],
			settings: { maxNotes: 5 },
			customCss: '',
			texts: { 'form.title': 'Leave a note' },
		});
		expect(off.theme).toEqual({ colors: {}, fontFamily: 'inherit', radius: 8, mode: 'auto' });
		await switchOn(['notes']);
		const on = await call('GET', '/v1/widget/config', { token: browser.token, origin: SITE });
		expect(on.headers.get('access-control-allow-origin')).toBe(SITE);
		expect((await on.json()).features).toEqual(['notes']);
		await settle();
		expect(await store.get('widget', websiteId)).toMatchObject({ websiteId });
		// Origin required, browser token only
		expect((await call('GET', '/v1/widget/config', { token: browser.token })).status).toBe(401);
		expect((await call('GET', '/v1/widget/config', { token: server.token, origin: SITE })).status).toBe(401);

		const { ticket } = await (
			await call('POST', '/v1/tickets', {
				token: server.token,
				body: { user: { id: 'u1', name: 'Sam', email: 'sam@example.com' }, permissions: [], origin: ADMIN },
			})
		).json();
		const admin = await call('GET', '/v1/widget/admin/config', { token: ticket, origin: ADMIN });
		expect(admin.status).toBe(200);
		expect(admin.headers.get('access-control-allow-origin')).toBe(ADMIN);
		expect(await admin.json()).toMatchObject({ features: ['notes'], settings: { maxNotes: 5 } });
		expect((await call('GET', '/v1/widget/admin/config', { token: ticket, origin: SITE })).status).toBe(401);
	});

	it('answers empty settings without the hook', async () => {
		const env = await setup();
		opened.push(env);
		await env.connectDatabase();
		const body = await (await env.call('GET', '/v1/widget/config', { token: env.browser.token, origin: SITE })).json();
		expect(body.settings).toEqual({});
	});
});
