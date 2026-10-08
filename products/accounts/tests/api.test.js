import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha1Upper, totpCode } from '../adapters/crypto.js';
import { ADMIN_ORIGIN, ALL, CHAT, NOTIFY, ORIGIN, SHOP, appleKey, idToken, setup } from './helpers.js';

/** @type {Awaited<ReturnType<typeof setup>>} */
let env;

/** @param {{ json: any }} res */
const code = (res) =>
	String(res.json?.type ?? '')
		.split('/')
		.pop();
/** The last message Accounts sent through Notifications. */
const lastMessage = () => env.messages().at(-1);

/** @param {string} email @param {string} [password] @param {Record<string, unknown>} [extra] */
const signUp = (email, password = 'correct horse battery', extra = {}) =>
	env.visitor('POST', '/v1/sign-up/password', { email, password, name: 'Ana Buyer', acceptTerms: true, ...extra });
/** @param {string} email @param {string} [password] @param {Record<string, unknown>} [extra] */
const signIn = (email, password = 'correct horse battery', extra = {}) =>
	env.visitor('POST', '/v1/sign-in/password', { email, password, acceptTerms: true, ...extra });

beforeAll(async () => {
	env = await setup();
});
afterAll(async () => {
	await env.product.close();
});

describe('before setup', () => {
	it('refuses sign-ins while every method is off and until the merchant database is connected', async () => {
		const off = await signUp('a@example.com');
		expect(off.status).toBe(403);
		expect(code(off)).toBe('feature_off');
		const me = await env.visitor('GET', '/v1/me');
		expect(code(me)).toBe('feature_off');
		await env.switchOn(['email_password']);
		expect(code(await signUp('a@example.com'))).toBe('database_not_connected');
		const keys = await env.call('GET', `/v1/websites/${env.websiteId}/keys`);
		expect(code(keys)).toBe('database_not_connected');
		expect(code(await env.call('GET', '/v1/websites/web_nope/keys'))).toBe('not_found');
		await env.connectDatabase();
	});

	it('serves the widget script, the docs and the widget config', async () => {
		const script = await env.call('GET', '/widget.js');
		expect(script.headers.get('content-type')).toContain('javascript');
		const docs = await env.call('GET', '/docs');
		expect(docs.text).toContain('accounts.phone_code');
		expect(docs.text).toContain('/oauth/google/callback');
		expect(docs.text).toContain('feature-email_password');
		const config = await env.visitor('GET', '/v1/widget/config');
		expect(config.json).toMatchObject({
			features: ['email_password'],
			settings: { signUp: { mode: 'open', requiredFields: [] }, customFields: [], passwordMinLength: 8, terms: null },
		});
	});

	it('tests provider keys and pasted tokens live when they are saved', async () => {
		expect(
			(await env.connect('google', { clientId: 'x.apps.googleusercontent.com', clientSecret: 'gsecret-1234' })).status,
		).toBe('connected');
		expect((await env.connect('google', { clientId: 'nope', clientSecret: 'x' })).status).toBe('test_failed');
		await env.connect('google', { clientId: 'x.apps.googleusercontent.com', clientSecret: 'gsecret-1234' });
		expect((await env.connect('apple', appleKey())).status).toBe('connected');
		expect((await env.connect('apple', { ...appleKey(), privateKey: 'not a key' })).status).toBe('test_failed');
		expect((await env.connect('apple', { servicesId: 'a', teamId: 'b', keyId: 'c', privateKey: 'd' })).status).toBe(
			'test_failed',
		);
		await env.connect('apple', appleKey());
		env.responders.set('https://graph.facebook.com', () => ({ status: 400, body: {} }));
		expect((await env.connect('facebook', { appId: '123', appSecret: 'fbsecret-9876' })).status).toBe('test_failed');
		env.responders.delete('https://graph.facebook.com');
		expect((await env.connect('facebook', { appId: '123', appSecret: 'fbsecret-9876' })).status).toBe('connected');
		expect((await env.connect('facebook', 'just text')).status).toBe('test_failed');
		await env.connect('facebook', { appId: '123', appSecret: 'fbsecret-9876' });
		await env.paste('notifications');
		const listed = await env.dashboard(await env.adminSession(), 'GET', `/v1/dashboard/websites/${env.websiteId}/connections`);
		expect(listed.text).not.toContain('gsecret-1234');
		expect(listed.text).not.toContain('fbsecret-9876');
	});
});

