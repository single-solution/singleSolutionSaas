/** Alert types, waitlist tiers from identity claims, analytics, dashboard, privacy, adapters and the plain server. */
import { MongoClient } from 'mongodb';
import { afterEach, describe, expect, it } from 'vitest';
import { noopLogger } from '@ss/app-kit';
import { generateSigningKey, hashRegistrationToken } from '@ss/protocol';
import { createPlatform, loadManifest, loadStrings } from '../adapters/platform.js';
import { createSiteRegistry } from '../adapters/registry.js';
import { createTokens, randomId, stableId, tokenSecret, unverifiedClaims } from '../adapters/tokens.js';
import { demoDashboard, resolveDashboard } from '../api/dashboard.js';
import { fromServer } from '../api/events.js';
import { escapeHtml } from '../api/pages.js';
import { sessionView } from '../api/session.js';
import { cronAuthorized, runDispatchJob } from '../jobs/dispatch.js';
import { startServer } from '../serve.js';
import { createHarness, MERCHANT, mongoUri, ROOT, WEBSITE, WEBSITE_2 } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>> | null} */
let h = null;
afterEach(async () => {
	await h?.close();
	h = null;
});
/** @param {Parameters<typeof createHarness>[0]} [options] */
const harness = async (options) => (h = await createHarness(options));

describe('alert types', () => {
	it('tells the widget which types, channels and form rules apply (pk_)', async () => {
		const t = await harness({
			config: {
				types: { custom_types: [{ key: 'vip', name: 'VIP drop', event: 'custom.vip' }] },
				capture: { channels: ['email', 'sms'] },
			},
		});
		const types = await t.call('GET', '/v1/alert-types', { key: t.pk });
		expect(types.status).toBe(200);
		expect(types.json).toEqual({
			items: [
				{ type: 'back_in_stock', name: 'back_in_stock' },
				{ type: 'price_drop', name: 'price_drop', priceDrop: { minPercent: 0, minAmount: 0, allowTarget: true } },
				{ type: 'custom:vip', name: 'VIP drop' },
			],
			capture: { channels: ['email', 'sms'], requireConsent: true, doubleOptIn: false, allowEntry: true, defaultLang: 'en' },
			waitlist: { order: 'fifo', showPosition: true },
		});
		expect(types.headers.get('access-control-allow-origin')).toBe('https://shop.example.com');
	});
});

describe('waitlist priority from the customer’s login token', () => {
	it('ranks by the tier claim and shows customers their own position', async () => {
		const t = await harness({
			identity: true,
			config: { waitlist_priority: { order: 'tier', tier_claim: 'loyalty.tier', tiers: [{ key: 'gold', rank: 0 }] } },
		});
		const plain = await t.subscribe(
			{ email: 'a@example.com' },
			{ key: t.pk, headers: { 'ss-identity': await t.login({ sub: 'c_a', email: 'a@example.com' }) } },
		);
		t.clock.advance(1000);
		const goldToken = await t.login({ sub: 'c_g', email: 'g@example.com', loyalty: { tier: 'gold' } });
		const gold = await t.subscribe({}, { key: t.pk, headers: { 'ss-identity': goldToken } });
		expect(gold.json).toMatchObject({ tier: 'gold', position: 1 });
		const mine = await t.call('GET', `/v1/waitlist/position?subscriptionId=${plain.json.id}`, {
			key: t.pk,
			headers: { 'ss-identity': await t.login({ sub: 'c_a' }) },
		});
		expect(mine.json).toMatchObject({ position: 2, ahead: 1 });
		expect(
			(
				await t.call('GET', `/v1/waitlist/position?subscriptionId=${plain.json.id}`, {
					key: t.pk,
					headers: { 'ss-identity': goldToken },
				})
			).status,
		).toBe(404);
		expect(
			(await t.call('GET', `/v1/subscriptions/${gold.json.id}`, { key: t.pk, headers: { 'ss-identity': goldToken } })).json
				.position,
		).toBe(1);
	});

	it('is an add-on: off means FIFO and no waitlist routes', async () => {
		const t = await harness({ elements: { waitlist_priority: false } });
		const created = await t.subscribe({ tier: 'gold' });
		expect(created.json.position).toBeUndefined();
		expect((await t.call('GET', '/v1/waitlist?type=back_in_stock&itemId=itm_1')).status).toBe(403);
	});
});

