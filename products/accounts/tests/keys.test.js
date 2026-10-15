/**
 * Accounts' sealed secrets through a change of `ENCRYPTION_KEY` (PLAN 0.4.8, 0.11; RT-14): the website's signing key,
 * two-step secrets and kept messages open with the previous key while it is set, the Owner's Re-seal moves them to the
 * new key, and then the previous key can be removed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSealer, keyAadOf, outboxAadOf, resealWebsite, totpAadOf, totpCode } from '../adapters/crypto.js';
import { INDEXES } from '../adapters/store.js';
import { setup } from './helpers.js';

/** The harness's `ENCRYPTION_KEY`. */
const KEY_A = 'encryption-key-0123456789-abcdefghij';
const KEY_B = 'encryption-key-b-0123456789-abcdefghij';
const KEY_GONE = 'encryption-key-gone-0123456789-abcdef';

/** @type {Awaited<ReturnType<typeof setup>>} */
let env;

beforeAll(async () => {
	env = await setup();
	await env.switchOn(['email_password', 'two_step', 'roles']);
	await env.connectDatabase();
});

/** @param {{ json: any }} res */
const code = (res) =>
	String(res.json?.type ?? '')
		.split('/')
		.pop();

/** @param {string} email */
const signIn = (email) => env.visitor('POST', '/v1/sign-in/password', { email, password: 'correct horse battery' });
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
			// the product's own records in the website's database: entered again where Accounts asks for them
			unreadableIn: { product: 4 },
		});
	});
});

describe('two-step whose secret no longer opens (ST-18)', () => {
	it('the user signs in with a recovery code and sets it up again; staff can turn another user’s two-step off', async () => {
		const { websiteId } = env;
		await env.visitor('POST', '/v1/sign-up/password', {
			email: 'zed@example.com',
			name: 'Zed',
			password: 'correct horse battery',
		});
		const first = await signIn('zed@example.com');
		expect(first.json.status).toBe('signed_in');
		const setupAnswer = await env.visitor('POST', '/v1/me/two-step/setup', {}, first.json.signIn);
		const enabled = await env.visitor(
			'POST',
			'/v1/me/two-step/enable',
			{ challenge: setupAnswer.json.challenge, code: totpCode(setupAnswer.json.secret, env.now()) },
			first.json.signIn,
		);
		expect(enabled.json.recoveryCodes).toHaveLength(10);
		const zed = (await env.serverCall('GET', '/v1/users?q=zed@')).json.items[0];
		// the secret was sealed with a key that is gone
		const data = await env.product.data.forWebsite(websiteId);
		const lost = createSealer(KEY_GONE).seal(setupAnswer.json.secret, totpAadOf(websiteId, zed.id));
		await data.collection('users').updateOne({ websiteId, id: zed.id }, { $set: { 'twoStep.sealed': lost } });
		env.advance(60_000);
		const step = await signIn('zed@example.com');
		expect(step.json.status).toBe('two_step');
		const appCode = { challenge: step.json.challenge, code: totpCode(setupAnswer.json.secret, env.now()) };
		expect(code(await env.visitor('POST', '/v1/sign-in/two-step', appCode))).toBe('code_invalid');
		const recovered = await env.visitor('POST', '/v1/sign-in/two-step', {
			challenge: step.json.challenge,
			recoveryCode: enabled.json.recoveryCodes[0],
		});
		expect(recovered.json.status).toBe('signed_in');
		// set up again (refused while the secret opened)
		const again = await env.visitor('POST', '/v1/me/two-step/setup', {}, recovered.json.signIn);
		expect(again.status).toBe(200);
		const reenabled = await env.visitor(
			'POST',
			'/v1/me/two-step/enable',
			{ challenge: again.json.challenge, code: totpCode(again.json.secret, env.now()) },
			recovered.json.signIn,
		);
		expect(reenabled.json.recoveryCodes).toHaveLength(10);
		expect(code(await env.visitor('POST', '/v1/me/two-step/setup', {}, recovered.json.signIn))).toBe('conflict');

		// staff turn it off (the user sets it up again); never their own, and only with false
		expect(code(await env.serverCall('PATCH', `/v1/users/${zed.id}`, { twoStep: 'off' }))).toBe('validation_failed');
		const self = await env.call('PATCH', `/v1/users/${zed.id}`, {
			token: env.server,
			body: { twoStep: false },
			headers: { 'ss-actor-id': zed.id, 'ss-actor-name': 'Zed' },
		});
		expect(code(self)).toBe('forbidden');
		const off = await env.serverCall('PATCH', `/v1/users/${zed.id}`, { twoStep: false });
		expect(off.status).toBe(200);
		expect(off.json.twoStep).toBe(false);
		// already off: nothing changes (and an empty change answers the user too)
		expect((await env.serverCall('PATCH', `/v1/users/${zed.id}`, { twoStep: false })).status).toBe(200);
		expect((await env.serverCall('PATCH', `/v1/users/${zed.id}`, {})).json.id).toBe(zed.id);
		env.advance(60_000);
		expect((await signIn('zed@example.com')).json.status).toBe('signed_in');
		const logged = (await env.serverCall('GET', `/v1/activity?target=${zed.id}`)).json.items;
		expect(logged.map((/** @type {any} */ e) => e.action)).toContain('user.two_step_off');
	});
});

describe('sessions keep no secret once they end (RT-11)', () => {
	it('a signed-out session drops its sealed refresh secret, and ended sessions are removed 7 days after their end', async () => {
		const { websiteId } = env;
		const signedIn = await signIn('zed@example.com');
		const renewed = await env.visitor('POST', '/v1/session/refresh', { refreshToken: signedIn.json.refreshToken });
		const data = await env.product.data.forWebsite(websiteId);
		const sessions = data.collection('sessions');
		const live = await sessions.findOne({ websiteId, sealedRefresh: { $type: 'string' } });
		expect(live).not.toBeNull();
		expect((await env.visitor('POST', '/v1/session/sign-out', { refreshToken: renewed.json.refreshToken })).status).toBe(204);
		expect((await sessions.findOne({ websiteId, id: live?.id }))?.sealedRefresh).toBeNull();
		expect(INDEXES).toContainEqual({
			collection: 'sessions',
			keys: { expiresAt: 1 },
			name: 'expire',
			expireAfterSeconds: 7 * 24 * 3600,
		});
	});
});