describe('email + password', () => {
	it('signs up, issues a sign-in verifiable offline with the public keys, and reads My account', async () => {
		const up = await signUp('ana@example.com', 'correct horse battery', { remember: true, deviceId: 'device-aaaaaaaaaaaa' });
		expect(up.status).toBe(200);
		expect(up.json).toMatchObject({
			status: 'signed_in',
			remember: true,
			user: { email: 'ana@example.com', role: 'customer' },
		});
		const keys = await env.call('GET', `/v1/websites/${env.websiteId}/keys`);
		expect(keys.json.issuer).toBe('https://accounts.example.dev');
		const [header, payload, signature] = up.json.signIn.split('.');
		const jwk = keys.json.keys[0];
		expect(
			cryptoVerify(
				null,
				Buffer.from(`${header}.${payload}`),
				createPublicKey({ key: jwk, format: 'jwk' }),
				Buffer.from(signature, 'base64url'),
			),
		).toBe(true);
		const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
		expect(claims).toMatchObject({
			iss: 'https://accounts.example.dev',
			aud: env.websiteId,
			email: 'ana@example.com',
			name: 'Ana Buyer',
		});
		expect(claims.exp - claims.iat).toBe(900);
		expect(claims.role).toBeUndefined();
		// 30 days with remember me (the Customer role)
		expect(Date.parse(up.json.sessionExpiresAt) - env.now()).toBe(30 * 86_400_000);
		const me = await env.visitor('GET', '/v1/me', undefined, up.json.signIn);
		expect(me.json).toMatchObject({ email: 'ana@example.com', hasPassword: true });
		expect(code(await env.visitor('GET', '/v1/me', undefined, 'not.a.token'))).toBe('signed_out');
		expect(code(await env.visitor('GET', '/v1/me'))).toBe('signed_out');
	});

	it('refuses duplicates, bad addresses, short and breached passwords', async () => {
		expect(code(await signUp('ana@example.com'))).toBe('already_exists');
		expect(code(await signUp('not-an-address'))).toBe('validation_failed');
		const short = await signUp('bo@example.com', 'short');
		expect(code(short)).toBe('weak_password');
		expect(code(await signUp('bo@example.com', 'x'.repeat(300)))).toBe('weak_password');
		const suffix = sha1Upper('password123456').slice(5);
		env.responders.set('https://api.pwnedpasswords.com', (call) => {
			expect(call.url).toMatch(/\/range\/[0-9A-F]{5}$/);
			return { status: 200, body: `${suffix}:42\r\nABC:0` };
		});
		const breached = await signUp('bo@example.com', 'password123456');
		expect(code(breached)).toBe('weak_password');
		expect(breached.json.detail).toMatch(/breach/);
		env.responders.set('https://api.pwnedpasswords.com', () => ({ status: 503 }));
		expect((await signUp('bo@example.com', 'password123456')).status).toBe(200);
		env.responders.delete('https://api.pwnedpasswords.com');
	});

	it('locks after repeated wrong passwords and tells nothing about unknown addresses', async () => {
		expect(code(await signIn('nobody@example.com'))).toBe('sign_in_failed');
		for (let i = 0; i < 5; i += 1) expect(code(await signIn('bo@example.com', 'wrong password!'))).toBe('sign_in_failed');
		const locked = await signIn('bo@example.com', 'password123456');
		expect(code(locked)).toBe('locked');
		expect(locked.json.lockedUntil).toBeDefined();
		env.advance(16 * 60_000);
		expect((await signIn('bo@example.com', 'password123456')).json.status).toBe('signed_in');
	});

	it('resets a forgotten password through Notifications and signs every device out', async () => {
		const before = await signIn('ana@example.com');
		const bad = await env.visitor('POST', '/v1/password/forgot', {
			email: 'ana@example.com',
			returnTo: 'https://evil.example.org/x',
		});
		expect(code(bad)).toBe('validation_failed');
		const asked = await env.visitor('POST', '/v1/password/forgot', {
			email: 'ana@example.com',
			returnTo: `${ORIGIN}/reset?x=1`,
		});
		expect(asked.status).toBe(202);
		const sent = lastMessage();
		expect(sent).toMatchObject({ channel: 'email', template: 'accounts.password_reset', to: { email: 'ana@example.com' } });
		expect(sent.values.business).toBe('shop.example.com');
		const token = String(sent.values.link).split('#ss_accounts_reset=')[1];
		expect(String(sent.values.link)).toMatch(/^https:\/\/shop\.example\.com\/reset\?x=1#ss_accounts_reset=/);
		// unknown addresses get the same answer and no message
		const count = env.messages().length;
		expect((await env.visitor('POST', '/v1/password/forgot', { email: 'ghost@example.com', returnTo: ORIGIN })).status).toBe(
			202,
		);
		expect(env.messages()).toHaveLength(count);
		expect(code(await env.visitor('POST', '/v1/password/reset', { token, password: 'short' }))).toBe('weak_password');
		expect(code(await env.visitor('POST', '/v1/password/reset', { token: 'nope', password: 'brand new password' }))).toBe(
			'code_invalid',
		);
		expect((await env.visitor('POST', '/v1/password/reset', { token, password: 'brand new password' })).status).toBe(204);
		expect(code(await env.visitor('POST', '/v1/password/reset', { token, password: 'brand new password' }))).toBe(
			'code_invalid',
		);
		expect(code(await env.visitor('POST', '/v1/session/refresh', { refreshToken: before.json.refreshToken }))).toBe(
			'signed_out',
		);
		expect((await signIn('ana@example.com', 'brand new password')).json.status).toBe('signed_in');
	});
});

describe('sessions', () => {
	it('renews with a rotating refresh token; an old one ends the session', async () => {
		const first = await signIn('ana@example.com', 'brand new password');
		env.advance(60_000);
		const renewed = await env.visitor('POST', '/v1/session/refresh', { refreshToken: first.json.refreshToken });
		expect(renewed.json.status).toBe('signed_in');
		expect(renewed.json.refreshToken).not.toBe(first.json.refreshToken);
		const reused = await env.visitor('POST', '/v1/session/refresh', { refreshToken: first.json.refreshToken });
		expect(code(reused)).toBe('signed_out');
		// the session ended, so the newer token is refused too
		expect(code(await env.visitor('POST', '/v1/session/refresh', { refreshToken: renewed.json.refreshToken }))).toBe(
			'signed_out',
		);
		expect(code(await env.visitor('POST', '/v1/session/refresh', { refreshToken: 'garbage' }))).toBe('signed_out');
	});

	it('lists devices, signs one out, signs out everywhere, and the session ends by its length', async () => {
		const a = await signIn('ana@example.com', 'brand new password');
		const b = await signIn('ana@example.com', 'brand new password');
		const list = await env.visitor('GET', '/v1/me/sessions', undefined, a.json.signIn);
		expect(list.json.items.length).toBeGreaterThanOrEqual(2);
		expect(list.json.items.find((/** @type {any} */ x) => x.current).device).toBe('Safari on macOS');
		const other = list.json.items.find((/** @type {any} */ x) => !x.current);
		expect((await env.visitor('DELETE', `/v1/me/sessions/${other.id}`, undefined, a.json.signIn)).status).toBe(204);
		expect(code(await env.visitor('DELETE', `/v1/me/sessions/${other.id}`, undefined, a.json.signIn))).toBe('not_found');
		expect((await env.visitor('POST', '/v1/session/sign-out', { refreshToken: b.json.refreshToken })).status).toBe(204);
		expect((await env.visitor('POST', '/v1/me/sign-out-everywhere', {}, a.json.signIn)).status).toBe(204);
		expect(code(await env.visitor('GET', '/v1/me', undefined, a.json.signIn))).toBe('signed_out');
		const c = await signIn('ana@example.com', 'brand new password');
		env.advance(25 * 3_600_000);
		expect(code(await env.visitor('POST', '/v1/session/refresh', { refreshToken: c.json.refreshToken }))).toBe('signed_out');
	});

	it('My account: profile, addresses and password', async () => {
		const s = await signIn('ana@example.com', 'brand new password');
		const t = s.json.signIn;
		const patched = await env.visitor(
			'PATCH',
			'/v1/me',
			{ name: 'Ana B', addresses: [{ label: 'Home', line1: '1 Main St', city: 'Springfield', country: 'us' }] },
			t,
		);
		expect(patched.json).toMatchObject({ name: 'Ana B', addresses: [{ label: 'Home', country: 'US' }] });
		expect(patched.json.addresses[0].id).toMatch(/^adr_/);
		expect(code(await env.visitor('PATCH', '/v1/me', { addresses: [{ line1: '' }] }, t))).toBe('validation_failed');
		expect(code(await env.visitor('PATCH', '/v1/me', { addresses: [{ line1: 'x', city: 'y', country: 'USA' }] }, t))).toBe(
			'validation_failed',
		);
		expect(code(await env.visitor('PATCH', '/v1/me', { name: 'x'.repeat(200) }, t))).toBe('validation_failed');
		expect(code(await env.visitor('PATCH', '/v1/me', { custom: { a: 1 } }, t))).toBe('feature_off');
		expect(code(await env.visitor('PUT', '/v1/me/password', { current: 'wrong', password: 'another long one' }, t))).toBe(
			'sign_in_failed',
		);
		expect(
			(await env.visitor('PUT', '/v1/me/password', { current: 'brand new password', password: 'another long one' }, t)).status,
		).toBe(204);
		expect((await signIn('ana@example.com', 'another long one')).json.status).toBe('signed_in');
	});
});

describe('phone code and e-mail code', () => {
	it('signs up and in with a code sent by SMS or WhatsApp through Notifications', async () => {
		await env.switchOn(['email_password', 'phone_code', 'email_code']);
		expect(code(await env.visitor('POST', '/v1/sign-in/phone/code', { phone: '0300 1234567' }))).toBe('validation_failed');
		await env.setting('phone_code', 'defaultCallingCode', '+92');
		await env.setting('phone_code', 'trunkPrefix', '0');
		const asked = await env.visitor('POST', '/v1/sign-in/phone/code', { phone: '0300 1234567' });
		expect(asked.status).toBe(202);
		const sent = lastMessage();
		expect(sent).toMatchObject({ channel: 'sms', template: 'accounts.phone_code', to: { phone: '+923001234567' } });
		expect(String(sent.values.code)).toMatch(/^\d{6}$/);
		expect(code(await env.visitor('POST', '/v1/sign-in/phone/code', { phone: '+923001234567' }))).toBe('too_soon');
		const wrong = await env.visitor('POST', '/v1/sign-in/phone', {
			phone: '+923001234567',
			code: '000000' === sent.values.code ? '111111' : '000000',
		});
		expect(code(wrong)).toBe('code_invalid');
		const ok = await env.visitor('POST', '/v1/sign-in/phone', { phone: '0300-1234567', code: sent.values.code, name: 'Pat' });
		expect(ok.json).toMatchObject({ status: 'signed_in', user: { phone: '+923001234567', phoneVerified: true, name: 'Pat' } });
		// a code works once
		expect(code(await env.visitor('POST', '/v1/sign-in/phone', { phone: '+923001234567', code: sent.values.code }))).toBe(
			'code_invalid',
		);
		// WhatsApp, an existing user, and too many wrong tries spend the code
		await env.setting('phone_code', 'channel', 'whatsapp');
		env.advance(31_000);
		await env.visitor('POST', '/v1/sign-in/phone/code', { phone: '+923001234567' });
		const again = lastMessage();
		expect(again.channel).toBe('whatsapp');
		for (let i = 0; i < 5; i += 1) await env.visitor('POST', '/v1/sign-in/phone', { phone: '+923001234567', code: '12345' });
		const wrongs = [];
		for (let i = 0; i < 5; i += 1)
			wrongs.push(
				await env.visitor('POST', '/v1/sign-in/phone', {
					phone: '+923001234567',
					code: again.values.code === '999999' ? '888888' : '999999',
				}),
			);
		expect(code(await env.visitor('POST', '/v1/sign-in/phone', { phone: '+923001234567', code: again.values.code }))).toBe(
			'code_invalid',
		);
		env.advance(31_000);
		await env.visitor('POST', '/v1/sign-in/phone/code', { phone: '+923001234567' });
		const third = await env.visitor('POST', '/v1/sign-in/phone', { phone: '+923001234567', code: lastMessage().values.code });
		expect(third.json.status).toBe('signed_in');
	});

	it('caps codes per hour and reports a failed send', async () => {
		for (let i = 0; i < 6; i += 1) {
			env.advance(31_000);
			await env.visitor('POST', '/v1/sign-in/phone/code', { phone: '+15550001111' });
		}
		env.advance(31_000);
		expect(code(await env.visitor('POST', '/v1/sign-in/phone/code', { phone: '+15550001111' }))).toBe('too_soon');
		env.responders.set(`${NOTIFY}/v1/messages/whatsapp`, () => ({ status: 201, body: { status: 'failed' } }));
		expect(code(await env.visitor('POST', '/v1/sign-in/phone/code', { phone: '+15550002222' }))).toBe('not_sent');
		env.responders.delete(`${NOTIFY}/v1/messages/whatsapp`);
		env.advance(31_000);
		expect((await env.visitor('POST', '/v1/sign-in/phone/code', { phone: '+15550002222' })).status).toBe(202);
	});

	it('signs in with an e-mail code or the magic link', async () => {
		expect(code(await env.visitor('POST', '/v1/sign-in/email/code', { email: 'x' }))).toBe('validation_failed');
		expect(code(await env.visitor('POST', '/v1/sign-in/email/code', { email: 'cy@example.com', returnTo: 'ftp://x' }))).toBe(
			'validation_failed',
		);
		await env.visitor('POST', '/v1/sign-in/email/code', { email: 'cy@example.com', returnTo: 'http://localhost:3000/login' });
		const sent = lastMessage();
		expect(sent).toMatchObject({ channel: 'email', template: 'accounts.email_code', to: { email: 'cy@example.com' } });
		const link = String(sent.values.link).split('#ss_accounts_link=')[1];
		expect(String(sent.values.link)).toMatch(/^http:\/\/localhost:3000\/login#/);
		const viaLink = await env.visitor('POST', '/v1/sign-in/email', { link, name: 'Cy' });
		expect(viaLink.json).toMatchObject({ status: 'signed_in', user: { email: 'cy@example.com', emailVerified: true } });
		expect(code(await env.visitor('POST', '/v1/sign-in/email', { link }))).toBe('code_invalid');
		env.advance(31_000);
		await env.visitor('POST', '/v1/sign-in/email/code', { email: 'ana@example.com' });
		const byCode = await env.visitor('POST', '/v1/sign-in/email', {
			email: 'ana@example.com',
			code: lastMessage().values.code,
		});
		expect(byCode.json.user).toMatchObject({ email: 'ana@example.com', emailVerified: true });
		expect(code(await env.visitor('POST', '/v1/sign-in/email', { email: 'bad', code: '1' }))).toBe('validation_failed');
	});

	it('answers notifications_not_connected without the Notifications token', async () => {
		await env.dashboard(
			await env.adminSession(),
			'DELETE',
			`/v1/dashboard/websites/${env.websiteId}/connections/notifications`,
		);
		env.advance(31_000);
		expect(code(await env.visitor('POST', '/v1/sign-in/email/code', { email: 'dee@example.com' }))).toBe(
			'notifications_not_connected',
		);
		await env.paste('notifications');
	});
});

describe('Google, Apple and Facebook', () => {
	/** @param {string} provider @param {string} [returnTo] */
	const start = async (provider, returnTo = `${ORIGIN}/account`) => {
		const res = await env.visitor('POST', `/v1/sign-in/${provider}/start`, { returnTo, remember: true });
		return { res, url: res.json?.url ? new URL(res.json.url) : null };
	};

	it('Google: start, the provider sends the person back, the widget exchanges the hand-over code', async () => {
		expect(code((await start('google')).res)).toBe('feature_off');
		await env.switchOn(['email_password', 'phone_code', 'email_code', 'google', 'apple', 'facebook']);
		expect(code((await start('google', 'https://elsewhere.example.org/')).res)).toBe('validation_failed');
		const { url } = await start('google');
		expect(url?.origin).toBe('https://accounts.google.com');
		const params = /** @type {URL} */ (url).searchParams;
		expect(params.get('redirect_uri')).toBe('https://accounts.example.dev/oauth/google/callback');
		expect(params.get('code_challenge_method')).toBe('S256');
		env.responders.set('https://oauth2.googleapis.com', (call) => {
			const form = new URLSearchParams(call.body);
			expect(form.get('code_verifier')).toBeTruthy();
			return {
				status: 200,
				body: {
					id_token: idToken({
						iss: 'https://accounts.google.com',
						aud: 'x.apps.googleusercontent.com',
						sub: 'g-1',
						email: 'gina@example.com',
						email_verified: true,
						name: 'Gina',
						nonce: params.get('nonce'),
						exp: Math.floor(env.now() / 1000) + 600,
					}),
				},
			};
		});
		const back = await env.call('GET', `/oauth/google/callback?state=${params.get('state')}&code=abc`);
		expect(back.status).toBe(303);
		const location = String(back.headers.get('location'));
		expect(location.startsWith(`${ORIGIN}/account#ss_accounts_code=`)).toBe(true);
		const handoff = location.split('#ss_accounts_code=')[1];
		// the state works once
		expect((await env.call('GET', `/oauth/google/callback?state=${params.get('state')}&code=abc`)).status).toBe(400);
		const done = await env.visitor('POST', '/v1/sign-in/exchange', { code: handoff });
		expect(done.json).toMatchObject({
			status: 'signed_in',
			remember: true,
			user: { email: 'gina@example.com', providers: ['google'] },
		});
		expect(code(await env.visitor('POST', '/v1/sign-in/exchange', { code: handoff }))).toBe('code_invalid');
		// the next Google sign-in finds the same user
		const second = await start('google');
		const p2 = /** @type {URL} */ (second.url).searchParams;
		env.responders.set('https://oauth2.googleapis.com', () => ({
			status: 200,
			body: {
				id_token: idToken({
					iss: 'accounts.google.com',
					aud: 'x.apps.googleusercontent.com',
					sub: 'g-1',
					nonce: p2.get('nonce'),
					exp: Math.floor(env.now() / 1000) + 600,
				}),
			},
		}));
		const back2 = await env.call('GET', `/oauth/google/callback?state=${p2.get('state')}&code=abc`);
		const done2 = await env.visitor('POST', '/v1/sign-in/exchange', {
			code: String(back2.headers.get('location')).split('#ss_accounts_code=')[1],
		});
		expect(done2.json.user.id).toBe(done.json.user.id);
	});

	it('Google refusals send the person back with an error', async () => {
		const { url } = await start('google');
		const state = /** @type {URL} */ (url).searchParams.get('state');
		env.responders.set('https://oauth2.googleapis.com', () => ({ status: 400, body: {} }));
		const back = await env.call('GET', `/oauth/google/callback?state=${state}&code=abc`);
		expect(back.headers.get('location')).toBe(`${ORIGIN}/account#ss_accounts_error=provider_failed`);
		const { url: u2 } = await start('google');
		const back2 = await env.call('GET', `/oauth/google/callback?state=${u2?.searchParams.get('state')}&error=access_denied`);
		expect(back2.headers.get('location')).toBe(`${ORIGIN}/account#ss_accounts_error=cancelled`);
		expect((await env.call('GET', '/oauth/google/callback?state=bad&code=abc')).status).toBe(400);
		expect((await env.call('GET', `/oauth/google/callback?state=web_0000000000zzz.abc&code=abc`)).status).toBe(404);
		expect((await env.call('GET', `/oauth/google/callback?state=${env.websiteId}.unknown&code=abc`)).status).toBe(400);
	});

	it('Apple: form_post callback with the name on the first sign-in', async () => {
		const { url } = await start('apple');
		const params = /** @type {URL} */ (url).searchParams;
		expect(params.get('response_mode')).toBe('form_post');
		env.responders.set('https://appleid.apple.com', (call) => {
			const form = new URLSearchParams(call.body);
			expect(String(form.get('client_secret')).split('.')).toHaveLength(3);
			return {
				status: 200,
				body: {
					id_token: idToken({
						iss: 'https://appleid.apple.com',
						aud: 'com.shop.signin',
						sub: 'apple-1',
						email: 'al@privaterelay.appleid.com',
						email_verified: 'true',
						nonce: params.get('nonce'),
						exp: Math.floor(env.now() / 1000) + 600,
					}),
				},
			};
		});
		const raw = new URLSearchParams({
			state: String(params.get('state')),
			code: 'apple-code',
			user: JSON.stringify({ name: { firstName: 'Al', lastName: 'Apple' } }),
		}).toString();
		const back = await env.call('POST', '/oauth/apple/callback', { raw });
		const done = await env.visitor('POST', '/v1/sign-in/exchange', {
			code: String(back.headers.get('location')).split('#ss_accounts_code=')[1],
		});
		expect(done.json.user).toMatchObject({ name: 'Al Apple', email: 'al@privaterelay.appleid.com' });
	});

	it('Facebook: code → access token → profile with appsecret_proof', async () => {
		const { url } = await start('facebook');
		const params = /** @type {URL} */ (url).searchParams;
		expect(url?.origin).toBe('https://www.facebook.com');
		env.responders.set('https://graph.facebook.com/v21.0/oauth/access_token', () => ({
			status: 200,
			body: { access_token: 'fb-token' },
		}));
		env.responders.set('https://graph.facebook.com/v21.0/me', (call) => {
			expect(new URL(call.url).searchParams.get('appsecret_proof')).toMatch(/^[0-9a-f]{64}$/);
			return { status: 200, body: { id: 'fb-1', name: 'Fay', email: 'fay@example.com' } };
		});
		const back = await env.call('GET', `/oauth/facebook/callback?state=${params.get('state')}&code=fb`);
		const done = await env.visitor('POST', '/v1/sign-in/exchange', {
			code: String(back.headers.get('location')).split('#ss_accounts_code=')[1],
		});
		expect(done.json.user).toMatchObject({ name: 'Fay', email: 'fay@example.com', providers: ['facebook'] });
		// an existing e-mail user gets linked
		const { url: u2 } = await start('facebook');
		env.responders.set('https://graph.facebook.com/v21.0/me', () => ({
			status: 200,
			body: { id: 'fb-2', name: 'Ana', email: 'ana@example.com' },
		}));
		const back2 = await env.call('GET', `/oauth/facebook/callback?state=${u2?.searchParams.get('state')}&code=fb`);
		const done2 = await env.visitor('POST', '/v1/sign-in/exchange', {
			code: String(back2.headers.get('location')).split('#ss_accounts_code=')[1],
		});
		expect(done2.json.user).toMatchObject({ email: 'ana@example.com', providers: ['facebook'] });
		env.responders.set('https://graph.facebook.com/v21.0/oauth/access_token', () => ({ status: 400, body: {} }));
		const { url: u3 } = await start('facebook');
		const back3 = await env.call('GET', `/oauth/facebook/callback?state=${u3?.searchParams.get('state')}&code=fb`);
		expect(back3.headers.get('location')).toContain('ss_accounts_error=provider_failed');
		env.responders.delete('https://graph.facebook.com/v21.0/oauth/access_token');
		env.responders.delete('https://graph.facebook.com/v21.0/me');
	});
});

describe('roles, two-step, terms, approval and risk checks', () => {
	it('roles: the ready-made roles, permission catalog with pasted products, own permissions and role claims', async () => {
		await env.switchOn(ALL);
		await env.paste('chat');
		env.responders.set(`${CHAT}/v1/permissions`, () => ({
			status: 200,
			body: { permissions: [{ key: 'inbox.reply', name: 'Reply to chats', feature: 'visitor_chat' }] },
		}));
		await env.paste('ecommerce');
		env.responders.set(`${SHOP}/v1/permissions`, () => ({ status: 500, body: {} }));
		const roles = await env.serverCall('GET', '/v1/roles');
		expect(roles.json.items.map((/** @type {any} */ r) => r.key)).toEqual(
			expect.arrayContaining([
				'customer',
				'owner',
				'business_manager',
				'product_manager',
				'marketing_manager',
				'support_staff',
			]),
		);
		expect(code(await env.serverCall('PUT', '/v1/roles/permissions', { permissions: [{ key: 'Bad Key', name: 'x' }] }))).toBe(
			'validation_failed',
		);
		await env.serverCall('PUT', '/v1/roles/permissions', {
			permissions: [{ key: 'refunds.approve', name: 'Approve refunds' }],
		});
		const catalog = await env.serverCall('GET', '/v1/roles/permissions');
		expect(catalog.json.unavailable).toEqual(expect.arrayContaining(['ecommerce']));
		const ready = Object.fromEntries(roles.json.items.map((/** @type {any} */ r) => [r.key, r.permissions]));
		expect(ready.owner).toEqual(['*']);
		expect(ready.customer).toEqual([]);
		expect(ready.product_manager).toEqual([
			'ecommerce:catalog.edit',
			'ecommerce:csv.run',
			'ecommerce:bulk.run',
			'ecommerce:reviews.moderate',
		]);
		expect(ready.business_manager.filter((/** @type {string} */ p) => p.startsWith('ecommerce:'))).toHaveLength(14);
		expect(ready.marketing_manager).toEqual(expect.arrayContaining(['ecommerce:coupons.edit', 'ecommerce:reports.read']));
		expect(ready.support_staff).toEqual(expect.arrayContaining(['ecommerce:orders.manage', 'ecommerce:returns.manage']));
		expect(catalog.json.groups).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ source: 'accounts' }),
				{ source: 'chat', permissions: [{ key: 'chat:inbox.reply', name: 'Reply to chats' }] },
				{ source: 'site', permissions: [{ key: 'site:refunds.approve', name: 'Approve refunds' }] },
			]),
		);
		const saved = await env.serverCall('PUT', '/v1/roles/cashier', {
			name: 'Cashier',
			permissions: ['chat:inbox.reply', 'site:refunds.approve'],
			sessionHours: 8,
			rememberDays: 0,
		});
		expect(saved.json).toMatchObject({ key: 'cashier', ready: false, sessionHours: 8 });
		expect(code(await env.serverCall('PUT', '/v1/roles/Bad', { name: 'x' }))).toBe('validation_failed');
		expect(code(await env.serverCall('PUT', '/v1/roles/x1', { name: 'x', permissions: ['nope'] }))).toBe('validation_failed');
		expect(code(await env.serverCall('PUT', '/v1/roles/x1', { name: 'x', sessionHours: 0 }))).toBe('validation_failed');
		expect(code(await env.serverCall('PUT', '/v1/roles/x1', { name: 'x', rememberDays: 999 }))).toBe('validation_failed');
		expect(code(await env.serverCall('PUT', '/v1/roles/x1', { name: '' }))).toBe('validation_failed');
		const ana = (await env.serverCall('GET', '/v1/users?q=ana@')).json.items[0];
		expect((await env.serverCall('PATCH', `/v1/users/${ana.id}`, { role: 'cashier' })).json.role).toBe('cashier');
		expect(code(await env.serverCall('PATCH', `/v1/users/${ana.id}`, { role: 'nope' }))).toBe('validation_failed');
		const s = await signIn('ana@example.com', 'another long one', { remember: true });
		const claims = JSON.parse(Buffer.from(s.json.signIn.split('.')[1], 'base64url').toString('utf8'));
		expect(claims).toMatchObject({ role: 'cashier', permissions: ['chat:inbox.reply', 'site:refunds.approve'] });
		// remember me is off for this role: 8 hours
		expect(Date.parse(s.json.sessionExpiresAt) - env.now()).toBe(8 * 3_600_000);
		expect(code(await env.serverCall('DELETE', '/v1/roles/owner'))).toBe('not_found');
		expect((await env.serverCall('DELETE', '/v1/roles/cashier')).status).toBe(204);
		expect((await env.serverCall('GET', `/v1/users/${ana.id}`)).json.role).toBe('customer');
	});

	it('two-step: a role that requires it sets it up at sign-in, then codes and recovery codes', async () => {
		const ana = (await env.serverCall('GET', '/v1/users?q=ana@')).json.items[0];
		await env.serverCall('PUT', '/v1/roles/guarded', { name: 'Guarded', twoStep: 'required' });
		await env.serverCall('PATCH', `/v1/users/${ana.id}`, { role: 'guarded' });
		const first = await signIn('ana@example.com', 'another long one');
		expect(first.json).toMatchObject({ status: 'two_step_setup' });
		expect(first.json.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
		expect(code(await env.visitor('POST', '/v1/sign-in/two-step', { challenge: first.json.challenge, code: '000000' }))).toBe(
			'code_invalid',
		);
		const done = await env.visitor('POST', '/v1/sign-in/two-step', {
			challenge: first.json.challenge,
			code: totpCode(first.json.secret, env.now()),
		});
		expect(done.json.status).toBe('signed_in');
		expect(done.json.recoveryCodes).toHaveLength(10);
		env.advance(60_000);
		const second = await signIn('ana@example.com', 'another long one');
		expect(second.json.status).toBe('two_step');
		const ok = await env.visitor('POST', '/v1/sign-in/two-step', {
			challenge: second.json.challenge,
			code: totpCode(first.json.secret, env.now()),
		});
		expect(ok.json.status).toBe('signed_in');
		const third = await signIn('ana@example.com', 'another long one');
		const recovered = await env.visitor('POST', '/v1/sign-in/two-step', {
			challenge: third.json.challenge,
			recoveryCode: done.json.recoveryCodes[0],
		});
		expect(recovered.json.status).toBe('signed_in');
		const fourth = await signIn('ana@example.com', 'another long one');
		expect(
			code(
				await env.visitor('POST', '/v1/sign-in/two-step', {
					challenge: fourth.json.challenge,
					recoveryCode: done.json.recoveryCodes[0],
				}),
			),
		).toBe('code_invalid');
		expect(code(await env.visitor('POST', '/v1/sign-in/two-step', { challenge: 'nope', code: '1' }))).toBe('code_invalid');
		// the role requires it, so it cannot be turned off
		expect(code(await env.visitor('POST', '/v1/me/two-step/disable', { code: '1' }, ok.json.signIn))).toBe('two_step_required');
		await env.serverCall('PATCH', `/v1/users/${ana.id}`, { role: 'customer' });
		env.advance(60_000);
		expect(code(await env.visitor('POST', '/v1/me/two-step/disable', { code: '000000' }, ok.json.signIn))).toBe('code_invalid');
		expect(
			(await env.visitor('POST', '/v1/me/two-step/disable', { code: totpCode(first.json.secret, env.now()) }, ok.json.signIn))
				.status,
		).toBe(204);
		// optional two-step from My account
		const setupAnswer = await env.visitor('POST', '/v1/me/two-step/setup', {}, ok.json.signIn);
		expect(
			code(
				await env.visitor(
					'POST',
					'/v1/me/two-step/enable',
					{ challenge: setupAnswer.json.challenge, code: '000000' },
					ok.json.signIn,
				),
			),
		).toBe('code_invalid');
		const enabled = await env.visitor(
			'POST',
			'/v1/me/two-step/enable',
			{ challenge: setupAnswer.json.challenge, code: totpCode(setupAnswer.json.secret, env.now()) },
			ok.json.signIn,
		);
		expect(enabled.json.recoveryCodes).toHaveLength(10);
		expect(code(await env.visitor('POST', '/v1/me/two-step/setup', {}, ok.json.signIn))).toBe('conflict');
		env.advance(60_000);
		await env.visitor(
			'POST',
			'/v1/me/two-step/disable',
			{ code: totpCode(setupAnswer.json.secret, env.now()) },
			ok.json.signIn,
		);
		expect((await signIn('ana@example.com', 'another long one')).json.status).toBe('signed_in');
	});

	it('terms: sign-up and sign-in ask for the current version', async () => {
		await env.setting('terms', 'version', '2');
		await env.setting('terms', 'url', 'https://shop.example.com/terms');
		const asked = await env.visitor('POST', '/v1/sign-in/password', { email: 'ana@example.com', password: 'another long one' });
		expect(code(asked)).toBe('terms_required');
		expect(asked.json).toMatchObject({ version: '2', url: 'https://shop.example.com/terms' });
		const accepted = await signIn('ana@example.com', 'another long one');
		expect(accepted.json.user.terms.version).toBe('2');
		expect(
			code(await env.visitor('POST', '/v1/sign-up/password', { email: 'te@example.com', password: 'long enough pass' })),
		).toBe('terms_required');
		await env.setting('terms', 'version', '3');
		expect(code(await env.visitor('POST', '/v1/me/terms', {}, accepted.json.signIn))).toBe('validation_failed');
		expect((await env.visitor('POST', '/v1/me/terms', { accept: true }, accepted.json.signIn)).json.terms.version).toBe('3');
	});

	it('approval: sign-ups wait until a member of staff approves; invite-only refuses them; invites work', async () => {
		const pending = await signUp('pen@example.com');
		expect(pending.json).toEqual({ status: 'pending' });
		expect(code(await signIn('pen@example.com'))).toBe('pending_approval');
		const t = await env.ticket();
		const list = await env.admin(t, 'GET', '/v1/admin/users?status=pending');
		expect(list.json.items.map((/** @type {any} */ u) => u.email)).toEqual(['pen@example.com']);
		const id = list.json.items[0].id;
		expect((await env.admin(t, 'POST', `/v1/admin/users/${id}/approve`)).json.status).toBe('active');
		expect(code(await env.admin(t, 'POST', `/v1/admin/users/${id}/approve`))).toBe('conflict');
		expect((await signIn('pen@example.com')).json.status).toBe('signed_in');
		const declined = await signUp('nope@example.com');
		expect(declined.json.status).toBe('pending');
		const nope = (await env.admin(t, 'GET', '/v1/admin/users?q=nope@')).json.items[0];
		expect((await env.admin(t, 'POST', `/v1/admin/users/${nope.id}/decline`)).status).toBe(204);
		expect(code(await env.admin(t, 'POST', `/v1/admin/users/${nope.id}/decline`))).toBe('not_found');
		await env.setting('approval', 'mode', 'invite');
		expect(code(await signUp('closed@example.com'))).toBe('sign_up_closed');
		expect(code(await env.serverCall('POST', '/v1/users/invite', { email: 'inv@example.com' }))).toBe('validation_failed');
		await env.setting('approval', 'invitePageUrl', 'https://shop.example.com/join');
		const invited = await env.admin(t, 'POST', '/v1/admin/users/invite', {
			email: 'inv@example.com',
			name: 'Ivy',
			role: 'support_staff',
		});
		expect(invited.status).toBe(201);
		expect(invited.json).toMatchObject({ status: 'invited', role: 'support_staff' });
		expect(code(await env.admin(t, 'POST', '/v1/admin/users/invite', { email: 'inv@example.com' }))).toBe('already_exists');
		expect(code(await env.admin(t, 'POST', '/v1/admin/users/invite', { email: 'x@example.com', role: 'nope' }))).toBe(
			'validation_failed',
		);
		const message = lastMessage();
		expect(message).toMatchObject({ template: 'accounts.invite', to: { email: 'inv@example.com' } });
		const token = String(message.values.link).split('#ss_accounts_invite=')[1];
		expect(code(await env.visitor('POST', '/v1/invites/accept', { token: 'x' }))).toBe('code_invalid');
		const joined = await env.visitor('POST', '/v1/invites/accept', {
			token,
			password: 'my invite password',
			acceptTerms: true,
		});
		expect(joined.json).toMatchObject({ status: 'signed_in', user: { email: 'inv@example.com', role: 'support_staff' } });
		expect((await signIn('inv@example.com', 'my invite password')).json.status).toBe('signed_in');
		// a phone invite goes by the phone channel
		await env.admin(t, 'POST', '/v1/admin/users/invite', { phone: '+15557770000', role: 'customer' });
		expect(lastMessage()).toMatchObject({ channel: 'whatsapp', to: { phone: '+15557770000' } });
		await env.setting('approval', 'mode', 'open');
		await env.setting('approval', 'requiredFields', ['phone']);
		expect(code(await signUp('req@example.com'))).toBe('validation_failed');
		expect((await signUp('req@example.com', undefined, { phone: '+15553334444' })).json.user.phone).toBe('+15553334444');
		await env.setting('approval', 'requiredFields', []);
	});

	it('custom fields: set in the dashboard, required at sign-up, edited in My account', async () => {
		const cookie = await env.adminSession();
		const base = `/v1/dashboard/websites/${env.websiteId}/fields`;
		expect(code(await env.dashboard(cookie, 'PUT', `${base}/Bad`, { label: 'x', type: 'text' }))).toBe('validation_failed');
		expect(code(await env.dashboard(cookie, 'PUT', `${base}/size`, { label: 'Size', type: 'choice', options: [] }))).toBe(
			'validation_failed',
		);
		await env.dashboard(cookie, 'PUT', `${base}/size`, { label: 'Size', type: 'choice', options: ['S', 'M'], required: true });
		await env.dashboard(cookie, 'PUT', `${base}/born`, { label: 'Birthday', type: 'date' });
		await env.dashboard(cookie, 'PUT', `${base}/kids`, { label: 'Children', type: 'number' });
		expect((await env.dashboard(cookie, 'GET', base)).json.items.map((/** @type {any} */ f) => f.key)).toEqual([
			'size',
			'born',
			'kids',
		]);
		expect(code(await signUp('cf@example.com'))).toBe('validation_failed');
		expect(code(await signUp('cf@example.com', undefined, { custom: { size: 'XL' } }))).toBe('validation_failed');
		expect(code(await signUp('cf@example.com', undefined, { custom: { size: 'S', nope: 1 } }))).toBe('validation_failed');
		expect(code(await signUp('cf@example.com', undefined, { custom: { size: 'S', born: '2020-13-45' } }))).toBe(
			'validation_failed',
		);
		expect(code(await signUp('cf@example.com', undefined, { custom: { size: 'S', kids: 'two' } }))).toBe('validation_failed');
		const up = await signUp('cf@example.com', undefined, { custom: { size: 'S', born: '1990-05-01', kids: 2 } });
		expect(up.json.user.custom).toEqual({ size: 'S', born: '1990-05-01', kids: 2 });
		const patched = await env.visitor('PATCH', '/v1/me', { custom: { size: 'M', kids: null } }, up.json.signIn);
		expect(patched.json.custom).toEqual({ size: 'M', born: '1990-05-01' });
		expect(code(await env.visitor('PATCH', '/v1/me', { custom: { size: null } }, up.json.signIn))).toBe('validation_failed');
		const config = await env.visitor('GET', '/v1/widget/config');
		expect(config.json.settings.customFields).toHaveLength(3);
		expect((await env.dashboard(cookie, 'DELETE', `${base}/kids`)).status).toBe(204);
		expect(code(await env.dashboard(cookie, 'DELETE', `${base}/kids`))).toBe('not_found');
	});

	it('risk checks: disposable domains, accounts per device and per network', async () => {
		expect(code(await signUp('x@mailinator.com', undefined, { custom: { size: 'S' } }))).toBe('risk_refused');
		await env.setting('risk_checks', 'blockedDomains', ['spam.example']);
		expect(code(await signUp('x@sub.spam.example', undefined, { custom: { size: 'S' } }))).toBe('risk_refused');
		await env.setting('risk_checks', 'maxAccountsPerDevice', 1);
		const device = { deviceId: 'device-bbbbbbbbbbbbbbbb', custom: { size: 'S' } };
		expect((await signUp('d1@example.com', undefined, device)).json.status).toBe('signed_in');
		expect(code(await signUp('d2@example.com', undefined, device))).toBe('risk_refused');
		await env.setting('risk_checks', 'maxSignUpsPerNetworkPerDay', 1);
		env.setNetwork('198.51.100.7');
		expect((await signUp('n1@example.com', undefined, { custom: { size: 'S' } })).json.status).toBe('signed_in');
		expect(code(await signUp('n2@example.com', undefined, { custom: { size: 'S' } }))).toBe('risk_refused');
		env.setNetwork(null);
		await env.setting('risk_checks', 'maxSignUpsPerNetworkPerDay', 1000);
	});
});

