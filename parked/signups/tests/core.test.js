/** Pure core: identifiers, codes, limits, tokens, keys, sessions, redirects, profiles, consent, risk, data rights, templates. */
import { describe, expect, it } from 'vitest';
import { effectiveConfig } from '../core/config.js';
import { ALPHABETS, alphabetOf, attemptsRemaining, generateCode, normaliseCode } from '../core/codes.js';
import { covers, mergeAcceptances, parseAcceptances, pendingConsents } from '../core/consent.js';
import { anonymisedCustomer, deletionDue, deletionEffectiveAt } from '../core/dataRights.js';
import { emailDomain, isBlockedDomain, maskEmail, normaliseEmail } from '../core/email.js';
import { isChannel, kindOfChannel, maskIdentifier, parseIdentifier } from '../core/identifier.js';
import {
	MAX_PUBLISHED,
	activationFor,
	nextGeneration,
	prunableKeys,
	publishedKeys,
	rotationDue,
	signingKey,
} from '../core/keys.js';
import { DAY_MS, HOUR_MS, cooldownLeft, counterDecision, secondsUntil, sendLimits, windowStart } from '../core/limits.js';
import { orderCustomerId, orderUpdate, orderView } from '../core/orders.js';
import { internationalDigits, isE164, maskPhone, normalisePhone } from '../core/phone.js';
import { addressProblems, applyProfilePatch, badges, missingFields, validateProfilePatch } from '../core/profile.js';
import { hostAllowed, magicLink, resolveRedirect } from '../core/redirect.js';
import { emailBlocked, isNewDevice, rememberDevice, velocityLimits } from '../core/risk.js';
import { deviceOf, reuseDecision, sessionState, sessionWindow, sessionsOverLimit } from '../core/sessions.js';
import { fill, languageChain, renderMessage } from '../core/templates.js';
import {
	accessClaims,
	checkAccessClaims,
	discoveryDocument,
	formatToken,
	issuerFor,
	jwksUrlFor,
	parseToken,
	websiteIdOfJwksFile,
} from '../core/tokens.js';
import { challengeView, customerView, sessionView, tokensView } from '../core/views.js';
import {
	validateConsentAccept,
	validateCustomerAdminPatch,
	validateCustomerCreate,
	validateDataRequest,
	validateMagicConsume,
	validateMagicRequest,
	validateOtpRequest,
	validateOtpVerify,
	validateRefresh,
} from '../core/validate.js';

const T = Date.parse('2026-10-01T10:00:00Z');

describe('phone (E.164, country-agnostic)', () => {
	it('accepts international forms without configuration', () => {
		expect(normalisePhone('+92 320 4862403')).toBe('+923204862403');
		expect(normalisePhone('0092-320-4862403')).toBe('+923204862403');
		expect(normalisePhone('+1 (415) 555-0100')).toBe('+14155550100');
		expect(normalisePhone(' +44 20 7183 8750 ')).toBe('+442071838750');
	});
	it('accepts national forms only with a default calling code, dropping the trunk prefix', () => {
		expect(normalisePhone('0320 4862403')).toBeNull();
		expect(normalisePhone('0320 4862403', { defaultCallingCode: '+92', trunkPrefix: '0' })).toBe('+923204862403');
		expect(normalisePhone('(415) 555-0100', { defaultCallingCode: '+1', trunkPrefix: '' })).toBe('+14155550100');
		expect(normalisePhone('123', { defaultCallingCode: '+1' })).toBeNull();
		expect(normalisePhone('0320 4862403', { defaultCallingCode: '92' })).toBeNull();
	});
	it('refuses letters, misplaced plus signs, too long or too short numbers and non-strings', () => {
		for (const bad of ['+92 abc', '92+3204862403', '++923204862403', '+0123456789', '+12', '+1234567890123456', '', 42, null])
			expect(normalisePhone(/** @type {any} */ (bad))).toBeNull();
		expect(normalisePhone('1'.repeat(41))).toBeNull();
	});
	it('checks, converts and masks', () => {
		expect(isE164('+923204862403')).toBe(true);
		expect(isE164('923204862403')).toBe(false);
		expect(internationalDigits('+923204862403')).toBe('923204862403');
		expect(maskPhone('+442071838750')).toBe('+44•••••••750');
		expect(maskPhone('+1234567')).toBe('+1•••567');
	});
});

describe('email', () => {
	it('normalises one canonical mailbox form', () => {
		expect(normaliseEmail('  Ada.Lovelace+Shop@Example.COM ')).toBe('ada.lovelace+shop@example.com');
		for (const bad of [
			'',
			'a@b',
			'a@@b.com',
			'@b.com',
			'a@b.123',
			'.a@b.com',
			'a.@b.com',
			'a..b@c.com',
			'a b@c.com',
			`${'a'.repeat(65)}@b.com`,
			'a@-b.com',
			7,
		])
			expect(normaliseEmail(/** @type {any} */ (bad))).toBeNull();
		expect(normaliseEmail(`a@${'b'.repeat(250)}.com`)).toBeNull();
	});
	it('matches blocked domains and subdomains, masks', () => {
		expect(emailDomain('a@x.example.com')).toBe('x.example.com');
		expect(isBlockedDomain('a@mailinator.com', ['Mailinator.com'])).toBe(true);
		expect(isBlockedDomain('a@eu.mailinator.com', ['.mailinator.com'])).toBe(true);
		expect(isBlockedDomain('a@notmailinator.com', ['mailinator.com', ''])).toBe(false);
		expect(maskEmail('ada@example.com')).toBe('a•••@example.com');
		expect(maskEmail('a@example.com')).toBe('a•••@example.com');
	});
});

