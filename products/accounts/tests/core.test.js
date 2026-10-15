import { describe, expect, it } from 'vitest';
import { verifyIdentityToken } from '@ss/app-kit';
import {
	createSealer,
	generateSigningKey,
	hashPassword,
	matchRecoveryCode,
	signJwt,
	totpCode,
	verifyPassword,
	verifyTotp,
} from '../adapters/crypto.js';
import { appleClientSecret, createProviders, pkceChallenge } from '../adapters/providers.js';
import { PHONE_COUNTRIES } from '@ss/contracts/phone';
import { emailDomain } from '../core/identifiers.js';
import {
	checkAddresses,
	checkCustomValues,
	checkFieldDefinition,
	identityOf,
	identityOfMethod,
	resetsByEmail,
	selfView,
	staffView,
} from '../core/profile.js';
import { checkOwnPermissions, checkRole, permissionCatalog, remembered, sessionEnd } from '../core/roles.js';
import {
	deviceIdOf,
	deviceOf,
	emailRefused,
	generateCode,
	normaliseCode,
	passwordProblem,
	returnAddress,
	setupLinkState,
} from '../core/rules.js';
import { createSnippets } from '../core/snippets.js';
import { parseSecret } from '../server/service.js';
import { appleKey, idToken } from './helpers.js';
import phoneCode from '../schemas/phone_code.settings.json' with { type: 'json' };

describe('identifiers', () => {
	it('the domain of an address', () => {
		expect(emailDomain('a@shop.example.com')).toBe('shop.example.com');
	});

	it('the allowed phone countries are the shared normalizer’s countries', () => {
		expect(phoneCode.properties.countries.items.enum).toEqual([...PHONE_COUNTRIES]);
	});
});

describe('profile', () => {
	it('checks custom field definitions and values', () => {
		expect(checkFieldDefinition('Bad', {}).ok).toBe(false);
		expect(checkFieldDefinition('a', null).ok).toBe(false);
		expect(checkFieldDefinition('a', { label: 'A', type: 'colour' }).ok).toBe(false);
		expect(checkFieldDefinition('a', { label: 'A', type: 'choice', options: ['x', ''] }).ok).toBe(false);
		expect(checkFieldDefinition('a', { label: 'A', type: 'text', options: ['x'] })).toEqual({
			ok: true,
			value: { key: 'a', label: 'A', type: 'text', options: [], required: false },
		});
		expect(checkFieldDefinition('a', { label: 5, type: 'text' }).ok).toBe(false);
		const fields = /** @type {any[]} */ ([
			{ key: 'size', label: 'Size', type: 'choice', options: ['S'], required: true },
			{ key: 'note', label: 'Note', type: 'text', options: [], required: false },
		]);
		expect(checkCustomValues([...fields], 'x', { complete: false }).ok).toBe(false);
		expect(checkCustomValues([...fields], [], { complete: false }).ok).toBe(false);
		expect(checkCustomValues([...fields], undefined, { complete: true }).ok).toBe(false);
		expect(checkCustomValues([...fields], { note: 'x'.repeat(2000) }, { complete: false }).ok).toBe(false);
		expect(checkCustomValues([...fields], { note: '' }, { complete: false, current: { note: 'a' } })).toEqual({
			ok: true,
			value: {},
		});
	});

	it('checks addresses and shows users', () => {
		expect(checkAddresses('x', () => 'adr_x').ok).toBe(false);
		expect(checkAddresses([null], () => 'adr_x').ok).toBe(false);
		expect(checkAddresses([{ line1: 'a', city: 'b', label: 'x'.repeat(50) }], () => 'adr_x').ok).toBe(false);
		const kept = checkAddresses([{ id: 'adr_keepme123', line1: 'a', city: 'b' }], () => 'adr_new');
		expect(kept.ok && kept.value[0]?.id).toBe('adr_keepme123');
		const user = /** @type {any} */ ({
			id: 'usr_1',
			email: null,
			emailVerified: false,
			phone: '+15550001111',
			phoneVerified: true,
			name: '',
			addresses: [],
			custom: {},
			notes: 'n',
			blocked: { at: new Date(0), reason: 'r' },
			status: 'active',
			role: 'customer',
			providers: {},
			passwordHash: null,
			twoStep: null,
			terms: { version: '1', acceptedAt: new Date(0) },
			deletion: { requestedAt: new Date(0), dueAt: null },
			lastSignInAt: null,
			roleSince: new Date(1000),
			createdAt: new Date(0),
		});
		expect(selfView(user)).toMatchObject({
			providers: [],
			deletion: { dueAt: null },
			terms: { version: '1' },
			roleSince: '1970-01-01T00:00:01.000Z',
			createdAt: '1970-01-01T00:00:00.000Z',
		});
		expect(staffView(user)).toMatchObject({ notes: 'n', blocked: { reason: 'r' }, lastSignInAt: null });
	});
});