describe('the merchant side: users, tickets and activity copies', () => {
	it('Users admin: list, search, notes, block (signs out at once), sign out', async () => {
		const t = await env.ticket(['users.read']);
		const page = await env.admin(t, 'GET', '/v1/admin/users?limit=2');
		expect(page.json.items).toHaveLength(2);
		expect(page.json.hasMore).toBe(true);
		const next = await env.admin(t, 'GET', `/v1/admin/users?limit=2&cursor=${page.json.nextCursor}`);
		expect(next.json.items[0].id).not.toBe(page.json.items[0].id);
		const ana = (await env.admin(t, 'GET', '/v1/admin/users?q=ana@&role=customer&status=active')).json.items[0];
		expect((await env.admin(t, 'GET', `/v1/admin/users/${ana.id}`)).json.email).toBe('ana@example.com');
		expect(code(await env.admin(t, 'GET', '/v1/admin/users/usr_nope'))).toBe('not_found');
		expect(code(await env.admin(t, 'PATCH', `/v1/admin/users/${ana.id}`, { notes: 'x' }))).toBe('forbidden');
		const m = await env.ticket(['users.read', 'users.manage']);
		const s = await signIn('ana@example.com', 'another long one');
		expect(code(await env.admin(m, 'PATCH', `/v1/admin/users/${ana.id}`, { notes: 5 }))).toBe('validation_failed');
		const blocked = await env.admin(m, 'PATCH', `/v1/admin/users/${ana.id}`, {
			notes: 'Asked for invoices',
			blocked: true,
			blockedReason: 'Chargebacks',
			name: 'Ana Q',
			custom: { size: 'M' },
		});
		expect(blocked.json).toMatchObject({ notes: 'Asked for invoices', blocked: { reason: 'Chargebacks' }, name: 'Ana Q' });
		expect(code(await env.visitor('GET', '/v1/me', undefined, s.json.signIn))).toBe('signed_out');
		expect(code(await signIn('ana@example.com', 'another long one'))).toBe('blocked');
		expect((await env.admin(m, 'GET', '/v1/admin/users?status=blocked')).json.items).toHaveLength(1);
		await env.admin(m, 'PATCH', `/v1/admin/users/${ana.id}`, { blocked: false });
		const back = await signIn('ana@example.com', 'another long one');
		expect((await env.admin(m, 'POST', `/v1/admin/users/${ana.id}/sign-out`)).status).toBe(204);
		expect(code(await env.visitor('POST', '/v1/session/refresh', { refreshToken: back.json.refreshToken }))).toBe('signed_out');
		expect((await env.admin(m, 'GET', '/v1/admin/roles')).json.items.length).toBeGreaterThan(5);
		const r = await env.ticket(['roles.manage']);
		expect((await env.admin(r, 'PUT', '/v1/admin/roles/editor', { name: 'Editor' })).json.key).toBe('editor');
		expect((await env.admin(r, 'GET', '/v1/admin/roles/permissions')).json.groups.length).toBeGreaterThan(1);
		expect((await env.admin(r, 'PUT', '/v1/admin/roles/permissions', { permissions: [] })).json.permissions).toEqual([]);
		expect((await env.admin(r, 'DELETE', '/v1/admin/roles/editor')).status).toBe(204);
		// staff actions go to the activity log in the merchant database
		const db = await env.product.data.forWebsite(env.websiteId);
		const actions = (await db.collection('activity').find({ websiteId: env.websiteId }).toArray()).map((e) => e.action);
		expect(actions).toEqual(
			expect.arrayContaining(['user.blocked', 'user.unblocked', 'user.notes_changed', 'role.saved', 'role.deleted']),
		);
	});

	it('receives activity-log copies from other products and lists them newest first', async () => {
		const other = (await env.portal.issueToken({ websiteId: env.websiteId, productId: 'accounts', kind: 'server' })).token;
		const copy = {
			websiteId: env.websiteId,
			productId: 'chat',
			actor: { kind: 'staff', id: 'u_1', name: 'Sam' },
			action: 'conversation.closed',
			target: 'cnv_1',
			at: new Date(env.now()).toISOString(),
		};
		const sent = await env.call('POST', '/v1/activity-copies', { token: other, body: copy });
		expect(sent.status).toBe(201);
		await env.call('POST', '/v1/activity-copies', {
			token: other,
			body: { ...copy, productId: 'notifications', at: new Date(env.now() + 1000).toISOString() },
		});
		expect(
			code(await env.call('POST', '/v1/activity-copies', { token: other, body: { ...copy, websiteId: 'web_other0000' } })),
		).toBe('validation_failed');
		const listed = await env.serverCall('GET', '/v1/activity-copies?limit=1');
		expect(listed.json.items[0]).toMatchObject({ productId: 'notifications' });
		const rest = await env.serverCall('GET', `/v1/activity-copies?limit=5&cursor=${listed.json.nextCursor}`);
		expect(rest.json.items[0]).toMatchObject({ productId: 'chat', action: 'conversation.closed' });
		expect((await env.serverCall('GET', '/v1/activity-copies?productId=chat')).json.items).toHaveLength(1);
		// a browser call with an Origin is refused on server routes
		expect((await env.call('GET', '/v1/activity-copies', { token: env.server, origin: ORIGIN })).status).toBe(401);
	});

	it('the Orders tab reads the user’s orders from Ecommerce', async () => {
		const s = await signIn('pen@example.com');
		env.responders.set(`${SHOP}/v1/customers/${s.json.user.id}/orders`, () => ({
			status: 200,
			body: { items: [{ id: 'ord_1', number: '1042', status: 'delivered' }] },
		}));
		expect((await env.visitor('GET', '/v1/me/orders', undefined, s.json.signIn)).json.items).toEqual([
			{ id: 'ord_1', number: '1042', status: 'delivered' },
		]);
		env.responders.set(`${SHOP}/v1/customers/${s.json.user.id}/orders`, () => ({ status: 500, body: {} }));
		expect(code(await env.visitor('GET', '/v1/me/orders', undefined, s.json.signIn))).toBe('product_not_connected');
	});
});

