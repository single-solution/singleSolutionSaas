/** Adapters without the router: the site registry (control database), tokens and the platform's environment checks. */
import { describe, expect, it } from 'vitest';
import { generateSigningKey } from '@ss/protocol';
import { createPlatform, loadStrings } from '../adapters/platform.js';
import { createSiteRegistry } from '../adapters/registry.js';
import { createTokens, rootSecret, stableId } from '../adapters/tokens.js';
import { retentionDays } from '../api/routes.js';
import { ROOT } from './harness.js';

describe('site registry', () => {
	it('remembers websites in the control database and survives write failures', async () => {
		/** @type {Map<string, unknown>} */
		const docs = new Map();
		let fail = true;
		const collection = {
			updateOne: async (/** @type {any} */ filter) => {
				if (fail) throw new Error('down');
				docs.set(filter._id, filter);
			},
			find: () => ({ toArray: async () => [...docs.keys()].map((_id) => ({ _id })).concat([{ _id: 'web_other' }]) }),
		};
		const registry = createSiteRegistry({ collection });
		await registry.remember('web_a'); // failed: retried next time
		fail = false;
		await registry.remember('web_a');
		await registry.remember('web_a');
		expect(await registry.list()).toEqual(['web_a', 'web_other']);
		const memory = createSiteRegistry();
		await memory.remember('web_b');
		expect(await memory.list()).toEqual(['web_b']);
	});
});

describe('tokens and platform', () => {
	it('derives secrets, signs markers per website and expires them', async () => {
		const { privateJwk } = await generateSigningKey({ kid: 't' });
		expect(rootSecret({ secret: 'x'.repeat(32) }).toString()).toBe('x'.repeat(32));
		expect(rootSecret({ signingKey: JSON.stringify(privateJwk) })).toHaveLength(32);
		expect(() => rootSecret({ signingKey: {} })).toThrow(/CHATBOT_TOKEN_SECRET/);
		let now = 0;
		const tokens = createTokens({ secret: Buffer.alloc(32, 1), now: () => now });
		const { token, expiresAt } = tokens.issueMarker({ websiteId: 'web_1', visitorId: 'vis_1', days: 1 });
		expect(expiresAt).toBe('1970-01-02T00:00:00.000Z');
		expect(tokens.verifyMarker(token, 'web_1')).toBe('vis_1');
		expect(tokens.verifyMarker(token, 'web_2')).toBeNull();
		expect(tokens.verifyMarker(`${token}x`, 'web_1')).toBeNull();
		expect(tokens.verifyMarker(`${token}.extra`, 'web_1')).toBeNull();
		expect(tokens.verifyMarker('cm1.e30.' + token.split('.')[2], 'web_1')).toBeNull();
		expect(tokens.verifyMarker(42, 'web_1')).toBeNull();
		const forged = createTokens({ secret: Buffer.alloc(32, 1) }).issueMarker({ websiteId: 'web_1', visitorId: 'v', days: 1 });
		expect(tokens.verifyMarker(forged.token.replace(/\.[^.]+$/, '.bad'), 'web_1')).toBeNull();
		now = 2 * 86_400_000;
		expect(tokens.verifyMarker(token, 'web_1')).toBeNull();
		expect(tokens.toolSecret('web_1', 1)).not.toBe(tokens.toolSecret('web_1', 2));
		expect(tokens.signTool({ websiteId: 'web_1', version: 1, body: '{}', timestamp: 5 })).toMatch(/^t=5,v1=[0-9a-f]{64},kv=1$/);
		expect(stableId('a')).toHaveLength(26);
		expect(retentionDays('P180D')).toBe(180);
		expect(retentionDays('P1Y')).toBe(30);
	});
	it('refuses to start without the required environment and loads the string catalogs', async () => {
		await expect(createPlatform({ env: {}, root: ROOT })).rejects.toThrow(
			/SS_PORTAL_URL, SS_APP_SIGNING_KEY, SS_REGISTRATION_TOKEN_HASH/,
		);
		expect(Object.keys(await loadStrings(ROOT))).toContain('en');
	});
});