describe('identities', () => {
	it('keeps the address an account was made with, and derives it for an imported account without one', () => {
		expect(['email_password', 'email_code', 'phone_password', 'phone_code', 'google'].map(identityOfMethod)).toEqual([
			'email',
			'email',
			'phone',
			'phone',
			'provider',
		]);
		const at = (/** @type {Record<string, unknown>} */ user) =>
			/** @type {any} */ ({ email: 'a@example.com', emailVerified: false, phone: null, ...user });
		expect(identityOf(at({ identity: 'phone' }))).toBe('phone');
		expect(identityOf(at({}))).toBe('email');
		expect(identityOf(at({ phone: '+15550001111' }))).toBeNull();
		expect(identityOf(at({ email: null, phone: '+15550001111' }))).toBeNull();
		expect(resetsByEmail(at({ identity: 'email' }))).toBe(true);
		expect(resetsByEmail(at({ identity: 'phone' }))).toBe(false);
		expect(resetsByEmail(at({ identity: 'phone', emailVerified: true }))).toBe(true);
		expect(resetsByEmail(at({ identity: 'provider' }))).toBe(false);
		expect(resetsByEmail(at({ phone: '+15550001111' }))).toBe(false);
	});
});

describe('roles and rules', () => {
	it('checks roles and own permissions and builds the catalog', () => {
		expect(checkRole('ok_role', null).ok).toBe(false);
		expect(checkRole('ok_role', { name: 'R', description: 'x'.repeat(400) }).ok).toBe(false);
		expect(checkRole('ok_role', { name: 'R', permissions: 'x' })).toMatchObject({ ok: true, value: { permissions: [] } });
		expect(sessionEnd({ now: 0, remember: true, role: { sessionHours: 2, rememberDays: 0 } })).toBe(2 * 3_600_000);
		// A14: never remembered, and the server end is the longer of the two lengths
		expect(sessionEnd({ now: 0, remember: false, role: { sessionHours: 2, rememberDays: 3, remember: 'never' } })).toBe(
			72 * 3_600_000,
		);
		expect(sessionEnd({ now: 0, remember: false, role: { sessionHours: 100, rememberDays: 1, remember: 'never' } })).toBe(
			100 * 3_600_000,
		);
		expect(remembered({ remember: 'never' }, true)).toBe(false);
		expect(remembered({ remember: 'always' }, false)).toBe(true);
		expect(remembered({ remember: 'ask' }, true)).toBe(true);
		expect(checkRole('ok_role', { name: 'R', remember: 'never' })).toMatchObject({ ok: true, value: { remember: 'never' } });
		expect(checkRole('ok_role', { name: 'R', remember: 'sometimes' })).toMatchObject({ ok: false, field: 'remember' });
		expect(checkOwnPermissions('x').ok).toBe(false);
		expect(checkOwnPermissions([{ key: 'a', name: '' }]).ok).toBe(false);
		expect(checkOwnPermissions([null]).ok).toBe(false);
		expect(
			checkOwnPermissions([
				{ key: 'a', name: 'A' },
				{ key: 'a', name: 'B' },
			]),
		).toEqual({ ok: true, value: [{ key: 'a', name: 'B' }] });
		expect(permissionCatalog({ products: [], own: [] })).toEqual([{ source: 'site', permissions: [] }]);
	});

	it('codes, passwords, risk, return addresses and devices', () => {
		let n = 0;
		const bytes = (/** @type {number} */ size) => Uint8Array.from({ length: size }, () => (n++ % 2 === 0 ? 255 : 7));
		expect(generateCode({ length: 6, randomBytes: bytes })).toBe('777777');
		expect(normaliseCode('12 34-56', 6)).toBe('123456');
		expect(normaliseCode(5, 6)).toBeNull();
		expect(normaliseCode('1'.repeat(40), 6)).toBeNull();
		expect(passwordProblem(undefined, { minLength: 8 })).toBe('too_short');
		expect(passwordProblem('long enough', { minLength: 8 })).toBeNull();
		expect(passwordProblem('a1'.repeat(65), { minLength: 8 })).toBeNull();
		expect(passwordProblem('a1'.repeat(65), { minLength: 8, maxLength: 128 })).toBe('too_long');
		expect(passwordProblem('a'.repeat(257), { minLength: 8, maxLength: 300 })).toBe('too_long');
		expect(passwordProblem('12345678', { minLength: 8, letterAndDigit: true })).toBe('letter_and_digit');
		expect(emailRefused('a@mailinator.com', { blockDisposable: false, blockedDomains: ['', '.example.org'] })).toBe(false);
		expect(emailRefused('a@x.example.org', { blockDisposable: false, blockedDomains: ['.example.org'] })).toBe(true);
		expect(returnAddress('https://shop.example.com:8443/', 'shop.example.com')).toBeNull();
		expect(returnAddress('https://u:p@shop.example.com/', 'shop.example.com')).toBeNull();
		expect(returnAddress('not a url', 'shop.example.com')).toBeNull();
		expect(returnAddress(5, 'shop.example.com')).toBeNull();
		expect(returnAddress('http://shop.localhost:5173/a#x', 'shop.example.com')).toBe('http://shop.localhost:5173/a');
		expect(deviceOf('Mozilla/5.0 (Linux; Android 14) Chrome/120')).toBe('Chrome on Android');
		expect(deviceOf(undefined)).toBe('Unknown browser on Unknown system');
		expect(deviceIdOf('short')).toBeNull();
		expect(parseSecret('cod_abc.short')).toBeNull();
		expect(parseSecret(5)).toBeNull();
	});

	it('a setup link’s state for a setup page: from its live record and its trace (A3, P4)', () => {
		const end = new Date(10_000);
		const live = { expireAt: end };
		/** @param {string} state @param {number} [until] */
		const trace = (state, until = 10_000) => ({ data: { state, validUntil: new Date(until) } });
		expect(setupLinkState({ live: null, trace: null, now: 0 })).toEqual({ status: 'invalid' });
		// a link made before traces were kept
		expect(setupLinkState({ live, trace: null, now: 0 })).toEqual({ status: 'valid', until: end });
		expect(setupLinkState({ live, trace: trace('issued'), now: 0 })).toEqual({ status: 'valid', until: end });
		expect(setupLinkState({ live: null, trace: trace('issued'), now: 10_000 })).toEqual({ status: 'expired' });
		expect(setupLinkState({ live: null, trace: trace('used'), now: 0 })).toEqual({ status: 'used' });
		expect(setupLinkState({ live: null, trace: trace('used'), now: 99_000 })).toEqual({ status: 'used' });
		expect(setupLinkState({ live: null, trace: trace('canceled'), now: 0 })).toEqual({ status: 'canceled' });
		// gone while it still worked, without a trace saying why
		expect(setupLinkState({ live: null, trace: trace('issued'), now: 0 })).toEqual({ status: 'canceled' });
	});

	it('snippets name the website when it is known', () => {
		const snippets = createSnippets({ base: 'https://a.test', widgets: [], permissions: [], websiteId: 'web_1' });
		expect(snippets.keysUrl).toBe('https://a.test/v1/websites/web_1/keys');
		expect(snippets.verify).toContain("claims.aud !== 'web_1'");
	});
});