describe('data rights', () => {
	it('download my data: Accounts and every connected product, one single-use link for 15 minutes', async () => {
		env.responders.set(`${CHAT}/v1/data-rights/export`, () => ({
			status: 200,
			body: { records: { conversations: [{ id: 'c1' }] } },
		}));
		env.responders.set(`${SHOP}/v1/data-rights/export`, () => ({ status: 503, body: {} }));
		const s = await signIn('pen@example.com');
		const asked = await env.visitor('POST', '/v1/me/export', {}, s.json.signIn);
		expect(asked.json.url).toMatch(new RegExp(`^https://accounts.example.dev/v1/exports/${env.websiteId}/`));
		const path = new URL(asked.json.url).pathname;
		const file = await env.call('GET', path);
		expect(file.headers.get('content-disposition')).toContain('attachment');
		expect(file.json.records).toMatchObject({
			accounts: { user: { email: 'pen@example.com' } },
			chat: { conversations: [{ id: 'c1' }] },
			ecommerce: { unavailable: true },
		});
		expect(file.json.records.notifications).toEqual({});
		expect(code(await env.call('GET', path))).toBe('not_found');
		expect(code(await env.call('GET', '/v1/exports/web_nope/x'))).toBe('not_found');
	});

	it('delete my account waits for approval, then erases the user here and in every connected product', async () => {
		/** @type {string[]} */
		const deletes = [];
		for (const base of [CHAT, SHOP, NOTIFY])
			env.responders.set(`${base}/v1/data-rights/delete`, (call) => {
				deletes.push(`${base} ${call.body}`);
				return { status: 200, body: { deleted: 1, anonymised: 0 } };
			});
		await env.setting('data_rights', 'deleteAfterDays', 0);
		const s = await signIn('pen@example.com');
		const asked = await env.visitor('POST', '/v1/me/delete', {}, s.json.signIn);
		expect(asked.status).toBe(202);
		expect(asked.json.dueAt).toBeNull();
		const t = await env.ticket(['users.read', 'users.manage']);
		const waiting = await env.admin(t, 'GET', '/v1/admin/users?deletion=1');
		expect(waiting.json.items.map((/** @type {any} */ u) => u.email)).toEqual(['pen@example.com']);
		const id = waiting.json.items[0].id;
		const approved = await env.admin(t, 'POST', `/v1/admin/users/${id}/deletion/approve`);
		expect(approved.json).toEqual({ deleted: true, pending: [] });
		expect(deletes).toHaveLength(3);
		expect(deletes[0]).toContain(`"id":"${id}"`);
		expect(code(await env.admin(t, 'GET', `/v1/admin/users/${id}`))).toBe('not_found');
		expect(code(await signIn('pen@example.com'))).toBe('sign_in_failed');
		// reject keeps the account
		const keep = await signIn('inv@example.com', 'my invite password');
		await env.visitor('POST', '/v1/me/delete', {}, keep.json.signIn);
		const kept = await env.admin(t, 'POST', `/v1/admin/users/${keep.json.user.id}/deletion/reject`);
		expect(kept.json.deletion).toBeNull();
		expect(code(await env.admin(t, 'POST', `/v1/admin/users/${keep.json.user.id}/deletion/reject`))).toBe('conflict');
		expect(code(await env.admin(t, 'POST', `/v1/admin/users/${keep.json.user.id}/deletion/approve`))).toBe('conflict');
	});

	it('after N days the deletion runs on its own on a later request; unconfirmed products are asked again', async () => {
		await env.setting('data_rights', 'deleteAfterDays', 2);
		const s = await signIn('inv@example.com', 'my invite password');
		const asked = await env.visitor('POST', '/v1/me/delete', {}, s.json.signIn);
		expect(Date.parse(asked.json.dueAt) - env.now()).toBe(2 * 86_400_000);
		/** @type {number} */
		let chatCalls = 0;
		env.responders.set(`${CHAT}/v1/data-rights/delete`, () => {
			chatCalls += 1;
			return chatCalls === 1 ? { status: 503, body: {} } : { status: 200, body: { deleted: 1, anonymised: 0 } };
		});
		env.advance(2 * 86_400_000 + 1000);
		await env.serverCall('GET', '/v1/roles');
		expect(code(await signIn('inv@example.com', 'my invite password'))).toBe('sign_in_failed');
		expect(chatCalls).toBeGreaterThanOrEqual(2);
	});

	it('the kit routes export and delete Accounts’ own records for a user (server token)', async () => {
		const exported = await env.serverCall('POST', '/v1/data-rights/export', { user: { email: 'cy@example.com' } });
		expect(exported.json.records.users[0]).toMatchObject({ email: 'cy@example.com' });
		expect(Array.isArray(exported.json.records.devices)).toBe(true);
		const deleted = await env.serverCall('POST', '/v1/data-rights/delete', { user: { email: 'CY@example.com' } });
		expect(deleted.json.deleted).toBeGreaterThan(1);
		expect((await env.serverCall('POST', '/v1/data-rights/export', { user: { phone: '+19999999999' } })).json.records).toEqual({
			users: [],
			devices: [],
		});
	});
});

