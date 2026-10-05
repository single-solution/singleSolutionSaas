/** Adapters without the kit: the messaging seam (http, smtp, failures), the site registry and ids. */
import { describe, expect, it } from 'vitest';
import { createMessenger } from '../adapters/messaging.js';
import { createSiteRegistry } from '../adapters/registry.js';
import { hashKey, newId, stableId } from '../adapters/ids.js';

const message = {
	id: 'msg_1',
	channel: 'email',
	to: { email: 'a@example.com' },
	lang: 'en',
	subject: null,
	text: 'Hi',
	metadata: {},
};
/** @param {string} code @param {Record<string, unknown>} [details] */
const kitError = (code, details = {}) =>
	Object.assign(new Error(code), { name: 'AppKitError', code, details, [Symbol.for('ss.kitError')]: true });

describe('messaging', () => {
	it('sends through http and smtp connectors and classifies failures', async () => {
		const http = (/** @type {any} */ result) =>
			createMessenger(/** @type {any} */ ({ connectors: { messaging: async () => ({ request: async () => result }) } }));
		expect(await http({ ok: true, body: { messageId: 'p1' } })('w', message, { path: '/m' })).toEqual({
			ok: true,
			providerMessageId: 'p1',
		});
		expect(await http({ ok: true, body: null })('w', message, { path: '/m' })).toEqual({ ok: true, providerMessageId: null });
		expect(await http({ ok: false, status: 400 })('w', message, { path: '/m' })).toMatchObject({ ok: false, permanent: true });
		expect(await http({ ok: false, status: 429 })('w', message, { path: '/m' })).toMatchObject({ ok: false, permanent: false });
		const throwing = createMessenger(
			/** @type {any} */ ({
				connectors: {
					messaging: async () => ({
						request: async () => {
							throw new Error('x');
						},
					}),
				},
			}),
		);
		expect(await throwing('w', message, { path: '/m' })).toMatchObject({ code: 'upstream_error' });
		const missing = createMessenger(
			/** @type {any} */ ({
				connectors: {
					messaging: async () => {
						throw new Error('none');
					},
				},
			}),
		);
		expect(await missing('w', message, { path: '/m' })).toMatchObject({ code: 'resource_unavailable' });
		const smtp = (/** @type {any} */ send) =>
			createMessenger(/** @type {any} */ ({ connectors: { messaging: async () => ({ provider: 'smtp', send }) } }));
		expect(await smtp(async () => ({ id: 'm1' }))('w', message, { path: '/m' })).toEqual({ ok: true, providerMessageId: 'm1' });
		expect(await smtp(async () => ({}))('w', message, { path: '/m' })).toEqual({ ok: true, providerMessageId: null });
		expect(await smtp(async () => ({}))('w', { ...message, to: { phone: '+1' } }, { path: '/m' })).toMatchObject({
			code: 'channel_unsupported',
		});
		expect(
			await smtp(async () => {
				throw new Error('x');
			})('w', message, { path: '/m' }),
		).toMatchObject({ code: 'upstream_error', permanent: false });
		expect(
			await smtp(async () => {
				throw kitError('upstream_error', { responseCode: 550 });
			})('w', message, { path: '/m' }),
		).toMatchObject({ permanent: true });
		expect(
			await smtp(async () => {
				throw kitError('timeout');
			})('w', message, { path: '/m' }),
		).toMatchObject({ code: expect.any(String) });
	});
});

describe('registry and ids', () => {
	it('remembers websites in memory or in a collection', async () => {
		const memory = createSiteRegistry();
		await memory.remember('w2');
		await memory.remember('w1');
		await memory.remember('w1');
		expect(await memory.list()).toEqual(['w1', 'w2']);
		/** @type {any[]} */
		const docs = [{ _id: 'w9' }];
		let fail = true;
		const collection = {
			updateOne: async () => {
				if (fail) {
					fail = false;
					throw new Error('down');
				}
			},
			find: () => ({ toArray: async () => docs }),
		};
		const stored = createSiteRegistry({ collection });
		await stored.remember('w1');
		await stored.remember('w1');
		expect(await stored.list()).toEqual(['w1', 'w9']);
		expect(newId('ord')).toMatch(/^ord_[0-9a-z]{26}$/);
		expect(stableId('pay', 'x')).toBe(stableId('pay', 'x'));
		expect(hashKey('w', 'e:a@b.c')).toMatch(/^e:[0-9a-f]{40}$/);
	});
});
