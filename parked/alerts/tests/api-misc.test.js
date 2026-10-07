/** Alert types, waitlist tiers from identity claims, analytics, dashboard, adapters and the request handler. */
import { afterEach, describe, expect, it } from 'vitest';
import { createRequestHandler, noopLogger } from '@ss/app-kit';
import { generateSigningKey } from '@ss/protocol';
import { createPlatform, loadManifest, loadStrings } from '../adapters/platform.js';
import { createTokens, randomId, stableId, tokenSecret } from '../adapters/tokens.js';
import { resolveDashboard } from '../api/dashboard.js';
import { buildRoutes, createAlerts, wireEvents } from '../api/routes.js';
import { fromServer } from '../api/events.js';
import { escapeHtml } from '../api/pages.js';
import { sessionView } from '../api/session.js';
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
	it('resolves sessions: sign-in, live (overview, subscriptions, messages), not subscribed, pick a website', async () => {
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
		expect(await live.data.overview()).toMatchObject({ active: 0, analytics: { messages: { sent: 1 } } });
		expect((await live.data.subscriptions())[0]).toMatchObject({ status: 'notified', contact: null });
		expect((await live.data.messages())[0]).toMatchObject({ status: 'sent' });
		const route = await t.call('GET', '/v1/dashboard/overview', { key: merchant });
		expect(route.json).toMatchObject({ active: 0, analytics: { subscriptions: { total: 1 } } });
		expect((await t.call('GET', '/v1/session', { key: merchant })).json).toMatchObject({ kind: 'merchant', role: 'merchant' });
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

	it('describes who is signed in', () => {
		expect(sessionView({ kind: 'admin', role: 'platform_admin', scope: { merchantId: MERCHANT } })).toEqual({
			kind: 'admin',
			role: 'platform_admin',
			scope: { merchantId: MERCHANT },
			user: null,
		});
		expect(sessionView({ kind: 'merchant', role: 'merchant', subject: 'usr_1' }).user).toBe('usr_1');
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
		expect(tokenSecret({ signingKey: `${privateJwk.kid}:${privateJwk.d}` })).toHaveLength(32);
		expect(() => tokenSecret({ secret: 'short', signingKey: null })).toThrow(/generated secret/);
		expect(randomId('als')).toMatch(/^als_[0-9a-z]{26}$/);
		expect(stableId('alm', 'k')).toBe(stableId('alm', 'k'));
	});

	it('loads the project files and refuses to start without its environment', async () => {
		const manifest = await loadManifest(ROOT);
		expect(manifest.elements.every((/** @type {any} */ element) => element.features.type === 'object')).toBe(true);
		expect(Object.keys(await loadStrings(ROOT))).toEqual(['en']);
		// no environment at all: an unconnected product (in-memory control store) that only serves its connect endpoint
		const unconnected = await createPlatform({ env: {}, root: ROOT });
		expect(unconnected.product.connected()).toBe(false);
		await unconnected.close?.();
	});

	it('serves the routes with a control database', async () => {
		const { privateJwk } = await generateSigningKey({ kid: 'alerts-serve-1' });
		const alerts = wireEvents(
			createAlerts(
				await createPlatform({
					root: ROOT,
					env: { MONGODB_URI: mongoUri(`alerts_control_${Date.now()}`) },
					overrides: {
						portalUrl: 'https://portal.test',
						signingKey: `${privateJwk.kid}:${privateJwk.d}`,
						logger: noopLogger,
					},
				}),
			),
		);
		const handle = createRequestHandler(alerts.product, buildRoutes(alerts));
		const base = 'https://alerts.example.com';
		try {
			expect((await handle(new Request(`${base}/.well-known/ss-app.json`))).status).toBe(200);
			const page = await handle(new Request(`${base}/u/garbage`));
			expect(page.status).toBe(404);
			expect(page.headers.get('content-type')).toMatch(/text\/html/);
			expect((await handle(new Request(`${base}/u/garbage`, { method: 'POST', body: 'x' }))).status).toBe(404);
		} finally {
			await alerts.app.close();
		}
	});
});

describe('helpers', () => {
	it('escapes page text and classifies event provenance', () => {
		expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
		expect(fromServer({ actor: { type: 'merchant' } }, { source: 'portal' })).toBe(true);
		expect(fromServer({ actor: { type: 'customer' } }, { source: 'portal' })).toBe(false);
		expect(fromServer({ actor: { type: 'merchant' } }, { source: 'site', website: { kind: 'pk' } })).toBe(false);
		expect(fromServer({ actor: { type: 'system' } }, { source: 'site', website: { kind: 'sk' } })).toBe(true);
		expect(fromServer({}, undefined)).toBe(true);
	});
});