describe('edges', () => {
	it('refuses what does not apply and reports missing connections', async () => {
		env.advance(31_000);
		await env.visitor('POST', '/v1/sign-in/phone/code', { phone: '+923001234567' });
		// a terms step does not use the code up
		const asked = await env.visitor('POST', '/v1/sign-in/phone', { phone: '+923001234567', code: lastMessage().values.code });
		expect(code(asked)).toBe('terms_required');
		const pat = await env.visitor('POST', '/v1/sign-in/phone', {
			phone: '+923001234567',
			code: lastMessage().values.code,
			acceptTerms: true,
		});
		const t = pat.json.signIn;
		expect(code(await env.visitor('PUT', '/v1/me/password', { password: 'a long new password' }, t))).toBe('validation_failed');
		expect((await env.visitor('POST', '/v1/me/two-step/disable', { code: '1' }, t)).status).toBe(204);
		expect(code(await env.visitor('POST', '/v1/me/two-step/enable', { challenge: 'x', code: '1' }, t))).toBe('code_invalid');
		const cookie = await env.adminSession();
		for (const name of ['ecommerce', 'google'])
			await env.dashboard(cookie, 'DELETE', `/v1/dashboard/websites/${env.websiteId}/connections/${name}`);
		expect(code(await env.visitor('GET', '/v1/me/orders', undefined, t))).toBe('product_not_connected');
		expect(code(await env.visitor('POST', '/v1/sign-in/google/start', { returnTo: ORIGIN }))).toBe('provider_failed');
		expect(code(await env.serverCall('PATCH', '/v1/users/usr_nope', { notes: 'x' }))).toBe('not_found');
		expect(code(await env.serverCall('POST', '/v1/users/usr_nope/sign-out', {}))).toBe('not_found');
		expect(code(await env.serverCall('POST', `/v1/users/${pat.json.user.id}/approve`, {}))).toBe('conflict');
		expect(code(await env.serverCall('PATCH', `/v1/users/${pat.json.user.id}`, { name: 'x'.repeat(200) }))).toBe(
			'validation_failed',
		);
		expect(code(await env.serverCall('PATCH', `/v1/users/${pat.json.user.id}`, { custom: { nope: 1 } }))).toBe(
			'validation_failed',
		);
		const merchant = await env.merchantSession();
		const fields = `/v1/dashboard/websites/${env.websiteId}/fields`;
		expect((await env.dashboard(merchant, 'GET', fields)).status).toBe(200);
	});
});