describe('identifier', () => {
	it('parses channel + address into a canonical identifier', () => {
		expect(parseIdentifier({ channel: 'email', to: 'A@B.com' }, { channels: ['email'] })).toEqual({
			ok: true,
			identifier: { kind: 'email', channel: 'email', value: 'a@b.com', masked: 'a•••@b.com' },
		});
		expect(parseIdentifier({ channel: 'whatsapp', to: '+923204862403' }, { channels: ['whatsapp'] })).toMatchObject({
			ok: true,
			identifier: { kind: 'phone', value: '+923204862403' },
		});
		expect(parseIdentifier({ channel: 'sms', to: '+92' }, { channels: ['sms'] })).toEqual({
			ok: false,
			code: 'identifier_invalid',
		});
		expect(parseIdentifier({ channel: 'email', to: 'nope' }, { channels: ['email'] })).toEqual({
			ok: false,
			code: 'identifier_invalid',
		});
		expect(parseIdentifier({ channel: 'sms', to: '+923204862403' }, { channels: ['email'] })).toEqual({
			ok: false,
			code: 'channel_disabled',
		});
		expect(parseIdentifier({ channel: 'fax', to: 'x' }, { channels: ['email'] })).toEqual({
			ok: false,
			code: 'channel_disabled',
		});
	});
	it('maps channels to kinds and masks', () => {
		expect(kindOfChannel('email')).toBe('email');
		expect(kindOfChannel('sms')).toBe('phone');
		expect(isChannel('whatsapp')).toBe(true);
		expect(isChannel(3)).toBe(false);
		expect(maskIdentifier('email', 'ada@example.com')).toBe('a•••@example.com');
		expect(maskIdentifier('phone', '+442071838750')).toBe('+44•••••••750');
	});
});

describe('codes', () => {
	it('generates codes of the alphabet without modulo bias (rejection sampling)', () => {
		let calls = 0;
		const bytes = (/** @type {number} */ n) => {
			calls += 1;
			return Uint8Array.from({ length: n }, (_, i) => (calls === 1 ? 255 : i)); // first batch is all rejected (≥ 250)
		};
		expect(generateCode({ length: 6, alphabet: ALPHABETS.numeric, randomBytes: bytes })).toBe('012345');
		expect(calls).toBe(2);
		const code = generateCode({
			length: 8,
			alphabet: ALPHABETS.alphanumeric,
			randomBytes: (n) => Uint8Array.from({ length: n }, (_, i) => i * 7),
		});
		expect(code).toHaveLength(8);
		expect([...code].every((c) => ALPHABETS.alphanumeric.includes(c))).toBe(true);
		expect(() => generateCode({ length: 0, alphabet: '01', randomBytes: (n) => new Uint8Array(n) })).toThrow(RangeError);
		expect(() => generateCode({ length: 4, alphabet: '0', randomBytes: (n) => new Uint8Array(n) })).toThrow(RangeError);
	});
	it('normalises typed codes and refuses impossible shapes', () => {
		expect(normaliseCode('123 - 456', { length: 6, alphabet: ALPHABETS.numeric })).toBe('123456');
		expect(normaliseCode('ab2c.d3e', { length: 6, alphabet: ALPHABETS.alphanumeric })).toBeNull(); // 7 characters
		expect(normaliseCode('ab2cd3', { length: 6, alphabet: ALPHABETS.alphanumeric })).toBe('AB2CD3');
		expect(normaliseCode('ab1cd3', { length: 6, alphabet: ALPHABETS.alphanumeric })).toBeNull(); // 1 is not in the alphabet
		expect(normaliseCode('12345', { length: 6, alphabet: ALPHABETS.numeric })).toBeNull();
		expect(normaliseCode(123456, { length: 6, alphabet: ALPHABETS.numeric })).toBeNull();
		expect(normaliseCode('1'.repeat(65), { length: 6, alphabet: ALPHABETS.numeric })).toBeNull();
		expect(alphabetOf('alphanumeric')).toBe(ALPHABETS.alphanumeric);
		expect(alphabetOf('other')).toBe(ALPHABETS.numeric);
		expect(attemptsRemaining(2, 5)).toBe(3);
		expect(attemptsRemaining(9, 5)).toBe(0);
	});
});

describe('limits', () => {
	it('names windows and decides counters', () => {
		expect(windowStart(T + 1234, HOUR_MS)).toBe(Math.floor((T + 1234) / HOUR_MS) * HOUR_MS);
		expect(secondsUntil(T, HOUR_MS, T + HOUR_MS - 500)).toBe(1);
		expect(secondsUntil(T, HOUR_MS, T)).toBe(3600);
		expect(counterDecision({ count: 3, max: 3, start: T, windowMs: HOUR_MS, now: T })).toEqual({ ok: true });
		expect(counterDecision({ count: 4, max: 3, start: T, windowMs: HOUR_MS, now: T + 600_000 })).toEqual({
			ok: false,
			retryAfter: 3000,
		});
		expect(counterDecision({ count: 99, max: 0, start: T, windowMs: HOUR_MS, now: T })).toEqual({ ok: true });
		expect(cooldownLeft(T + 1500, T)).toBe(2);
		expect(cooldownLeft(T - 1, T)).toBe(0);
		expect(
			sendLimits({ identityKey: 'i', ipKey: null, prefix: 'otp', perIdentityHour: 5, perIpHour: 20, globalHour: 500 }).map(
				(l) => l.key,
			),
		).toEqual(['otp:id:i', 'otp:all']);
		expect(
			sendLimits({ identityKey: 'i', ipKey: 'p', prefix: 'otp', perIdentityHour: 5, perIpHour: 20, globalHour: 500 }),
		).toHaveLength(3);
		expect(DAY_MS).toBe(24 * HOUR_MS);
	});
});

