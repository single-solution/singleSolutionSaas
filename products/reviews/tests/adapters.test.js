/** Adapters: link tokens, ids, the platform wiring (env, control DB, retention) and settings. */
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateSigningKey } from '@ss/protocol';
import { createPlatform, loadStrings, retentionDays } from '../adapters/platform.js';
import { createLinkTokens, linkSecret, randomBytes, stableId } from '../adapters/tokens.js';
import { createRepositories } from '../adapters/db.js';
import { sessionView } from '../api/session.js';
import { settingsFrom } from '../api/settings.js';
import { dashboardActor } from '../api/dashboard.js';
import { failure } from '../api/routes.js';
import { ROOT, mongoUri } from './harness.js';

const T0 = Date.parse('2026-10-01T10:00:00Z');

describe('tokens', () => {
	it('issues review link tokens bound to a website and a request', async () => {
		let now = T0;
		const tokens = createLinkTokens({ secret: Buffer.from('s'.repeat(32)), now: () => now });
		const { token, expiresAt } = tokens.issue({ websiteId: 'web_1', requestId: 'rrq_1', ttlDays: 2 });
		expect(expiresAt).toBe(new Date(T0 + 2 * 86_400_000).toISOString());
		expect(tokens.verify(token, 'web_1')).toBe('rrq_1');
		expect(tokens.verify(token, 'web_2')).toBeNull();
		expect(tokens.verify(`${token}x`, 'web_1')).toBeNull();
		expect(tokens.verify('xx1.a.b', 'web_1')).toBeNull();
		expect(tokens.verify('rl1.only', 'web_1')).toBeNull();
		expect(tokens.verify(42, 'web_1')).toBeNull();
		expect(tokens.verify('x'.repeat(3000), 'web_1')).toBeNull();
		const other = createLinkTokens({ secret: Buffer.from('t'.repeat(32)) });
		expect(other.verify(token, 'web_1')).toBeNull();
		// a valid signature over a payload that is not JSON
		const forged = createLinkTokens({ secret: Buffer.from('s'.repeat(32)), now: () => now });
		const [prefix, ,] = token.split('.');
		const crafted = forged.issue({ websiteId: 'web_1', requestId: 'rrq_1', ttlDays: 1 }).token.split('.');
		expect(forged.verify([prefix, 'bm90LWpzb24', crafted[2]].join('.'), 'web_1')).toBeNull();
		now = T0 + 3 * 86_400_000;
		expect(tokens.verify(token, 'web_1')).toBeNull();
	});

	it('derives the secret from the signing key, or takes a configured one', async () => {
		const { privateJwk } = await generateSigningKey({ kid: 'k1' });
		const derived = linkSecret({ signingKey: `${privateJwk.kid}:${privateJwk.d}` });
		expect(derived).toHaveLength(32);
		expect(linkSecret({ secret: 'short', signingKey: privateJwk }).equals(derived)).toBe(true);
		expect(linkSecret({ secret: 'c'.repeat(40) }).toString()).toBe('c'.repeat(40));
		expect(() => linkSecret({ signingKey: null })).toThrow(/generated secret/);
		expect(stableId('a')).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/);
		expect(stableId('a')).toBe(stableId('a'));
		expect(randomBytes(4)).toHaveLength(4);
	});
});

describe('platform', () => {
	it('refuses to start without the required environment', async () => {
		// no environment at all: an unconnected product (in-memory control store) that only serves its connect endpoint
		const unconnected = await createPlatform({ env: {}, root: ROOT });
		expect(unconnected.product.connected()).toBe(false);
		await unconnected.close?.();
	});

	it('uses the product control database when configured and reads retention from the manifest', async () => {
		const { privateJwk } = await generateSigningKey({ kid: 'k2' });
		const app = await createPlatform({
			env: {
				MONGODB_URI: mongoUri(`reviews_ctrl_${nodeRandomBytes(4).toString('hex')}`),
				OUTBOUND_DEV_ALLOW_HOSTS: 'localhost',
			},
			overrides: { portalUrl: 'https://portal.test', signingKey: `${privateJwk.kid}:${privateJwk.d}` },
			root: ROOT,
		});
		expect(app.retention).toEqual({ requests: 730, orders: 730, photos: 30 });
		await app.close();
		expect(retentionDays('P10D', 1)).toBe(10);
		expect(retentionDays('P1Y', 7)).toBe(7);
		expect(retentionDays(undefined, 3)).toBe(3);
		expect(Object.keys(await loadStrings(ROOT))).toContain('en');
	});
});

describe('repositories and helpers', () => {
	it('requires a website id', () => {
		expect(() => createRepositories(/** @type {any} */ ({ websiteId: '', collection: () => ({}) }))).toThrow(/websiteId/);
	});

	it('maps sessions, actors, settings and failures', () => {
		expect(sessionView({ kind: 'merchant', role: 'merchant', user: { id: 'u' } })).toEqual({
			kind: 'merchant',
			role: 'merchant',
			scope: {},
			user: 'u',
			actor: null,
		});
		expect(sessionView({ kind: 'admin', role: 'platform_admin', subject: 's', scope: { actor: 'stf' } })).toMatchObject({
			user: 's',
			actor: 'stf',
		});
		expect(sessionView({ kind: 'demo', role: 'demo' }).user).toBeNull();
		expect(dashboardActor({ kind: 'impersonate', role: 'impersonate', scope: { actor: 'stf_1' } })).toEqual({
			type: 'staff',
			id: 'stf_1',
		});
		expect(dashboardActor({ kind: 'admin', role: 'platform_admin', subject: 'adm' })).toEqual({ type: 'staff', id: 'adm' });
		expect(dashboardActor({ kind: 'merchant', role: 'merchant' })).toEqual({ type: 'merchant', id: 'unknown' });
		const off = settingsFrom({
			can: (key) => key === 'collection',
			config: (key) =>
				key === 'collection' ? { time_zone: 'Mars/Base' } : key === 'content' ? { rating_scale: 9, attributes: 'x' } : null,
		});
		expect(off).toMatchObject({ timeZone: 'UTC', moderation: null, requestFlow: null, photos: null });
		expect(off.content.rating_scale).toBe(5); // content off → defaults
		const on = settingsFrom({ can: () => true, config: (key) => (key === 'content' ? { attributes: 'x' } : {}) });
		expect(on.content.attributes).toEqual([]);
		expect(failure({ reason: 'not_found' })).toBeTruthy();
		expect(failure({ reason: 'identity_required' })).toBeTruthy();
		expect(failure({ reason: 'x', errors: [{ path: '/a', code: 'b' }] })).toBeTruthy();
	});
});