describe('statuses and notices', () => {
	it('stopped, suspended and removed refuse everything; the public keys too', async () => {
		for (const status of /** @type {const} */ (['stopped', 'suspended', 'removed'])) {
			env.portal.setStatus(env.websiteId, { status });
			env.advance(1000);
			await env.portal.sendNotice('accounts', { type: 'status.changed', websiteId: env.websiteId });
			await env.flush();
			const refused = await signIn('ana@example.com', 'another long one');
			expect(refused.status, JSON.stringify(refused.json)).toBe(403);
			expect(refused.json, JSON.stringify(refused.json)).toMatchObject({ reason: status });
			expect(code(await env.call('GET', `/v1/websites/${env.websiteId}/keys`))).toBe('not_found');
		}
		env.portal.setStatus(env.websiteId, { status: 'grace', graceEndsAt: new Date(env.now() + 86_400_000).toISOString() });
		env.advance(1000);
		await env.portal.sendNotice('accounts', { type: 'status.changed', websiteId: env.websiteId });
		await env.flush();
		// a removed product turned its switches off; an admin switches them on again
		await env.switchOn(ALL);
		expect((await signIn('ana@example.com', 'another long one')).json.status).toBe('signed_in');
	});

	it('website.deleted removes the product database records of the website', async () => {
		await env.portal.sendNotice('accounts', { type: 'website.deleted', websiteId: env.websiteId });
		await env.flush();
		const cookie = await env.adminSession();
		const listed = await env.dashboard(cookie, 'GET', `/v1/dashboard/websites/${env.websiteId}/connections`);
		expect(listed.json?.connections?.every?.((/** @type {any} */ c) => c.status === 'not_connected') ?? true).toBe(true);
	});
});

describe('admin origin', () => {
	it('a ticket works only from its own origin', async () => {
		const t = await env.ticket(['users.read']);
		expect((await env.call('GET', '/v1/admin/users', { token: t, origin: 'https://evil.example.org' })).status).toBe(401);
		expect(ADMIN_ORIGIN).toBe('https://admin.shop.example.com');
	});
});