describe('tokens', () => {
	const customer = {
		id: 'cus_1',
		email: 'a@b.com',
		phone: '+14155550100',
		emailVerifiedAt: '2026-01-01',
		phoneVerifiedAt: null,
		sessionVersion: 2,
	};
	it('builds issuer URLs, discovery and JWKS file names', () => {
		expect(issuerFor('https://s.example.com/', 'web_1')).toBe('https://s.example.com/i/web_1');
		expect(jwksUrlFor('https://s.example.com', 'web_1')).toBe('https://s.example.com/.well-known/jwks/web_1.json');
		expect(discoveryDocument({ base: 'https://s.example.com', websiteId: 'web_1' })).toMatchObject({
			issuer: 'https://s.example.com/i/web_1',
		});
		expect(websiteIdOfJwksFile('web_abc123.json')).toBe('web_abc123');
		expect(websiteIdOfJwksFile('../web_abc.json')).toBeNull();
		expect(websiteIdOfJwksFile(undefined)).toBeNull();
	});
	it('builds access claims with optional identifiers', () => {
		const claims = accessClaims({
			issuer: 'iss',
			audience: 'aud',
			customer,
			sessionId: 'ses_1',
			method: 'otp',
			now: T,
			ttlMinutes: 15,
			jti: 'j',
			include: { email: true, phone: true },
		});
		expect(claims).toEqual({
			iss: 'iss',
			sub: 'cus_1',
			aud: 'aud',
			iat: T / 1000,
			exp: T / 1000 + 900,
			jti: 'j',
			sid: 'ses_1',
			sv: 2,
			amr: ['otp'],
			email: 'a@b.com',
			email_verified: true,
			phone_number: '+14155550100',
			phone_number_verified: false,
		});
		const bare = accessClaims({
			issuer: 'iss',
			audience: 'aud',
			customer: { id: 'c' },
			sessionId: 's',
			method: 'magic_link',
			now: T,
			ttlMinutes: 0,
			jti: 'j',
			include: { email: false, phone: false },
		});
		expect(bare).not.toHaveProperty('email');
		expect(bare.sv).toBe(0);
		expect(bare.exp - bare.iat).toBe(60);
	});
	it('checks registered claims', () => {
		const claims = accessClaims({
			issuer: 'iss',
			audience: 'aud',
			customer,
			sessionId: 's',
			method: 'otp',
			now: T,
			ttlMinutes: 15,
			jti: 'j',
			include: { email: false, phone: false },
		});
		expect(checkAccessClaims(claims, { issuer: 'iss', audience: 'aud', now: T })).toMatchObject({ ok: true });
		expect(checkAccessClaims({ ...claims, aud: ['x', 'aud'] }, { issuer: 'iss', audience: 'aud', now: T }).ok).toBe(true);
		expect(checkAccessClaims(claims, { issuer: 'other', audience: 'aud', now: T })).toEqual({ ok: false, code: 'issuer' });
		expect(checkAccessClaims(claims, { issuer: 'iss', audience: 'other', now: T })).toEqual({ ok: false, code: 'audience' });
		expect(checkAccessClaims(claims, { issuer: 'iss', audience: 'aud', now: T + 17 * 60_000 })).toEqual({
			ok: false,
			code: 'expired',
		});
		expect(checkAccessClaims(claims, { issuer: 'iss', audience: 'aud', now: T - 120_000 })).toEqual({
			ok: false,
			code: 'not_yet_valid',
		});
		expect(checkAccessClaims({ ...claims, exp: 'x' }, { issuer: 'iss', audience: 'aud', now: T })).toEqual({
			ok: false,
			code: 'malformed',
		});
		expect(checkAccessClaims({ ...claims, sv: 'x' }, { issuer: 'iss', audience: 'aud', now: T })).toEqual({
			ok: false,
			code: 'malformed',
		});
	});
	it('formats and parses opaque tokens', () => {
		const id = 'ses_0123456789abcdefghjkmnpqrs'.slice(0, 30);
		const secret = 'A'.repeat(43);
		expect(parseToken(formatToken('rt1', id, secret), 'rt1')).toEqual({ id, secret });
		for (const bad of [
			formatToken('ml1', id, secret),
			`rt1.${id}`,
			`rt1.${id}.${secret}.x`,
			`rt1.bad.${secret}`,
			`rt1.${id}.short`,
			`rt1.${id}.${'A'.repeat(40)}!`,
			'x'.repeat(600),
			5,
		])
			expect(parseToken(bad, 'rt1')).toBeNull();
	});
});

