import { describe, expect, it } from 'vitest';
import { BASE, DOMAIN, setup } from './helpers.js';

const BUSINESS = { name: 'Example Shop', timeZone: 'Europe/London', country: 'gb' };

describe('sso and sessions', () => {
	it('exchanges a launch once for a host-only session cookie and redirects to the website', async () => {
		const { call, portal, websiteId, clock } = await setup();
		const launch = await portal.issueLaunch({ productId: 'notes', kind: 'merchant', websiteId });
		const response = await call('GET', `/sso?launch=${launch}`);
		expect(response.status).toBe(303);
		expect(response.headers.get('location')).toBe(`/dashboard?websiteId=${websiteId}`);
		const cookie = /** @type {string} */ (response.headers.get('set-cookie'));
		expect(cookie).toMatch(/^ss_session=[\w-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax; Expires=/);
		expect(cookie).not.toMatch(/Domain=/i);
		expect(response.headers.get('x-frame-options')).toBe('DENY');
		expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
		expect((await call('GET', `/sso?launch=${launch}`)).status).toBe(401);
		expect((await call('GET', '/sso?launch=garbage')).status).toBe(401);
		// the session ends with the Portal session
		const short = await portal.issueLaunch({
			productId: 'notes',
			kind: 'admin',
			sessionExpiresAt: new Date(clock.now() + 60_000).toISOString(),
		});
		const admin = /** @type {string} */ ((await call('GET', `/sso?launch=${short}`)).headers.get('set-cookie')).split(';')[0];
		expect((await call('GET', '/v1/dashboard/session', { cookie: admin })).status).toBe(200);
		clock.advance(61_000);
		expect((await call('GET', '/v1/dashboard/session', { cookie: admin })).status).toBe(401);
	});

	it('sends an admin without a website to Defaults and answers 503 when the Portal cannot consume', async () => {
		const { call, portal } = await setup();
		const launch = await portal.issueLaunch({ productId: 'notes', kind: 'admin', websiteId: null });
		const response = await call('GET', `/sso?launch=${launch}`);
		expect(response.headers.get('location')).toBe('/dashboard?view=defaults');
		const other = await portal.issueLaunch({ productId: 'notes', kind: 'admin', websiteId: null });
		portal.setReachable(false);
		expect((await call('GET', `/sso?launch=${other}`)).status).toBe(503);
	});

	it('lists the switcher grouped by merchant', async () => {
		const { portal, session, dash, websiteId } = await setup();
		const second = portal.addWebsite({
			domain: 'www.example.org',
			merchantId: 'mer_1123456789abcdefghjkmnpq',
			merchantName: 'Org',
		});
		portal.addWebsite({ domain: 'gone.example.org', status: 'removed' });
		const admin = await (await dash(await session(), 'GET', '/v1/dashboard/session')).json();
		expect(admin.who).toEqual({ kind: 'admin', id: 'adm_0123456789abcdefghjkmnpq', name: 'Ada Admin', role: 'owner' });
		expect(admin.portalUrl).toBe(portal.url);
		expect(admin.switcher).toEqual([
			{
				merchantId: 'mer_0123456789abcdefghjkmnpq',
				merchantName: 'Example Shop',
				websites: [{ websiteId, domain: DOMAIN, status: 'active' }],
			},
			{
				merchantId: 'mer_1123456789abcdefghjkmnpq',
				merchantName: 'Org',
				websites: [{ websiteId: second, domain: 'www.example.org', status: 'active' }],
			},
		]);
		const merchant = await (await dash(await session({ kind: 'merchant' }), 'GET', '/v1/dashboard/session')).json();
		expect(merchant.switcher).toEqual([
			{ merchantId: 'mer_0123456789abcdefghjkmnpq', merchantName: 'Example Shop', websites: [{ websiteId, domain: DOMAIN }] },
		]);
		expect(merchant.branding).toEqual({ name: 'Single Solution', accent: '#2563eb', logoUrl: null });
	});

	it('pages the admin switcher and answers 503 without the Portal', async () => {
		const { portal, session, dash } = await setup();
		for (let i = 0; i < 120; i += 1) portal.addWebsite({ domain: `s${i}.example.org` });
		const cookie = await session();
		const body = await (await dash(cookie, 'GET', '/v1/dashboard/session')).json();
		expect(body.switcher[0].websites).toHaveLength(121);
		portal.setReachable(false);
		expect((await dash(cookie, 'GET', '/v1/dashboard/session')).status).toBe(503);
	});

	it('checks website access, roles and the Origin of writes', async () => {
		const { portal, session, dash, call, websiteId } = await setup();
		const other = portal.addWebsite({ domain: 'www.example.org', merchantId: 'mer_1123456789abcdefghjkmnpq' });
		const removed = portal.addWebsite({ domain: 'gone.example.org', status: 'removed' });
		const merchant = await session({ kind: 'merchant' });
		expect((await dash(merchant, 'GET', `/v1/dashboard/websites/${other}/settings`)).status).toBe(403);
		expect((await dash(merchant, 'PUT', `/v1/dashboard/websites/${websiteId}/features`, { on: ['notes'] })).status).toBe(403);
		expect((await dash(merchant, 'GET', '/v1/dashboard/prices')).status).toBe(403);
		const support = await session({ role: 'support' });
		expect((await dash(support, 'GET', `/v1/dashboard/websites/${other}/settings`)).status).toBe(200);
		expect((await dash(support, 'GET', `/v1/dashboard/websites/${removed}/settings`)).status).toBe(404);
		expect((await dash(support, 'GET', '/v1/dashboard/websites/web_unknown/settings')).status).toBe(404);
		expect((await dash(support, 'GET', '/v1/dashboard/defaults')).status).toBe(403);
		const crossOrigin = await call('PUT', `/v1/dashboard/websites/${websiteId}/texts/form.title`, {
			cookie: support,
			origin: 'https://evil.example.com',
			body: { value: 'x' },
		});
		expect(crossOrigin.status).toBe(403);
		expect((await call('GET', '/v1/dashboard/session')).status).toBe(401);
		const page = await dash(support, 'GET', '/v1/dashboard/session');
		expect(page.headers.get('cache-control')).toBe('no-store');
		expect(page.headers.get('x-frame-options')).toBe('DENY');
		portal.setReachable(false);
		const fresh = portal.addWebsite({ domain: 'new.example.org' });
		expect((await dash(support, 'GET', `/v1/dashboard/websites/${fresh}/settings`)).status).toBe(503);
	});
});

describe('features and prices', () => {
	it('sends feature reports, saves switches only after acceptance and checks dependencies', async () => {
		const { portal, session, dash, websiteId } = await setup();
		const cookie = await session({ role: 'support' });
		const path = `/v1/dashboard/websites/${websiteId}/features`;
		expect((await dash(cookie, 'PUT', path, { on: ['inbox'] })).status).toBe(422);
		expect((await dash(cookie, 'PUT', path, { on: ['nope'] })).status).toBe(422);
		expect((await dash(cookie, 'PUT', path, 'x')).status).toBe(400);
		const saved = await dash(cookie, 'PUT', path, { on: ['inbox', 'notes'] });
		expect(await saved.json()).toEqual({ version: 1, on: ['notes', 'inbox'] });
		expect(portal.featureReports[0]?.body).toEqual({
			version: 1,
			on: ['notes', 'inbox'],
			adminId: 'adm_0123456789abcdefghjkmnpq',
			adminName: 'Ada Admin',
		});
		const listed = await (await dash(cookie, 'GET', path)).json();
		expect(listed).toMatchObject({
			featuresVersion: 1,
			features: [
				{ key: 'notes', on: true },
				{ key: 'inbox', on: true, dependsOn: ['notes'] },
			],
		});
		portal.setReachable(false);
		expect((await dash(cookie, 'PUT', path, { on: [] })).status).toBe(503);
		portal.setReachable(true);
		const finance = await session({ role: 'support' });
		portal.addAdmin({ id: 'adm_0123456789abcdefghjkmnpq', name: 'Ada Admin', role: 'finance' });
		const refused = await dash(finance, 'PUT', path, { on: [] });
		expect(refused.status).toBe(422);
		expect((await dash(cookie, 'GET', path)).status).toBe(200);
		expect((await (await dash(cookie, 'GET', path)).json()).featuresVersion).toBe(1);
		const overview = await (await dash(cookie, 'GET', `/v1/dashboard/websites/${websiteId}/overview`)).json();
		expect(overview.recentChanges[0]).toMatchObject({
			what: 'features',
			detail: 'On: Notes, Notes inbox',
			who: { kind: 'admin', role: 'support' },
		});
	});

	it('maps Portal refusals of feature reports', async () => {
		const { portal, session, dash, websiteId } = await setup();
		const cookie = await session();
		const path = `/v1/dashboard/websites/${websiteId}/features`;
		portal.deleteWebsite(websiteId);
		expect((await dash(cookie, 'PUT', path, { on: [] })).status).toBe(404);
	});

	it('sends price reports from the Prices screen (Owner)', async () => {
		const { portal, session, dash } = await setup();
		const owner = await session();
		const before = await (await dash(owner, 'GET', '/v1/dashboard/prices')).json();
		expect(before).toMatchObject({
			version: 1,
			features: [
				{ key: 'notes', millicreditsPerHour: 0 },
				{ key: 'inbox', millicreditsPerHour: 0 },
			],
		});
		expect((await dash(owner, 'PUT', '/v1/dashboard/prices', { prices: { notes: -1 } })).status).toBe(422);
		expect((await dash(owner, 'PUT', '/v1/dashboard/prices', { prices: { nope: 1 } })).status).toBe(422);
		expect((await dash(owner, 'PUT', '/v1/dashboard/prices', { nothing: true })).status).toBe(422);
		expect(await (await dash(owner, 'PUT', '/v1/dashboard/prices', { prices: { notes: 1500 } })).json()).toEqual({
			version: 2,
		});
		expect(portal.prices('notes')).toMatchObject({
			version: 2,
			features: [
				{ key: 'notes', millicreditsPerHour: 1500 },
				{ key: 'inbox', millicreditsPerHour: 0 },
			],
		});
		const after = await (await dash(owner, 'GET', '/v1/dashboard/prices')).json();
		expect(after.recentChanges[0]).toMatchObject({
			websiteId: null,
			what: 'prices',
			detail: 'Notes: 1.5 credits/hour, Notes inbox: 0 credits/hour',
		});
		const prices = /** @type {{ version: number }} */ (portal.prices('notes'));
		prices.version = 5;
		expect((await dash(owner, 'PUT', '/v1/dashboard/prices', { prices: { notes: 1 } })).status).toBe(409);
		portal.setReachable(false);
		expect((await dash(owner, 'PUT', '/v1/dashboard/prices', { prices: { notes: 1 } })).status).toBe(503);
	});
});

describe('settings, texts, theme and defaults', () => {
	it('resolves website value › global default › schema default and hides off features from merchants', async () => {
		const { session, dash, websiteId, switchOn, product } = await setup();
		const owner = await session();
		const merchant = await session({ kind: 'merchant' });
		const settings = `/v1/dashboard/websites/${websiteId}/settings`;
		expect((await (await dash(merchant, 'GET', settings)).json()).features).toEqual([]);
		expect((await dash(merchant, 'PUT', `${settings}/notes.maxNotes`, { value: 9 })).status).toBe(403);
		const all = await (await dash(owner, 'GET', settings)).json();
		expect(all.features.map((/** @type {{ key: string }} */ f) => f.key)).toEqual(['notes', 'inbox']);
		expect(all.features[0].values.maxNotes).toEqual({ value: 5, source: 'built-in' });
		await switchOn(['notes']);
		expect((await dash(owner, 'PUT', '/v1/dashboard/defaults/notes.maxNotes', { value: 7 })).status).toBe(204);
		expect(await product.settings.values(websiteId, 'notes')).toEqual({ maxNotes: 7, greeting: 'Leave us a note' });
		expect((await dash(merchant, 'PUT', `${settings}/notes.maxNotes`, { value: 51 })).status).toBe(422);
		expect((await dash(merchant, 'PUT', `${settings}/notes.maxNotes`, {})).status).toBe(422);
		expect((await dash(merchant, 'PUT', `${settings}/notes.nope`, { value: 1 })).status).toBe(404);
		expect((await dash(merchant, 'PUT', `${settings}/notes.maxNotes`, { value: 9 })).status).toBe(204);
		const merchantView = await (await dash(merchant, 'GET', settings)).json();
		expect(merchantView.features).toHaveLength(1);
		expect(merchantView.features[0].values.maxNotes).toEqual({ value: 9, source: 'website' });
		expect((await dash(merchant, 'DELETE', `${settings}/notes.maxNotes`)).status).toBe(204);
		expect((await product.settings.values(websiteId, 'notes')).maxNotes).toBe(7);
		expect((await dash(owner, 'PUT', '/v1/dashboard/defaults/notes.maxNotes', { value: null })).status).toBe(204);
		expect((await product.settings.values(websiteId, 'notes')).maxNotes).toBe(5);
		expect(await product.settings.values(websiteId, 'nope')).toEqual({});
		expect((await dash(owner, 'PUT', '/v1/dashboard/defaults/notes.maxNotes', {})).status).toBe(422);
	});

	it('saves widget texts only with the same placeholders', async () => {
		const { session, dash, websiteId, product } = await setup();
		const merchant = await session({ kind: 'merchant' });
		const owner = await session();
		const texts = `/v1/dashboard/websites/${websiteId}/texts`;
		expect((await dash(merchant, 'PUT', `${texts}/form.count`, { value: 'Du hast {count} Notizen' })).status).toBe(422);
		expect((await dash(merchant, 'PUT', `${texts}/form.count`, { value: '{name}: {count} Notizen' })).status).toBe(204);
		expect((await dash(merchant, 'PUT', `${texts}/form.title`, { value: '' })).status).toBe(422);
		expect((await dash(merchant, 'PUT', `${texts}/form.title`, {})).status).toBe(422);
		expect((await dash(merchant, 'PUT', `${texts}/nope`, { value: 'x' })).status).toBe(404);
		expect((await dash(owner, 'PUT', '/v1/dashboard/defaults/text.inbox.empty', { value: 'Keine Notizen' })).status).toBe(204);
		expect(await product.settings.texts(websiteId)).toEqual({
			'form.title': 'Leave a note',
			'form.count': '{name}: {count} Notizen',
			'inbox.empty': 'Keine Notizen',
		});
		const listed = await (await dash(merchant, 'GET', texts)).json();
		expect(listed.texts[1]).toEqual({
			key: 'form.count',
			english: 'You left {count} notes, {name}',
			value: '{name}: {count} Notizen',
			source: 'website',
		});
		expect((await dash(merchant, 'DELETE', `${texts}/form.count`)).status).toBe(204);
		expect((await product.settings.texts(websiteId))['form.count']).toBe('You left {count} notes, {name}');
	});

	it('stores the theme per field with global defaults', async () => {
		const { session, dash, websiteId, product } = await setup();
		const merchant = await session({ kind: 'merchant' });
		const owner = await session();
		const theme = `/v1/dashboard/websites/${websiteId}/theme`;
		expect(await (await dash(merchant, 'GET', theme)).json()).toEqual({
			theme: { colors: {}, fontFamily: 'inherit', radius: 8, mode: 'auto', customCss: '' },
			sources: { colors: 'built-in', fontFamily: 'built-in', radius: 'built-in', mode: 'built-in', customCss: 'built-in' },
		});
		for (const bad of [
			{ radius: 30 },
			{ colors: { accent: 'red' } },
			{ mode: 'night' },
			{ fontFamily: 'x;}' },
			{ customCss: 'a'.repeat(21_000) },
			{ other: 1 },
			{},
		]) {
			expect((await dash(merchant, 'PUT', theme, bad)).status).toBe(422);
		}
		const saved = await (
			await dash(merchant, 'PUT', theme, { colors: { accent: '#ff0000' }, radius: 4, fontFamily: 'Inter', customCss: '.x{}' })
		).json();
		expect(saved.theme).toMatchObject({ colors: { accent: '#ff0000' }, radius: 4, fontFamily: 'Inter', customCss: '.x{}' });
		expect((await dash(owner, 'PUT', '/v1/dashboard/defaults/theme', { value: { mode: 'dark' } })).status).toBe(204);
		expect(await product.settings.theme(websiteId)).toMatchObject({ mode: 'dark', radius: 4 });
		expect((await dash(merchant, 'PUT', theme, { radius: null })).status).toBe(200);
		expect((await product.settings.theme(websiteId)).radius).toBe(8);
		const defaults = await (await dash(owner, 'GET', '/v1/dashboard/defaults')).json();
		expect(defaults.theme.theme.mode).toBe('dark');
		expect(defaults.texts).toHaveLength(3);
		expect(defaults.features[0].values.maxNotes.source).toBe('built-in');
		expect(defaults.recentChanges[0]).toMatchObject({ what: 'defaults', websiteId: null });
	});
});

describe('overview and business.json', () => {
	it('shows status, features on, today’s cost, the checklist and Recent changes', async () => {
		const { session, dash, websiteId, portal, handlers, switchOn, call, browser, settle, clock } = await setup();
		let served = 0;
		handlers[`https://${DOMAIN}`] = async () => {
			served += 1;
			return new Response(JSON.stringify(BUSINESS), { headers: { 'content-type': 'application/json' } });
		};
		portal.setStatus(websiteId, { status: 'grace', graceEndsAt: '2026-10-02T00:00:00.000Z', todayMillicredits: 4200 });
		await switchOn(['notes']);
		const cookie = await session({ kind: 'merchant' });
		expect(served).toBeGreaterThan(0);
		const overview = await (await dash(cookie, 'GET', `/v1/dashboard/websites/${websiteId}/overview`)).json();
		expect(overview).toMatchObject({
			website: { websiteId, domain: DOMAIN, merchantName: 'Example Shop' },
			status: { status: 'grace', graceEndsAt: '2026-10-02T00:00:00.000Z' },
			featuresOn: ['notes'],
			todayMillicredits: 4200,
			checklist: {
				connections: [{ name: 'database', status: 'not_connected' }],
				widget: { installed: false, lastSeenAt: null },
				business: { found: true },
			},
		});
		await call('GET', '/v1/notes', { token: browser.token, origin: `https://${DOMAIN}` });
		await settle();
		const seen = await (await dash(cookie, 'GET', `/v1/dashboard/websites/${websiteId}/overview`)).json();
		expect(seen.checklist.widget.installed).toBe(true);
		clock.advance(8 * 24 * 60 * 60_000);
		const later = await session({ kind: 'merchant' });
		const old = await (await dash(later, 'GET', `/v1/dashboard/websites/${websiteId}/overview`)).json();
		expect(old.checklist.widget.installed).toBe(false);
	});

	it('reads business.json with defaults, keeps the last good copy and refreshes stale copies after a request', async () => {
		const { session, dash, websiteId, handlers, product, call, server, settle, clock } = await setup();
		let answer = () => new Response('nope', { status: 404 });
		handlers[`https://${DOMAIN}`] = async () => answer();
		const cookie = await session({ kind: 'merchant' });
		const refresh = `/v1/dashboard/websites/${websiteId}/business/refresh`;
		expect(await (await dash(cookie, 'POST', refresh)).json()).toEqual({
			found: false,
			business: { name: DOMAIN, logo: null, email: null, phone: null, address: null, country: null, timeZone: 'UTC' },
		});
		answer = () => new Response(JSON.stringify(BUSINESS), { status: 200 });
		expect(await (await dash(cookie, 'POST', refresh)).json()).toMatchObject({
			found: true,
			business: { name: 'Example Shop', country: 'GB', timeZone: 'Europe/London' },
		});
		answer = () => new Response('{"name":', { status: 200 });
		expect(await (await dash(cookie, 'POST', refresh)).json()).toMatchObject({
			found: false,
			business: { name: 'Example Shop' },
		});
		expect(await product.business(websiteId)).toMatchObject({ name: 'Example Shop' });
		answer = () => new Response(JSON.stringify({ name: 'Renamed' }), { status: 200 });
		clock.advance(25 * 60 * 60_000);
		await call('GET', '/v1/server/open', { token: server.token });
		await settle();
		expect(await product.business(websiteId)).toEqual({
			name: 'Renamed',
			logo: null,
			email: null,
			phone: null,
			address: null,
			country: null,
			timeZone: 'UTC',
		});
		await expect(product.business('web_unknown')).rejects.toMatchObject({ code: 'website_not_found' });
	});
});

describe('product helpers', () => {
	it('exposes serving, features on and Recent changes', async () => {
		const { product, websiteId, switchOn, clock } = await setup();
		expect(await product.serving(websiteId)).toMatchObject({ ok: true, status: { status: 'active' } });
		await switchOn(['notes']);
		expect(await product.featuresOn(websiteId)).toEqual(['notes']);
		clock.advance(1);
		await product.recentChanges.record({
			websiteId,
			who: { kind: 'merchant', id: 'm', name: 'M' },
			what: 'settings',
			detail: 'x',
		});
		expect((await product.recentChanges.list(websiteId))[0]).toMatchObject({
			who: { kind: 'merchant', id: 'm', name: 'M' },
			what: 'settings',
		});
		expect(BASE).toBe('https://notes.example.dev');
	});
});