describe('analytics', () => {
	it('reports subscriptions, messages, rates and a daily series (sk_, bounded window)', async () => {
		const t = await harness({ config: { analytics: { max_window_days: 10, default_window_days: 7 } } });
		await t.subscribe({}, { key: t.pk });
		await t.subscribe({ itemId: 'itm_2' }, { key: t.pk });
		await t.deliver('inventory.changed@1', { itemId: 'itm_1', quantity: 1, previousQuantity: 0 });
		const report = await t.call('GET', '/v1/analytics');
		expect(report.status).toBe(200);
		expect(report.json.subscriptions).toMatchObject({ total: 2, byStatus: { notified: 1, pending: 1 } });
		expect(report.json.messages).toMatchObject({ sent: 1, failed: 0, alertsDelivered: 1, byChannel: { email: { sent: 1 } } });
		expect(report.json.rates).toEqual({ notifiedBps: 5000, unsubscribedBps: 0, deliveryBps: 10_000 });
		expect(report.json.daily).toHaveLength(7);
		expect(report.json.daily.at(-1)).toEqual({ day: '2026-10-01', subscribed: 2, sent: 1 });
		expect((await t.call('GET', '/v1/analytics?days=3')).json.daily).toHaveLength(3);
		expect((await t.call('GET', '/v1/analytics?days=11')).status).toBe(422);
		expect((await t.call('GET', '/v1/analytics?days=x')).status).toBe(422);
		expect((await t.call('GET', '/v1/analytics', { key: t.pk })).status).toBe(403);
	});
});

describe('dashboard', () => {
	it('resolves sessions: sign-in, demo, live (overview, subscriptions, messages), not subscribed, pick a website', async () => {
		const t = await harness();
		await t.subscribe({}, { key: t.pk });
		await t.deliver('inventory.changed@1', { itemId: 'itm_1', quantity: 1, previousQuantity: 0 });
		const alerts = t.alerts;
		expect(await resolveDashboard({ alerts, sessionId: null })).toEqual({ state: 'signin' });
		expect(await resolveDashboard({ alerts, sessionId: 'ses_missing' })).toEqual({ state: 'signin' });
		/** @param {Record<string, any>} claims */
		const sessionFor = async (claims) => {
			const { token } = await t.portal.issueLaunch(/** @type {any} */ ({ user: { id: String(claims.subject) }, ...claims }));
			const exchanged = await alerts.product.launch.exchange(token);
			if (!exchanged.ok) throw new Error(exchanged.code);
			return exchanged.session.id;
		};
		const merchant = await sessionFor({
			kind: 'merchant',
			subject: 'usr_1',
			user: { id: 'usr_1' },
			scope: { merchantId: MERCHANT, websiteId: WEBSITE },
		});
		const live = await resolveDashboard({ alerts, sessionId: merchant });
		if (live.state !== 'ready') throw new Error(live.state);
		expect(live.data.demo).toBe(false);
		expect(await live.data.overview()).toMatchObject({ active: 0, analytics: { messages: { sent: 1 } } });
		expect((await live.data.subscriptions())[0]).toMatchObject({ status: 'notified', contact: null });
		expect((await live.data.messages())[0]).toMatchObject({ status: 'sent' });
		const route = await t.call('GET', '/v1/dashboard/overview', { key: merchant });
		expect(route.json).toMatchObject({ active: 0, analytics: { subscriptions: { total: 1 } } });
		expect((await t.call('GET', '/v1/session', { key: merchant })).json).toMatchObject({ kind: 'merchant', role: 'merchant' });
		const demo = await sessionFor({ kind: 'demo', subject: 'usr_demo', scope: {} });
		const sandbox = await resolveDashboard({ alerts, sessionId: demo });
		if (sandbox.state !== 'ready') throw new Error(sandbox.state);
		expect(sandbox.data.demo).toBe(true);
		const other = await sessionFor({
			kind: 'merchant',
			subject: 'usr_2',
			scope: { merchantId: MERCHANT, websiteId: WEBSITE_2 },
		});
		expect((await resolveDashboard({ alerts, sessionId: other })).state).toBe('not_subscribed');
		const admin = await sessionFor({ kind: 'merchant', subject: 'usr_3', scope: { merchantId: MERCHANT } });
		expect((await resolveDashboard({ alerts, sessionId: admin })).state).toBe('pick_website');
		expect((await t.call('GET', '/v1/dashboard/overview', { key: admin })).status).toBe(400);
	});

	it('builds demo data with the real type rules', async () => {
		const demo = demoDashboard({ now: Date.parse('2026-10-01T00:00:00Z') });
		const overview = await demo.overview();
		expect(overview.active).toBe(1);
		expect(overview.analytics.messages.sent).toBe(3);
		expect((await demo.subscriptions()).map((s) => s.status)).toEqual(['notified', 'notified', 'notified', 'pending']);
		expect(await demo.messages()).toHaveLength(3);
		expect(sessionView({ kind: 'impersonate', role: 'impersonate', scope: { actor: 'staff_1' } })).toEqual({
			kind: 'impersonate',
			role: 'impersonate',
			scope: { actor: 'staff_1' },
			user: null,
			actor: 'staff_1',
		});
		expect(sessionView({ kind: 'merchant', role: 'merchant', subject: 'usr_1' }).user).toBe('usr_1');
	});
});

