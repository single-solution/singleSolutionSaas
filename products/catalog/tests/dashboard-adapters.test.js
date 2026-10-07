/** Dashboard resolution (sign-in, pick website, not subscribed, live data) and the adapters (tokens, platform). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateSigningKey } from '@ss/protocol';
import { createHmac } from 'node:crypto';
import { dashboardActor, exportParamsOf, resolveDashboard, statusLabel } from '../api/dashboard.js';
import { sessionView } from '../api/session.js';
import { createPlatform } from '../adapters/platform.js';
import {
	EXPORT_LINK_MAX_MS,
	createExportLinks,
	createFeedTokens,
	etagOf,
	exportSecret,
	feedSecret,
	newId,
	stableId,
} from '../adapters/tokens.js';
import { MERCHANT, ROOT, WEBSITE, WEBSITE_2, createHarness, mongoUri } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;

beforeAll(async () => {
	h = await createHarness();
	await h.call('POST', '/v1/items', { body: { title: 'Dash item', status: 'active', price: 1200, cost: 600, quantity: 1 } });
}, 60_000);

afterAll(async () => {
	await h?.close();
});

describe('dashboard', () => {
	it('resolves sessions to states and serves live data', async () => {
		const { catalog } = h;
		expect(await resolveDashboard({ catalog, sessionId: undefined })).toEqual({ state: 'signin' });
		expect((await resolveDashboard({ catalog, sessionId: 'ses_nope' })).state).toBe('signin');
		const merchant = await h.session('merchant');
		const ready = await resolveDashboard({ catalog, sessionId: merchant, website: WEBSITE });
		expect(ready.state).toBe('ready');
		if (ready.state !== 'ready') throw new Error('not ready');
		expect(ready.portalLink).toContain(`/websites/${WEBSITE}/subscriptions/`);
		expect(ready.data).toMatchObject({ canWrite: true, websiteId: WEBSITE });
		expect(statusLabel(ready.data.settings, 'active')).toBe('Active');
		const stats = await ready.data.stats();
		expect(stats.items.total).toBe(1);
		const page = await ready.data.items({ status: 'active' });
		expect(page.items[0]).toMatchObject({ title: 'Dash item', variants: [{ cost: 600 }] });
		expect((await ready.data.items({ cursor: 'not-a-cursor' })).items).toEqual([]);
		expect(await ready.data.item(String(page.items[0]?.id))).toMatchObject({ title: 'Dash item' });
		expect(await ready.data.item('bad id')).toBeNull();
		expect((await ready.data.feeds()).length).toBe(1);
		const unscoped = await h.session('merchant', { scope: { merchantId: MERCHANT } });
		expect((await resolveDashboard({ catalog, sessionId: unscoped })).state).toBe('pick_website');
		const other = await h.session('merchant', { scope: { merchantId: MERCHANT, websiteIds: [WEBSITE_2] } });
		expect((await resolveDashboard({ catalog, sessionId: other })).state).toBe('not_subscribed');
	});

	it('names actors', () => {
		expect(dashboardActor({ kind: 'merchant', role: 'merchant', user: { id: 'usr_1' } })).toEqual({
			type: 'merchant',
			id: 'usr_1',
		});
		expect(dashboardActor({ kind: 'admin', role: 'platform_admin', subject: 'stf_1' })).toEqual({ type: 'staff', id: 'stf_1' });
		expect(dashboardActor({ kind: 'merchant', role: 'merchant' })).toEqual({ type: 'merchant', id: 'unknown' });
		expect(sessionView({ kind: 'admin', role: 'platform_admin' })).toEqual({
			kind: 'admin',
			role: 'platform_admin',
			scope: {},
			user: null,
		});
	});
});

describe('adapters', () => {
	it('issues and verifies feed tokens; derives secrets; ids and ETags', () => {
		const tokens = createFeedTokens({ secret: Buffer.alloc(32, 1) });
		const token = tokens.issue({ websiteId: 'web_1', feedKey: 'shopping', version: 3 });
		expect(tokens.verify(token)).toEqual({ websiteId: 'web_1', feedKey: 'shopping', version: 3 });
		expect(tokens.verify(`${token}x`)).toBeNull();
		expect(tokens.verify(token.replace('fd1', 'fd2'))).toBeNull();
		expect(tokens.verify(`${token}.extra`)).toBeNull();
		expect(tokens.verify(42)).toBeNull();
		expect(createFeedTokens({ secret: Buffer.alloc(32, 2) }).verify(token)).toBeNull();
		const forged = createFeedTokens({ secret: Buffer.alloc(32, 1) });
		const [, , signature] = token.split('.');
		expect(forged.verify(`fd1.${Buffer.from('not json').toString('base64url')}.${signature}`)).toBeNull();
		expect(feedSecret({ secret: 's'.repeat(32) }).toString()).toBe('s'.repeat(32));
		expect(feedSecret({ signingKey: `k:${Buffer.alloc(32, 3).toString('base64url')}` })).toHaveLength(32);
		expect(() => feedSecret({ signingKey: {} })).toThrow(/generated secret/);
		expect(stableId('a')).toHaveLength(26);
		expect(stableId('a')).toBe(stableId('a'));
		expect(newId('itm')).toMatch(/^itm_[0-9a-z]{26}$/);
		expect(etagOf('x')).toMatch(/^"[A-Za-z0-9_-]{27}"$/);
	});

	it('issues short-lived signed export links and refuses tampered, malformed and expired ones', () => {
		let now = 1_000_000;
		const secret = exportSecret({ secret: 's'.repeat(32) });
		expect(secret).toHaveLength(32);
		expect(secret.equals(feedSecret({ secret: 's'.repeat(32) }))).toBe(false); // its own derived key
		expect(exportSecret({ signingKey: { d: Buffer.alloc(32, 3).toString('base64url') } })).toHaveLength(32);
		expect(() => exportSecret({ signingKey: 'k:' })).toThrow(/generated secret/);
		const links = createExportLinks({ secret, now: () => now, ttlMs: 60 * 60_000 });
		const { token, expiresAt } = links.issue({ websiteId: 'web_1', kind: 'items', params: { q: 'shirt' } });
		expect(Date.parse(expiresAt) - now).toBe(EXPORT_LINK_MAX_MS); // clamped to five minutes
		expect(links.verify(token)).toEqual({ ok: true, websiteId: 'web_1', kind: 'items', params: { q: 'shirt' } });
		const [, , signature] = token.split('.');
		/** @param {unknown} claims */
		const signed = (claims) => {
			const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
			const sig = createHmac('sha256', secret).update(`ex1.${payload}`).digest('base64url');
			return `ex1.${payload}.${sig}`;
		};
		const e = now + 1000;
		for (const bad of [
			42,
			'x'.repeat(3000),
			`${token}.extra`,
			token.replace('ex1', 'ex2'),
			`ex1.${Buffer.from('{}').toString('base64url')}.${signature}`,
			`ex1.${Buffer.from('not json').toString('base64url')}.${createHmac('sha256', secret)
				.update(`ex1.${Buffer.from('not json').toString('base64url')}`)
				.digest('base64url')}`,
			signed({ w: 'web_1', k: 'items', p: [], e }),
			signed({ w: 'web_1', k: 'items', p: { q: 1 }, e }),
			signed({ w: 'web_1', k: 'items', p: null, e }),
			signed({ w: 'web_1', k: 'items', p: {}, e: 'soon' }),
			signed({ w: 1, k: 'items', p: {}, e }),
			signed(null),
		])
			expect(links.verify(bad)).toEqual({ ok: false, reason: 'invalid' });
		expect(createExportLinks({ secret: Buffer.alloc(32, 9) }).verify(token)).toEqual({ ok: false, reason: 'invalid' });
		expect(
			Date.parse(
				createExportLinks({ secret, now: () => now, ttlMs: 1 }).issue({ websiteId: 'w', kind: 'k', params: {} }).expiresAt,
			) - now,
		).toBe(1_000);
		now += EXPORT_LINK_MAX_MS;
		expect(links.verify(token)).toEqual({ ok: false, reason: 'expired' });
		expect(exportParamsOf(undefined)).toEqual({});
		expect(exportParamsOf({})).toEqual({});
		expect(exportParamsOf({ params: { q: 'a', 'filter[status]': 'active' } })).toEqual({ 'filter[status]': 'active', q: 'a' });
		expect(exportParamsOf([])).toBeNull();
		expect(exportParamsOf({ params: { q: 'x'.repeat(201) } })).toBeNull();
		expect(
			exportParamsOf({ params: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`filter[f${i}]`, 'x'])) }),
		).toBeNull();
	});

	it('builds the platform from the environment (control database optional) and refuses missing variables', async () => {
		// no environment at all: an unconnected product (in-memory control store) that only serves its connect endpoint
		const unconnected = await createPlatform({ env: {}, root: ROOT });
		expect(unconnected.product.connected()).toBe(false);
		await unconnected.close?.();
		const { privateJwk } = await generateSigningKey({ kid: 'catalog-platform-1' });
		const app = await createPlatform({
			env: {
				MONGODB_URI: mongoUri(`control_${Date.now()}`),
			},
			overrides: { portalUrl: 'https://portal.test', signingKey: `${privateJwk.kid}:${privateJwk.d}` },
			root: ROOT,
		});
		expect(Object.keys(app)).not.toContain('registry');
		expect(app.product.manifest.elements[0].features.properties.max_items).toBeTruthy();
		await app.close();
	});
});
