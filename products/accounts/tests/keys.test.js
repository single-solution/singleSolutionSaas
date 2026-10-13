/**
 * Accounts' sealed secrets through a change of `ENCRYPTION_KEY` (PLAN 0.4.8, 0.11; RT-14): the website's signing key,
 * two-step secrets and kept messages open with the previous key while it is set, the Owner's Re-seal moves them to the
 * new key, and then the previous key can be removed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSealer, keyAadOf, outboxAadOf, resealWebsite, totpAadOf } from '../adapters/crypto.js';
import { setup } from './helpers.js';

/** The harness's `ENCRYPTION_KEY`. */
const KEY_A = 'encryption-key-0123456789-abcdefghij';
const KEY_B = 'encryption-key-b-0123456789-abcdefghij';
const KEY_GONE = 'encryption-key-gone-0123456789-abcdef';

/** @type {Awaited<ReturnType<typeof setup>>} */
let env;

beforeAll(async () => {
	env = await setup();
	await env.switchOn(['email_password', 'two_step']);
	await env.connectDatabase();
});
afterAll(async () => {
	await env.product.close();
});

describe('a change of ENCRYPTION_KEY (RT-14)', () => {
	it('opens the website’s secrets with the previous key, re-seals them with the new one, then the old key can go', async () => {
		const { websiteId } = env;
		const data = await env.product.data.forWebsite(websiteId);
		const a = createSealer(KEY_A);
		const since = new Date('2026-09-01T00:00:00Z');
		await data.collection('keys').insertOne({ kid: 'acc-key1', sealed: a.seal('{"d":"x"}', keyAadOf(websiteId, 'acc-key1')) });
		await data.collection('users').insertOne({
			id: 'usr_twostep',
			twoStep: { sealed: a.seal('JBSWY3DPEHPK3PXP', totpAadOf(websiteId, 'usr_twostep')), enabledAt: since },
			updatedAt: since,
		});
		await data
			.collection('outbox')
			.insertOne({ id: 'msg_1', key: 'reset|a@b.c', sealed: a.seal('{"link":"x"}', outboxAadOf(websiteId, 'reset|a@b.c')) });
		// sealed by a key that is gone: counted, left alone
		const lost = createSealer(KEY_GONE).seal('{}', outboxAadOf(websiteId, 'lost'));
		await data.collection('outbox').insertOne({ id: 'msg_2', key: 'lost', sealed: lost });

		const changing = createSealer(KEY_B, KEY_A);
		expect(await resealWebsite(changing, data)).toEqual({ resealed: 3, current: 0, unreadable: 1 });
		expect(await resealWebsite(changing, data)).toEqual({ resealed: 0, current: 3, unreadable: 1 });

		const b = createSealer(KEY_B);
		const key = await data.collection('keys').findOne({ websiteId, kid: 'acc-key1' });
		expect(b.open(key?.sealed, keyAadOf(websiteId, 'acc-key1'))).toBe('{"d":"x"}');
		expect(a.open(key?.sealed, keyAadOf(websiteId, 'acc-key1'))).toBeNull();
		const user = await data.collection('users').findOne({ websiteId, id: 'usr_twostep' });
		expect(b.open(user?.twoStep.sealed, totpAadOf(websiteId, 'usr_twostep'))).toBe('JBSWY3DPEHPK3PXP');
		expect(user?.updatedAt).toEqual(since);
		const kept = await data.collection('outbox').findOne({ websiteId, id: 'msg_1' });
		expect(b.open(kept?.sealed, outboxAadOf(websiteId, 'reset|a@b.c'))).toBe('{"link":"x"}');
		expect((await data.collection('outbox').findOne({ websiteId, id: 'msg_2' }))?.sealed).toBe(lost);
	});

	it('the Owner’s Re-seal on the dashboard reaches the website’s merchant database', async () => {
		const support = await env.dashboard(await env.adminSession('support'), 'POST', '/v1/dashboard/reseal');
		expect(support.status).toBe(403);
		const response = await env.dashboard(await env.adminSession(), 'POST', '/v1/dashboard/reseal');
		expect(response.status).toBe(200);
		// the database connection and the product key (K-21) are on the harness's key; the website's records were moved
		// to key B above, which this instance does not have: counted as unreadable and left alone
		expect(response.json).toEqual({
			keyId: createSealer(KEY_A).keyId,
			previousKeyId: null,
			resealed: 0,
			current: 2,
			unreadable: 4,
			failedWebsites: [],
		});
	});
});