describe('signing keys', () => {
	const key = (/** @type {number} */ generation, /** @type {number} */ activatesAt) => ({
		generation,
		kid: `k${generation}`,
		publicJwk: {},
		activatesAt,
	});
	it('picks the signing key and publishes pending, current and retiring keys', () => {
		const keys = [key(1, T), key(2, T + 2 * HOUR_MS)];
		expect(signingKey([], T)).toBeNull();
		expect(signingKey(keys, T + HOUR_MS)?.kid).toBe('k1');
		expect(signingKey(keys, T + 3 * HOUR_MS)?.kid).toBe('k2');
		expect(publishedKeys(keys, T + HOUR_MS, HOUR_MS).map((k) => k.kid)).toEqual(['k2', 'k1']);
		expect(publishedKeys(keys, T + 2.5 * HOUR_MS, HOUR_MS).map((k) => k.kid)).toEqual(['k2', 'k1']);
		expect(publishedKeys(keys, T + 3.5 * HOUR_MS, HOUR_MS).map((k) => k.kid)).toEqual(['k2']);
		const many = Array.from({ length: 8 }, (_, i) => key(i + 1, T + i));
		expect(publishedKeys(many, T + 10, 1000)).toHaveLength(MAX_PUBLISHED);
		expect(publishedKeys([key(1, T + HOUR_MS)], T, 1000).map((k) => k.kid)).toEqual(['k1']);
	});
	it('decides rotations, activation, generations and pruning', () => {
		expect(rotationDue([], T, 90)).toBe(true);
		expect(rotationDue([key(1, T)], T + DAY_MS, 90)).toBe(false);
		expect(rotationDue([key(1, T)], T + 91 * DAY_MS, 90)).toBe(true);
		expect(rotationDue([key(1, T)], T + 91 * DAY_MS, 0)).toBe(false);
		expect(rotationDue([key(1, T), key(2, T + 100 * DAY_MS)], T + 91 * DAY_MS, 90)).toBe(false);
		expect(rotationDue([key(1, T + DAY_MS)], T, 90)).toBe(false);
		expect(activationFor([], T, 2)).toBe(T);
		expect(activationFor([key(1, T)], T, 2)).toBe(T + 2 * HOUR_MS);
		expect(nextGeneration([])).toBe(1);
		expect(nextGeneration([key(3, T), key(1, T)])).toBe(4);
		const keys = Array.from({ length: 7 }, (_, i) => key(i + 1, T + i * DAY_MS));
		expect(prunableKeys(keys, T + 10 * DAY_MS, HOUR_MS).map((k) => k.kid)).toEqual(['k1', 'k2']);
		expect(prunableKeys(keys, T + 10 * DAY_MS, HOUR_MS, 7)).toEqual([]);
	});
});