describe('privacy', () => {
	it('exports and anonymises a subject by customer id, e-mail or phone', async () => {
		const t = await harness({ config: { capture: { channels: ['email', 'sms'] } } });
		await t.subscribe({ customerId: 'cus_1' });
		await t.subscribe({ itemId: 'itm_2', channel: 'sms', phone: '+447700900123', email: undefined });
		await t.deliver('inventory.changed@1', { itemId: 'itm_1', quantity: 1, previousQuantity: 0 });
		const privacy = t.alerts.product.context.privacy;
		const all = await privacy.export({ websiteId: WEBSITE });
		expect(all.collections.subscriptions).toHaveLength(2);
		const byEmail = await privacy.export({ websiteId: WEBSITE, subject: { email: 'JANE@example.com' } });
		expect(byEmail).toMatchObject({ subject: { email: 'JANE@example.com' } });
		expect(byEmail.collections.subscriptions).toHaveLength(1);
		expect(byEmail.collections.messages).toHaveLength(1);
		const anonymized = await privacy.anonymize({ websiteId: WEBSITE, subject: { customerId: 'cus_1' } });
		expect(anonymized.anonymized).toEqual({ subscriptions: 1, messages: 1 });
		const byPhone = await privacy.anonymize({ websiteId: WEBSITE, subject: { phone: '+44 7700 900123' } });
		expect(byPhone.anonymized.subscriptions).toBe(1);
		const rows = await t.collection('subscriptions').find({ websiteId: WEBSITE }).toArray();
		expect(rows.every((row) => row.address === null && row.anonymizedAt)).toBe(true);
		expect(rows.find((row) => row.target.itemId === 'itm_2')?.status).toBe('unsubscribed');
		expect((await t.collection('messages').findOne({ websiteId: WEBSITE }))?.to).toBeNull();
		expect(await privacy.anonymize({ websiteId: WEBSITE })).toEqual({
			websiteId: WEBSITE,
			anonymized: { subscriptions: 0, messages: 0 },
		});
	});
});