describe('crypto', () => {
	it('seals, hashes passwords, signs and verifies, TOTP and recovery codes', async () => {
		const sealer = createSealer('encryption-key-0123456789-abcdefghij');
		const sealed = sealer.seal('secret', 'aad');
		expect(sealer.open(sealed, 'aad')).toBe('secret');
		expect(sealer.open(sealed, 'other')).toBeNull();
		expect(createSealer('another-encryption-key-0123456789-xyz').open(sealed, 'aad')).toBeNull();
		for (const bad of [5, 'v2.a.b.c', 'v1.a.b', 'v1.a.b.c.d']) expect(sealer.open(bad, 'aad')).toBeNull();
		const hash = await hashPassword('pässword');
		expect(await verifyPassword('pässword', hash)).toBe(true);
		expect(await verifyPassword('pässword', 'bcrypt$x$y')).toBe(false);
		const { privateJwk, publicJwk } = generateSigningKey('k1');
		// a sign-in Accounts signs is what the kit's checker (every product's) takes, with the key Accounts publishes
		const issued = Math.floor(Date.parse('2026-10-01T10:00:00Z') / 1000);
		const issuer = { issuer: 'https://accounts.example.dev', jwks: [publicJwk], audience: 'web_1' };
		const token = signJwt(privateJwk, { iss: issuer.issuer, aud: 'web_1', sub: 'u', iat: issued, exp: issued + 900 });
		expect(verifyIdentityToken(token, issuer, { now: () => issued * 1000 })).toMatchObject({
			ok: true,
			identity: { subject: 'u' },
		});
		expect(
			verifyIdentityToken(token, { ...issuer, jwks: [{ ...publicJwk, kid: 'other' }] }, { now: () => issued * 1000 }),
		).toEqual({
			ok: false,
			code: 'unknown_key',
		});
		const secret = 'JBSWY3DPEHPK3PXP';
		const at = Date.parse('2026-10-01T10:00:00Z');
		const code = totpCode(secret, at);
		expect(verifyTotp(secret, code, { now: at, lastStep: null }).ok).toBe(true);
		expect(verifyTotp(secret, code, { now: at, lastStep: Math.floor(at / 30_000) + 1 }).ok).toBe(false);
		expect(verifyTotp(secret, 'abc', { now: at, lastStep: null }).ok).toBe(false);
		expect(verifyTotp('!!!', '123456', { now: at, lastStep: null }).ok).toBe(false);
		expect(matchRecoveryCode(5, [{ hash: 'x', format: 'v1' }])).toBe(-1);
	});
});