describe('sessions', () => {
	it('computes windows, states and reuse decisions', () => {
		expect(sessionWindow({ createdAt: T, now: T, refreshTtlDays: 30, idleTimeoutDays: 0, sliding: true })).toEqual({
			expiresAt: new Date(T + 30 * DAY_MS).toISOString(),
			idleExpiresAt: null,
		});
		expect(
			sessionWindow({ createdAt: T, now: T + DAY_MS, refreshTtlDays: 30, idleTimeoutDays: 14, sliding: true }).idleExpiresAt,
		).toBe(new Date(T + 15 * DAY_MS).toISOString());
		const previous = new Date(T + 5 * DAY_MS).toISOString();
		expect(
			sessionWindow({
				createdAt: T,
				now: T + DAY_MS,
				refreshTtlDays: 30,
				idleTimeoutDays: 14,
				sliding: false,
				previousIdle: previous,
			}).idleExpiresAt,
		).toBe(previous);
		expect(
			sessionWindow({ createdAt: T, now: T + 29 * DAY_MS, refreshTtlDays: 30, idleTimeoutDays: 14, sliding: true })
				.idleExpiresAt,
		).toBe(new Date(T + 30 * DAY_MS).toISOString());
		const s = {
			expiresAt: new Date(T + DAY_MS).toISOString(),
			idleExpiresAt: new Date(T + 1000).toISOString(),
			revokedAt: null,
		};
		expect(sessionState(s, T)).toBe('active');
		expect(sessionState(s, T + 2000)).toBe('idle');
		expect(sessionState(s, T + 2 * DAY_MS)).toBe('expired');
		expect(sessionState({ ...s, revokedAt: 'x' }, T)).toBe('revoked');
		expect(sessionState({ ...s, idleExpiresAt: null }, T + 2000)).toBe('active');
		expect(reuseDecision({ rotatedAt: new Date(T).toISOString(), now: T + 5000, graceSeconds: 10, reuseDetection: true })).toBe(
			'conflict',
		);
		expect(
			reuseDecision({ rotatedAt: new Date(T).toISOString(), now: T + 20_000, graceSeconds: 10, reuseDetection: true }),
		).toBe('reuse');
		expect(reuseDecision({ rotatedAt: null, now: T, graceSeconds: 10, reuseDetection: false })).toBe('invalid');
	});
	it('picks sessions over the limit and describes devices', () => {
		const sessions = [
			{ id: 'b', lastUsedAt: '2026-01-02' },
			{ id: 'a', lastUsedAt: '2026-01-01' },
			{ id: 'c', lastUsedAt: '2026-01-03' },
		];
		expect(sessionsOverLimit(sessions, 3)).toEqual(['a']);
		expect(sessionsOverLimit(sessions, 2)).toEqual(['a', 'b']);
		expect(sessionsOverLimit(sessions, 5)).toEqual([]);
		expect(sessionsOverLimit(sessions, 0)).toEqual([]);
		expect(deviceOf('Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537 Edg/120')).toEqual({
			label: 'Edge on Windows',
			browser: 'Edge',
			os: 'Windows',
		});
		expect(deviceOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/605.1.15').label).toBe('Safari on iOS');
		expect(deviceOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 14) Chrome/120 Safari/537').label).toBe('Chrome on macOS');
		expect(deviceOf('Mozilla/5.0 (X11; Linux x86_64) Firefox/130').label).toBe('Firefox on Linux');
		expect(deviceOf(undefined)).toEqual({
			label: 'Unknown browser on Unknown system',
			browser: 'Unknown browser',
			os: 'Unknown system',
		});
	});
});

describe('redirects', () => {
	const base = { domain: 'shop.example.com', allowSubdomains: false, allowedPaths: ['/'], callbackPath: '/welcome' };
	it('allows only https on the website domain and allowed paths', () => {
		expect(resolveRedirect({ ...base })).toEqual({ ok: true, url: 'https://shop.example.com/welcome' });
		expect(resolveRedirect({ ...base, redirect: 'https://shop.example.com/a?b=1#frag' })).toEqual({
			ok: true,
			url: 'https://shop.example.com/a?b=1',
		});
		expect(resolveRedirect({ ...base, redirect: 'https://eu.shop.example.com/' }).ok).toBe(false);
		expect(resolveRedirect({ ...base, allowSubdomains: true, redirect: 'https://eu.shop.example.com/' }).ok).toBe(true);
		for (const redirect of [
			'http://shop.example.com/',
			'https://a:b@shop.example.com/',
			'https://shop.example.com:444/',
			'https://shop.example.com.evil.net/',
			'not a url',
			'https://shop.example.com/\\x',
			42,
			'h'.repeat(3000),
		])
			expect(resolveRedirect({ ...base, redirect })).toEqual({ ok: false, code: 'redirect_not_allowed' });
		const paths = { ...base, allowedPaths: ['/account/', 'nope'] };
		expect(resolveRedirect({ ...paths, redirect: 'https://shop.example.com/account' }).ok).toBe(true);
		expect(resolveRedirect({ ...paths, redirect: 'https://shop.example.com/account/orders' }).ok).toBe(true);
		expect(resolveRedirect({ ...paths, redirect: 'https://shop.example.com/accounting' }).ok).toBe(false);
		expect(hostAllowed('shop.example.com', 'shop.example.com', false)).toBe(true);
		expect(magicLink('https://shop.example.com/', 'ml1.a.b')).toBe('https://shop.example.com/#ss_magic=ml1.a.b');
	});
});

describe('profiles', () => {
	const rules = {
		fields: [
			{ key: 'name', type: /** @type {const} */ ('text'), required: true, max_length: 5 },
			{ key: 'born', type: /** @type {const} */ ('date') },
			{ key: 'vip', type: /** @type {const} */ ('boolean') },
			{ key: 'age', type: /** @type {const} */ ('number') },
			{ key: 'site', type: /** @type {const} */ ('url') },
		],
		maxAddresses: 1,
		addressRequired: ['line1', 'country'],
		maxCustomKeys: 2,
	};
	it('validates patches against the field schema', () => {
		expect(
			validateProfilePatch(
				{ profile: { name: 'Ada', born: '1990-01-31', vip: true, age: 3, site: 'https://a.example' } },
				rules,
			),
		).toEqual([]);
		expect(
			validateProfilePatch(
				{ profile: { name: '', born: '1990-13-45', vip: 'y', age: 'x', site: 'ftp://x', other: 1 } },
				rules,
			).map((p) => [p.path, p.code]),
		).toEqual([
			['/profile/name', 'required'],
			['/profile/born', 'format'],
			['/profile/vip', 'type'],
			['/profile/age', 'type'],
			['/profile/site', 'format'],
			['/profile/other', 'unknown_field'],
		]);
		expect(validateProfilePatch({ profile: { name: 'toolong', site: 'nope', born: 5 } }, rules).map((p) => p.code)).toEqual([
			'too_long',
			'format',
			'format',
		]);
		expect(validateProfilePatch({ profile: { name: null, born: null, name2: undefined } }, rules).map((p) => p.code)).toEqual([
			'required',
			'unknown_field',
		]);
		expect(validateProfilePatch({ profile: { name: 3 } }, rules)[0]?.code).toBe('type');
		expect(validateProfilePatch(null, rules)).toEqual([{ path: '', code: 'type' }]);
		expect(validateProfilePatch({ profile: [], addresses: {}, custom: [], extra: 1 }, rules).map((p) => p.path)).toEqual([
			'/extra',
			'/profile',
			'/addresses',
			'/custom',
		]);
	});
	it('validates addresses and custom fields', () => {
		expect(addressProblems({ line1: 'x', country: 'NO' }, ['line1', 'country'], '/a')).toEqual([]);
		expect(
			addressProblems({ line1: 3, country: 'nor', zip: 'x', is_default: 'y' }, ['line1', 'country', 'city'], '/a').map(
				(p) => p.code,
			),
		).toEqual(['unknown_field', 'type', 'required', 'format', 'type']);
		expect(addressProblems('x', [], '/a')).toEqual([{ path: '/a', code: 'type' }]);
		expect(
			validateProfilePatch(
				{
					addresses: [
						{ line1: 'a', country: 'NO' },
						{ line1: 'b', country: 'SE' },
					],
				},
				rules,
			)[0]?.code,
		).toBe('too_many');
		expect(validateProfilePatch({ custom: { a: 1, b: 'x', c: true } }, rules)[0]?.code).toBe('too_many');
		expect(
			validateProfilePatch({ custom: { '1a': 1, b: {}, c: 'x'.repeat(501) } }, { ...rules, maxCustomKeys: 9 }).map(
				(p) => p.code,
			),
		).toEqual(['format', 'type', 'too_long']);
	});
	it('applies merge patches, addresses with stable ids and one default, and reports missing fields and badges', () => {
		let n = 0;
		const newId = () => `adr_${(n += 1)}`;
		const base = {
			profile: { name: 'Ada', born: '1990-01-01' },
			addresses: [{ id: 'adr_keep', line1: 'old' }],
			custom: { a: 1 },
		};
		const { customer, changed } = applyProfilePatch(
			base,
			{
				profile: { born: null, vip: true },
				addresses: [
					{ id: 'adr_keep', line1: 'new', country: 'NO' },
					{ id: 'adr_forged', line1: 'x', is_default: true },
				],
				custom: { a: null, b: 2, c: 3 },
			},
			{ newId, maxCustomKeys: 1 },
		);
		expect(customer.profile).toEqual({ name: 'Ada', vip: true });
		expect(customer.addresses).toEqual([
			{ id: 'adr_keep', line1: 'new', country: 'NO', is_default: false },
			{ id: 'adr_1', line1: 'x', is_default: true },
		]);
		expect(customer.custom).toEqual({ b: 2 });
		expect(changed).toEqual(['profile.born', 'profile.vip', 'addresses', 'custom']);
		expect(
			applyProfilePatch(/** @type {any} */ ({}), { addresses: [{ line1: 'a' }] }, { newId, maxCustomKeys: 1 }).customer
				.addresses?.[0]?.is_default,
		).toBe(true);
		expect(applyProfilePatch({}, {}, { newId, maxCustomKeys: 1 }).changed).toEqual([]);
		expect(missingFields({ profile: { name: ' ' } }, rules.fields)).toEqual(['name']);
		expect(missingFields({}, rules.fields)).toEqual(['name']);
		expect(missingFields({ profile: { name: 'x' } }, rules.fields)).toEqual([]);
		expect(badges({ email: 'a', emailVerifiedAt: 'x', phone: 'p' })).toEqual({ email: 'verified', phone: 'unverified' });
		expect(badges({})).toEqual({ email: 'none', phone: 'none' });
	});
});

describe('consent', () => {
	/** @type {Array<{ key: string, version: string, required: boolean }>} */
	const docs = [
		{ key: 'terms', version: '2', required: true },
		{ key: 'news', version: '1', required: false },
	];
	const terms = /** @type {{ key: string, version: string, required: boolean }} */ (docs[0]);
	it('knows what is pending for new and existing customers', () => {
		expect(pendingConsents(docs, undefined, { isNew: true, requireReacceptance: false }).map((d) => d.key)).toEqual(['terms']);
		expect(pendingConsents(docs, undefined, { isNew: false, requireReacceptance: false })).toEqual([]);
		expect(pendingConsents(docs, undefined, { isNew: false, requireReacceptance: true }).map((d) => d.key)).toEqual(['terms']);
		const old = { terms: { version: '1', acceptedAt: 'x' } };
		expect(pendingConsents(docs, old, { isNew: false, requireReacceptance: true }).map((d) => d.key)).toEqual(['terms']);
		expect(pendingConsents(docs, old, { isNew: false, requireReacceptance: false })).toEqual([]);
		expect(
			pendingConsents(docs, { terms: { version: '2', acceptedAt: 'x' } }, { isNew: false, requireReacceptance: true }),
		).toEqual([]);
	});
	it('parses, merges and covers acceptances', () => {
		expect(parseAcceptances(undefined, docs)).toEqual({ ok: true, accepted: [] });
		expect(
			parseAcceptances(
				[
					{ key: 'terms', version: '2' },
					{ key: 'terms', version: '2' },
				],
				docs,
			),
		).toEqual({ ok: true, accepted: [{ key: 'terms', version: '2' }] });
		expect(parseAcceptances('x', docs)).toEqual({ ok: false, problems: [{ path: '/consents', code: 'type' }] });
		expect(parseAcceptances([{ key: 'x', version: '1' }, { key: 'terms', version: '1' }, null], docs)).toEqual({
			ok: false,
			problems: [
				{ path: '/consents/0/key', code: 'unknown_document' },
				{ path: '/consents/1/version', code: 'outdated_version' },
				{ path: '/consents/2/key', code: 'unknown_document' },
			],
		});
		expect(mergeAcceptances(undefined, [{ key: 'terms', version: '2' }], 'now')).toEqual({
			terms: { version: '2', acceptedAt: 'now' },
		});
		expect(covers([terms], [{ key: 'terms' }])).toBe(true);
		expect(covers([terms], [])).toBe(false);
	});
});

describe('risk and data rights', () => {
	it('blocks disposable and listed domains, remembers devices, names velocity counters', () => {
		const rules = { blockDisposable: true, disposableDomains: ['mailinator.com'], blockedDomains: ['corp.example'] };
		expect(emailBlocked('a@mailinator.com', rules)).toBe(true);
		expect(emailBlocked('a@corp.example', { ...rules, blockDisposable: false })).toBe(true);
		expect(emailBlocked('a@mailinator.com', { ...rules, blockDisposable: false })).toBe(false);
		expect(isNewDevice(['a'], 'b')).toBe(true);
		expect(isNewDevice(['a'], 'a')).toBe(false);
		expect(isNewDevice(undefined, null)).toBe(false);
		expect(rememberDevice(['a', 'b', 'c'], 'a', 3)).toEqual(['b', 'c', 'a']);
		expect(rememberDevice(['a', 'b'], 'c', 2)).toEqual(['b', 'c']);
		expect(rememberDevice(undefined, null, 0)).toEqual([]);
		expect(velocityLimits({ ipKey: null, maxIdentities: 1, maxFailures: 1 })).toEqual({ identities: null, failures: null });
		const limits = velocityLimits({ ipKey: 'p', identityKey: 'i', maxIdentities: 3, maxFailures: 9 });
		expect(limits.identities).toMatchObject({ key: 'risk:ipid:p', member: 'i', max: 3 });
		expect(limits.failures).toMatchObject({ key: 'risk:fail:p', max: 9 });
		expect(velocityLimits({ ipKey: 'p', maxIdentities: 3, maxFailures: 9 }).identities).toBeNull();
	});
	it('schedules and recognises due deletions', () => {
		expect(deletionEffectiveAt(T, 14)).toBe(new Date(T + 14 * DAY_MS).toISOString());
		expect(deletionEffectiveAt(T, -3)).toBe(new Date(T).toISOString());
		const request = { type: 'delete', status: 'pending', effectiveAt: new Date(T).toISOString() };
		expect(deletionDue(request, T)).toBe(true);
		expect(deletionDue(request, T - 1)).toBe(false);
		expect(deletionDue({ ...request, status: 'cancelled' }, T)).toBe(false);
		expect(deletionDue({ ...request, type: 'export' }, T)).toBe(false);
		expect(deletionDue({ ...request, effectiveAt: null }, T)).toBe(false);
		expect(anonymisedCustomer('now')).toMatchObject({
			email: null,
			phone: null,
			status: 'deleted',
			deletedAt: 'now',
			profile: {},
		});
	});
});

describe('templates', () => {
	const catalogs = {
		en: {
			'message.otp.sms': '{code} for {brand}',
			'message.otp.email.subject': 'Code',
			'message.otp.email.body': 'Your code {code}',
		},
		pt: { 'message.otp.sms': '{code} para {brand}' },
	};
	it('fills placeholders and builds language chains', () => {
		expect(fill('{a} {b} {c}', { a: 1, b: 'x' })).toBe('1 x {c}');
		expect(languageChain('pt-BR', 'de')).toEqual(['pt-BR', 'pt', 'de', 'en']);
		expect(languageChain(null, 'en')).toEqual(['en']);
	});
	it('prefers merchant templates, then the catalog, by language', () => {
		const templates = [
			{ channel: 'sms', lang: 'pt', body: 'Código {code}' },
			{ channel: 'email', lang: 'de', subject: 'Ihr Code', body: 'Code {code}' },
			{ channel: 'email', lang: 'fr', body: 'Code {code}', purpose: 'magic_link' },
		];
		expect(
			renderMessage({
				purpose: 'otp',
				channel: 'sms',
				lang: 'pt-BR',
				defaultLanguage: 'en',
				templates,
				catalogs,
				params: { code: '1', brand: 'B' },
			}),
		).toEqual({ lang: 'pt', text: 'Código 1' });
		expect(
			renderMessage({
				purpose: 'otp',
				channel: 'email',
				lang: 'de',
				defaultLanguage: 'en',
				templates,
				catalogs,
				params: { code: '1' },
			}),
		).toEqual({ lang: 'de', subject: 'Ihr Code', text: 'Code 1' });
		expect(
			renderMessage({
				purpose: 'otp',
				channel: 'email',
				lang: 'fr',
				defaultLanguage: 'en',
				templates,
				catalogs,
				params: { code: '1' },
			}),
		).toEqual({ lang: 'en', subject: 'Code', text: 'Your code 1' });
		expect(
			renderMessage({
				purpose: 'otp',
				channel: 'email',
				lang: 'es',
				defaultLanguage: 'en',
				templates: [{ channel: 'email', lang: 'es', body: 'C {code}' }],
				catalogs,
				params: { code: '1' },
			}),
		).toEqual({ lang: 'es', subject: 'otp', text: 'C 1' });
		expect(
			renderMessage({
				purpose: 'otp',
				channel: 'sms',
				lang: 'de',
				defaultLanguage: 'pt',
				templates: [],
				catalogs,
				params: { code: '2', brand: 'B' },
			}),
		).toEqual({ lang: 'pt', text: '2 para B' });
		expect(
			renderMessage({
				purpose: 'magic_link',
				channel: 'email',
				lang: 'en',
				defaultLanguage: 'en',
				templates: [],
				catalogs: { en: { 'message.magic_link.email.body': '{link}' } },
				params: { link: 'L' },
			}),
		).toEqual({ lang: 'en', subject: 'magic_link', text: 'L' });
		expect(
			renderMessage({
				purpose: 'otp',
				channel: 'whatsapp',
				lang: 'xx',
				defaultLanguage: 'yy',
				templates: [],
				catalogs: {},
				params: { code: '9' },
			}),
		).toEqual({ lang: 'en', text: '9' });
		expect(
			renderMessage({
				purpose: 'otp',
				channel: 'email',
				lang: 'xx',
				defaultLanguage: 'yy',
				templates: [],
				catalogs: {},
				params: {},
			}),
		).toEqual({ lang: 'en', subject: 'otp', text: '' });
	});
});

describe('views, orders, validation and config', () => {
	it('builds public views', () => {
		const view = customerView({ id: 'c', status: 'active', createdAt: new Date(T) }, { fields: [] });
		expect(view).toMatchObject({
			id: 'c',
			email: null,
			phone: null,
			createdAt: new Date(T).toISOString(),
			signInCount: 0,
			profile: {},
			addresses: [],
		});
		expect(customerView({ id: 'c', status: 'active', createdAt: 'x' }, { fields: [] }).createdAt).toBe('x');
		expect(customerView({ id: 'c', status: 'active' }, { fields: [] }).createdAt).toBeNull();
		const session = {
			id: 's',
			customerId: 'c',
			createdAt: 'a',
			lastUsedAt: 'b',
			expiresAt: '2027-01-01',
			idleExpiresAt: '2026-11-01',
			revokedAt: null,
			method: 'otp',
			device: { label: 'l', browser: 'b', os: 'o' },
		};
		expect(sessionView(session, { now: T, currentId: 's' })).toMatchObject({
			expiresAt: '2026-11-01',
			current: true,
			state: 'active',
		});
		expect(sessionView({ ...session, idleExpiresAt: null }, { now: T }).expiresAt).toBe('2027-01-01');
		expect(
			tokensView({ accessToken: 'a', accessExpiresAt: 'e', refreshToken: 'r', session: { ...session, idleExpiresAt: null } })
				.refreshExpiresAt,
		).toBe('2027-01-01');
		expect(tokensView({ accessToken: 'a', accessExpiresAt: 'e', refreshToken: 'r', session }).refreshExpiresAt).toBe(
			'2026-11-01',
		);
		expect(challengeView({ id: 'x', channel: 'email', masked: 'm', expiresAt: 'e', resendAfter: 1 })).not.toHaveProperty(
			'codeLength',
		);
	});
	it('turns order events into summaries whatever order they arrive in', () => {
		expect(orderCustomerId({ customerId: 'a', customer: { customerId: 'b' } })).toBe('a');
		expect(orderCustomerId({ customer: { customerId: 'b', subject: 'c' } })).toBe('b');
		expect(orderCustomerId({ customer: { subject: 'c' } })).toBe('c');
		expect(orderCustomerId({ customer: 'x' })).toBeNull();
		const placed = orderUpdate({
			type: 'order.placed@1',
			occurredAt: 't1',
			data: { orderId: 'o', number: '7', currency: 'EUR', amounts: { total: 9 }, customerId: 'c' },
		});
		expect(placed).toEqual({
			orderId: 'o',
			status: 'placed',
			set: { placedAt: 't1', customerId: 'c', number: '7', currency: 'EUR', totalAmount: 9 },
		});
		expect(orderUpdate({ type: 'order.completed@1', occurredAt: 't2', data: { orderId: 'o' } })?.set).toEqual({
			completedAt: 't2',
		});
		expect(orderUpdate({ type: 'order.paid@1', occurredAt: 't', data: { orderId: 'o' } })).toBeNull();
		expect(orderUpdate({ type: 'order.placed@1', occurredAt: 't', data: /** @type {any} */ (null) })).toBeNull();
		expect(orderView({ orderId: 'o', completedAt: 't2', placedAt: 't1', updatedAt: new Date(T) })).toMatchObject({
			status: 'completed',
			placedAt: 't1',
			updatedAt: new Date(T).toISOString(),
			number: null,
		});
		expect(orderView({ orderId: 'o', refundedAt: 'x', completedAt: 'y', updatedAt: 'u' })).toMatchObject({
			status: 'refunded',
			updatedAt: 'u',
			placedAt: null,
		});
		expect(orderView({ orderId: 'o' }).status).toBe('placed');
	});
	it('validates request shapes', () => {
		expect(validateOtpRequest({ channel: 'email', to: 'a', purpose: 'link', locale: 'pt-BR', deviceId: 'abcdefgh' })).toEqual(
			[],
		);
		expect(
			validateOtpRequest({ channel: 'email', to: 'a', purpose: 'x', locale: 'EN', deviceId: 'short', extra: 1 }).map(
				(p) => p.path,
			),
		).toEqual(['/extra', '/purpose', '/deviceId', '/locale']);
		expect(validateOtpRequest(null)).toEqual([{ path: '', code: 'type' }]);
		expect(validateOtpVerify({ code: '1' })).toEqual([]);
		expect(validateOtpVerify({})).toEqual([{ path: '/code', code: 'required' }]);
		expect(validateOtpVerify('x')).toHaveLength(1);
		expect(validateMagicRequest({ email: 'a', redirect: 5, purpose: 'x' }).map((p) => p.path)).toEqual([
			'/redirect',
			'/purpose',
		]);
		expect(validateMagicRequest([])).toHaveLength(1);
		expect(validateMagicConsume({ token: 't' })).toEqual([]);
		expect(validateMagicConsume(1)).toHaveLength(1);
		expect(validateRefresh({ refreshToken: 'r' })).toEqual([]);
		expect(validateRefresh(undefined)).toHaveLength(1);
		expect(
			validateCustomerCreate({ email: 1, phone: 2, externalId: 'a b', verified: { email: 'y', other: true } }).map(
				(p) => p.path,
			),
		).toEqual(['/email', '/phone', '/externalId', '/verified/email', '/verified/other']);
		expect(validateCustomerCreate({ verified: 1 })).toEqual([{ path: '/verified', code: 'type' }]);
		expect(validateCustomerCreate(null)).toHaveLength(1);
		expect(validateCustomerAdminPatch({ status: 'blocked', externalId: null })).toEqual([]);
		expect(validateCustomerAdminPatch({ status: 'x', externalId: 3 }).map((p) => p.path)).toEqual(['/status', '/externalId']);
		expect(validateCustomerAdminPatch(null)).toHaveLength(1);
		expect(validateDataRequest({ type: 'export' })).toEqual([]);
		expect(validateDataRequest({ type: 'x', y: 1 })).toHaveLength(2);
		expect(validateDataRequest(0)).toHaveLength(1);
		expect(validateConsentAccept({ consents: [] })).toEqual([]);
		expect(validateConsentAccept({})).toHaveLength(1);
		expect(validateConsentAccept(null)).toHaveLength(1);
	});
	it('overlays entitlement values on schema defaults by type', () => {
		const schema = {
			properties: {
				i: { type: 'integer', default: 1 },
				n: { type: 'number', default: 1.5 },
				s: { type: 'string', default: 'a' },
				b: { type: 'boolean', default: true },
				a: { type: 'array', default: [] },
				o: { type: 'object', default: {} },
				x: { default: null },
			},
		};
		expect(effectiveConfig(schema, { i: 2.5, n: 'x', s: 3, b: 'y', a: {}, o: [], x: 7 })).toEqual({
			i: 1,
			n: 1.5,
			s: 'a',
			b: true,
			a: [],
			o: {},
			x: 7,
		});
		expect(effectiveConfig(schema, { i: 3, n: 2, s: 'b', b: false, a: [1], o: { k: 1 } })).toMatchObject({
			i: 3,
			n: 2,
			s: 'b',
			b: false,
			a: [1],
			o: { k: 1 },
		});
		expect(effectiveConfig({}, null)).toEqual({});
	});
});