describe('adapters', () => {
	it('signs and verifies link tokens bound to purpose and expiry', () => {
		let now = 1_000_000;
		const tokens = createTokens({ secret: Buffer.alloc(32, 1), now: () => now });
		const token = tokens.issue('unsubscribe', { websiteId: 'w', subscriptionId: 's', contactKey: 'k', ttlSeconds: 10 });
		expect(tokens.verify('unsubscribe', token)).toEqual({
			websiteId: 'w',
			subscriptionId: 's',
			contactKey: 'k',
			expiresAt: 1_060_000,
		});
		expect(tokens.verify('confirm', token)).toBeNull();
		expect(tokens.verify('unsubscribe', `${token}x`)).toBeNull();
		expect(tokens.verify('unsubscribe', 'us1.e30.sig')).toBeNull();
		expect(tokens.verify('unsubscribe', 5)).toBeNull();
		expect(tokens.verify('unsubscribe', 'us1')).toBeNull();
		const bad = 'us1.bm90IGpzb24';
		const forged = createTokens({ secret: Buffer.alloc(32, 1) });
		expect(forged.verify('unsubscribe', `${bad}.${token.split('.')[2]}`)).toBeNull();
		now += 61_000;
		expect(tokens.verify('unsubscribe', token)).toBeNull();
		expect(tokens.contactKey('w', 'email:a@b.co')).toMatch(/^ck_[\w-]{32}$/);
		expect(tokens.contactKey('w', 'email:a@b.co')).not.toBe(tokens.contactKey('w2', 'email:a@b.co'));
		expect(tokens.subjectKey('w', '1.2.3.4')).toHaveLength(32);
	});

	it('derives secrets, ids and decodes verified claims', async () => {
		const { privateJwk } = await generateSigningKey({ kid: 'k1' });
		expect(tokenSecret({ secret: 'x'.repeat(32) })).toEqual(Buffer.from('x'.repeat(32)));
		expect(tokenSecret({ signingKey: JSON.stringify(privateJwk) })).toHaveLength(32);
		expect(() => tokenSecret({ secret: 'short', signingKey: null })).toThrow(/ALERTS_TOKEN_SECRET/);
		expect(randomId('als')).toMatch(/^als_[0-9a-z]{26}$/);
		expect(stableId('alm', 'k')).toBe(stableId('alm', 'k'));
		expect(unverifiedClaims(`h.${Buffer.from('{"tier":"gold"}').toString('base64url')}.s`)).toEqual({ tier: 'gold' });
		expect(unverifiedClaims('h.bm9wZQ.s')).toBeNull();
		expect(unverifiedClaims(`h.${Buffer.from('[1]').toString('base64url')}.s`)).toBeNull();
		expect(unverifiedClaims('nodots')).toBeNull();
		expect(unverifiedClaims(null)).toBeNull();
	});

	it('remembers websites in the control database', async () => {
		const client = await new MongoClient(mongoUri(`alerts_registry_${Date.now()}`)).connect();
		try {
			const registry = createSiteRegistry({ collection: client.db().collection('ss_alerts_sites') });
			await registry.remember('web_b');
			await registry.remember('web_a');
			await registry.remember('web_a');
			expect(await registry.list()).toEqual(['web_a', 'web_b']);
			const failing = createSiteRegistry({
				collection: { updateOne: async () => Promise.reject(new Error('down')), find: () => ({ toArray: async () => [] }) },
			});
			await failing.remember('web_c');
			expect(await failing.list()).toEqual([]);
			await client.db().dropDatabase();
		} finally {
			await client.close();
		}
	});

	it('loads the project files and refuses to start without its environment', async () => {
		const manifest = await loadManifest(ROOT);
		expect(manifest.elements.every((/** @type {any} */ element) => element.features.type === 'object')).toBe(true);
		expect(Object.keys(await loadStrings(ROOT))).toEqual(['en']);
		await expect(createPlatform({ env: {}, root: ROOT })).rejects.toThrow(
			/SS_PORTAL_URL, SS_APP_SIGNING_KEY, SS_REGISTRATION_TOKEN_HASH/,
		);
	});

	it('serves the routes over plain node:http with a control database', async () => {
		const { privateJwk } = await generateSigningKey({ kid: 'alerts-serve-1' });
		const server = await startServer({
			port: 0,
			root: ROOT,
			env: {
				SS_PORTAL_URL: 'https://portal.test',
				SS_APP_SIGNING_KEY: JSON.stringify(privateJwk),
				SS_REGISTRATION_TOKEN_HASH: hashRegistrationToken('rt_alerts_serve_0123456789abcdef'),
				SS_PRODUCT_DB_URI: mongoUri(`alerts_control_${Date.now()}`),
				CRON_SECRET: 'short',
			},
			overrides: { logger: noopLogger },
		});
		try {
			const health = await fetch(`${server.url}/healthz`);
			expect(health.status).toBe(200);
			const page = await fetch(`${server.url}/u/garbage`);
			expect(page.status).toBe(404);
			expect(page.headers.get('content-type')).toMatch(/text\/html/);
			const posted = await fetch(`${server.url}/u/garbage`, { method: 'POST', body: 'x' });
			expect(posted.status).toBe(404);
			expect(server.alerts.app.cronSecret).toBeNull();
		} finally {
			await server.close();
		}
	});
});

describe('jobs and helpers', () => {
	it('isolates failing websites in the cron job', async () => {
		/** @type {string[]} */
		const errors = [];
		const result = await runDispatchJob({
			websiteIds: ['a', 'b', 'c'],
			siteFor: async (id) => (id === 'c' ? null : { id }),
			run: async (site) => {
				if (site.id === 'a') throw new Error('boom');
				return { sent: 1 };
			},
			onError: (id) => errors.push(id),
		});
		expect(result).toEqual({
			websites: 2,
			results: [
				{ websiteId: 'a', error: 'failed' },
				{ websiteId: 'b', sent: 1 },
			],
		});
		expect(errors).toEqual(['a']);
		expect(
			(await runDispatchJob({ websiteIds: ['x'], siteFor: async () => Promise.reject(new Error('x')), run: async () => ({}) }))
				.results,
		).toEqual([{ websiteId: 'x', error: 'failed' }]);
		expect(cronAuthorized('Bearer secret-secret', 'secret-secret')).toBe(true);
		expect(cronAuthorized(null, 'secret')).toBe(false);
		expect(cronAuthorized('Bearer x', null)).toBe(false);
	});

	it('escapes page text and classifies event provenance', () => {
		expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
		expect(fromServer({ actor: { type: 'merchant' } }, { source: 'portal' })).toBe(true);
		expect(fromServer({ actor: { type: 'customer' } }, { source: 'portal' })).toBe(false);
		expect(fromServer({ actor: { type: 'merchant' } }, { source: 'site', website: { kind: 'pk' } })).toBe(false);
		expect(fromServer({ actor: { type: 'system' } }, { source: 'site', website: { kind: 'sk' } })).toBe(true);
		expect(fromServer({}, undefined)).toBe(true);
	});
});