describe('providers', () => {
	/** @type {Array<{ url: string, init: any }>} */
	const sent = [];
	/** @type {(url: string) => { status: number, body: string }} */
	let answer = () => ({ status: 200, body: '{}' });
	const now = () => Date.parse('2026-10-01T10:00:00Z');
	const providers = createProviders({
		send: async (url, init) => {
			sent.push({ url, init });
			const a = answer(url);
			return { status: a.status, url, headers: {}, body: Buffer.from(a.body) };
		},
		now,
	});
	const exp = Math.floor(now() / 1000) + 600;

	it('refuses ID tokens with the wrong issuer, audience, nonce or expiry', async () => {
		const key = { clientId: 'c.apps.googleusercontent.com', clientSecret: 's' };
		const input = { code: 'x', redirectUri: 'https://a.test/cb', nonce: 'n', verifier: 'v' };
		for (const claims of [
			{ iss: 'evil', aud: key.clientId, sub: 's', nonce: 'n', exp },
			{ iss: 'accounts.google.com', aud: 'other', sub: 's', nonce: 'n', exp },
			{ iss: 'accounts.google.com', aud: [key.clientId], sub: 's', nonce: 'm', exp },
			{ iss: 'accounts.google.com', aud: key.clientId, sub: 's', nonce: 'n', exp: 1 },
			{ iss: 'accounts.google.com', aud: key.clientId, nonce: 'n', exp },
		]) {
			answer = () => ({ status: 200, body: JSON.stringify({ id_token: idToken(claims) }) });
			expect(await providers.identify('google', key, input)).toBeNull();
		}
		answer = () => ({ status: 200, body: 'not json' });
		expect(await providers.identify('google', key, input)).toBeNull();
		answer = () => ({ status: 200, body: JSON.stringify({ id_token: 'x.%%%.y' }) });
		expect(await providers.identify('google', key, input)).toBeNull();
		answer = () => ({
			status: 200,
			body: JSON.stringify({
				id_token: idToken({ iss: 'accounts.google.com', aud: key.clientId, sub: 's', nonce: 'n', exp, email: 'a@b.co' }),
			}),
		});
		expect(await providers.identify('google', key, input)).toEqual({ subject: 's', email: null, name: '' });
	});

	it('Apple with a bad user form and Facebook without a profile', async () => {
		const key = appleKey();
		const input = { code: 'x', redirectUri: 'https://a.test/cb', nonce: 'n', verifier: 'v', appleUser: '{bad' };
		answer = () => ({ status: 400, body: '{}' });
		expect(await providers.identify('apple', key, input)).toBeNull();
		answer = () => ({ status: 200, body: JSON.stringify({ id_token: idToken({ iss: 'evil' }) }) });
		expect(await providers.identify('apple', key, input)).toBeNull();
		answer = () => ({
			status: 200,
			body: JSON.stringify({
				id_token: idToken({ iss: 'https://appleid.apple.com', aud: key.servicesId, sub: 'a', nonce: 'n', exp }),
			}),
		});
		expect(await providers.identify('apple', key, input)).toEqual({ subject: 'a', email: null, name: '' });
		expect(appleClientSecret(key, now()).split('.')).toHaveLength(3);
		answer = (url) => (url.includes('/me?') ? { status: 200, body: '{}' } : { status: 200, body: '{"access_token":"t"}' });
		expect(await providers.identify('facebook', { appId: '1', appSecret: 's' }, input)).toBeNull();
		answer = (url) =>
			url.includes('/me?') ? { status: 200, body: '{"id":"f"}' } : { status: 200, body: '{"access_token":"t"}' };
		expect(await providers.identify('facebook', { appId: '1', appSecret: 's' }, input)).toEqual({
			subject: 'f',
			email: null,
			name: '',
		});
		expect(pkceChallenge('abc')).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect((await providers.test('facebook', { appId: 1 })).ok).toBe(false);
		expect((await providers.test('google', null)).ok).toBe(false);
	});

	it('the breached-password list: a failure never refuses a password', async () => {
		const failing = createProviders({
			send: async () => {
				throw new Error('down');
			},
			now,
		});
		expect(await failing.breached('anything at all')).toBe(false);
	});
});
