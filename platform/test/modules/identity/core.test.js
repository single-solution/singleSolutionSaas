import { describe, expect, it } from 'vitest';
import * as I from '../../../src/modules/identity/core/inputs.js';
import { linkFor } from '../../../src/modules/identity/core/links.js';
import { DEFAULT_SCOPES, checkScopes, scopeCatalogue } from '../../../src/modules/identity/core/scopes.js';
import {
	claimsMatch,
	expirySeconds,
	keyHint,
	keyStatus,
	presentKey,
	rotationRevokeAt,
} from '../../../src/modules/identity/core/keys.js';
import { COUNTRY_CODES, isCountryCode } from '../../../src/modules/identity/core/countries.js';
import { iso, presentAdmin, presentMerchant, presentWebsite } from '../../../src/modules/identity/core/present.js';
import {
	decodeRevocationCursor,
	encodeRevocationCursor,
	revocationFilter,
	revocationPage,
} from '../../../src/modules/identity/core/revocations.js';
import { hashToken, newToken, SETUP_TTL_MS, TOKEN_TTL_MS } from '../../../src/modules/identity/core/tokens.js';

const WEB = 'web_0123456789abcdefghjkmnpq';

describe('inputs: fields', () => {
	it('email', () => {
		expect(I.email('  A.B+c@Example.COM ')).toEqual({ ok: true, value: 'a.b+c@example.com' });
		for (const bad of ['', 'a', 'a@b', '@b.c', 'a b@c.d', 'a@b@c.d', 1, null, `${'x'.repeat(250)}@b.cd`])
			expect(I.email(bad).ok).toBe(false);
	});
	it('passwords', () => {
		expect(I.newPassword('x'.repeat(12)).ok).toBe(true);
		expect(I.newPassword('x'.repeat(11)).ok).toBe(false);
		expect(I.newPassword(' '.repeat(12)).ok).toBe(false);
		expect(I.newPassword(5).ok).toBe(false);
		expect(I.newPassword('x'.repeat(1025)).ok).toBe(false);
		expect(I.password('a')).toEqual({ ok: true, value: 'a' });
		expect(I.password('').ok).toBe(false);
		expect(I.password(undefined).ok).toBe(false);
	});
	it('text, ids, tokens, codes, booleans', () => {
		expect(I.text(5)('  abc ')).toEqual({ ok: true, value: 'abc' });
		expect(I.text(2)('abc').ok).toBe(false);
		expect(I.text(5)('').ok).toBe(false);
		expect(I.text(5)(3).ok).toBe(false);
		expect(I.text(5)('a\u0007b').ok).toBe(false);
		expect(I.text(5)('a\u007fb').ok).toBe(false);
		expect(I.idOf('mer')('mer_0123456789').ok).toBe(true);
		expect(I.idOf('mer')('web_0123456789').ok).toBe(false);
		expect(I.idOf('mer')('mer_x').ok).toBe(false);
		expect(I.token('a'.repeat(43)).ok).toBe(true);
		expect(I.token('a+b').ok).toBe(false);
		expect(I.otp(' 123456 ')).toEqual({ ok: true, value: '123456' });
		expect(I.otp('12345').ok).toBe(false);
		expect(I.otp(123456).ok).toBe(false);
		expect(I.recoveryCode('ABCDE-FGHIJ')).toEqual({ ok: true, value: 'abcde-fghij' });
		expect(I.recoveryCode('abcdefghij').ok).toBe(true);
		expect(I.recoveryCode('abc').ok).toBe(false);
		expect(I.recoveryCode(1).ok).toBe(false);
		expect(I.bool(true).ok).toBe(true);
		expect(I.bool('true').ok).toBe(false);
	});
	it('countries (ISO 3166-1 alpha-2) and optional texts', () => {
		expect(COUNTRY_CODES).toHaveLength(249);
		expect(isCountryCode('PK')).toBe(true);
		expect(isCountryCode('UK')).toBe(false);
		expect(I.country(' pk ')).toEqual({ ok: true, value: 'PK' });
		expect(I.country('XX').ok).toBe(false);
		expect(I.country(5).ok).toBe(false);
		expect(I.optionalText(5)('')).toEqual({ ok: true, value: null });
		expect(I.optionalText(5)(null)).toEqual({ ok: true, value: null });
		expect(I.optionalText(5)(' ab ')).toEqual({ ok: true, value: 'ab' });
		expect(I.optionalText(2)('abc').ok).toBe(false);
	});
	it('scopes, domains, timestamps, ints, enums', () => {
		expect(I.scopes(['events.publish', 'config.*', 'events.subscribe:order.*@1']).ok).toBe(true);
		expect(I.scopes([]).ok).toBe(true); // empty = the default scopes (checked on issue)
		expect(I.scopes(Array(33).fill('a')).ok).toBe(false);
		expect(I.scopes(['Bad Scope']).ok).toBe(false);
		expect(I.scopes(['a', 'a']).ok).toBe(false);
		expect(I.scopes('a').ok).toBe(false);
		expect(I.domain()('https://WWW.Example.com:8080/x')).toEqual({ ok: true, value: 'www.example.com' });
		expect(I.domain()('10.0.0.1').ok).toBe(false);
		expect(I.domain({ isPublicSuffix: (d) => d === 'github.io' })('github.io').ok).toBe(false);
		expect(I.timestamp('2026-10-01T10:00:00Z')).toEqual({ ok: true, value: Date.parse('2026-10-01T10:00:00Z') });
		expect(I.timestamp('2026-10-01T10:00+02:00').ok).toBe(true);
		expect(I.timestamp('2026-10-01').ok).toBe(false);
		expect(I.timestamp('2026-13-45T99:99:99Z').ok).toBe(false);
		expect(I.timestamp(1).ok).toBe(false);
		expect(I.int(0, 10)(10).ok).toBe(true);
		expect(I.int(0, 10)(11).ok).toBe(false);
		expect(I.int(0, 10)(1.5).ok).toBe(false);
		expect(I.oneOf(['a', 'b'])('b').ok).toBe(true);
		expect(I.oneOf(['a', 'b'])('c').ok).toBe(false);
	});
});

describe('inputs: objects', () => {
	it('closed objects with required and optional members', () => {
		expect(I.object(null, {})).toEqual({ ok: false, errors: [{ path: '', message: 'body must be a JSON object' }] });
		expect(I.object([], {}).ok).toBe(false);
		const parsed = I.object({ a: 'x', z: 1 }, { a: I.text(5), b: I.text(5), c: { optional: I.text(5) } });
		expect(parsed).toEqual({
			ok: false,
			errors: [
				{ path: '/z', message: 'unknown property' },
				{ path: '/b', message: 'is required' },
			],
		});
		expect(I.object({ a: 'x', c: 'y' }, { a: I.text(5), c: { optional: I.text(5) } })).toEqual({
			ok: true,
			value: { a: 'x', c: 'y' },
		});
		expect(I.object({ a: 3 }, { a: I.text(5) })).toEqual({ ok: false, errors: [{ path: '/a', message: 'must be a string' }] });
	});
	it('second factors need exactly one of code or recoveryCode', () => {
		expect(I.secondFactor({ code: '123456' })).toEqual({ ok: true, value: { code: '123456' } });
		expect(I.secondFactor({ recoveryCode: 'abcde-fghij' }).ok).toBe(true);
		expect(I.secondFactor({}).ok).toBe(false);
		expect(I.secondFactor({ code: '123456', recoveryCode: 'abcde-fghij' }).ok).toBe(false);
		expect(I.secondFactor({ code: 'x' }).ok).toBe(false);
	});
	it('every operation parser', () => {
		const token = 'a'.repeat(43);
		const merchant = { name: 'M', ownerName: 'O', email: 'a@b.co' };
		const ok = /** @type {Array<[keyof typeof I.inputs, unknown]>} */ ([
			['signIn', { email: 'a@b.co', password: 'p' }],
			['twoStepSignIn', { challenge: token, code: '123456' }],
			['firstAdmin', { name: 'N', email: 'a@b.co', password: 'x'.repeat(12) }],
			['tokenOnly', { token }],
			['emailOnly', { email: 'a@b.co' }],
			['resetConfirm', { token, password: 'x'.repeat(12) }],
			['setupConfirm', { token, password: 'x'.repeat(12), name: 'N' }],
			['passwordChange', { currentPassword: 'p', newPassword: 'x'.repeat(12), code: '123456' }],
			['emailChange', { email: 'a@b.co', password: 'p', recoveryCode: 'abcde-fghij' }],
			['twoStepConfirm', { code: '123456' }],
			['twoStepWithPassword', { password: 'p', code: '123456' }],
			['adminProfile', { name: 'N' }],
			['merchantProfile', { phone: '' }],
			['merchantCreate', { ...merchant, country: 'PK' }],
			['merchantUpdate', { email: 'b@b.co' }],
			['merchantDelete', { confirm: 'M' }],
			['bulk', { action: 'suspend', merchantIds: ['mer_0123456789'], reason: 'r' }],
			['linkAction', undefined],
			['website', { domain: 'a.example' }],
			['websiteRemove', { confirm: 'a.example' }],
			['keyIssue', { kind: 'sk', scopes: ['events.write'], expiresAt: '2030-01-01T00:00:00Z', allowSubdomains: false }],
			['keyRotate', undefined],
			['keyRevoke', undefined],
			['reason', { reason: 'r' }],
			['adminInvite', { email: 'a@b.co', role: 'finance', copy: true }],
			['adminUpdate', { role: 'owner' }],
		]);
		for (const [name, body] of ok) expect(/** @type {any} */ (I.inputs[name])(body).ok, name).toBe(true);
		for (const name of /** @type {Array<keyof typeof I.inputs>} */ (Object.keys(I.inputs)))
			expect(/** @type {any} */ (I.inputs[name])({ unexpected: true }).ok, name).toBe(false);
		expect(I.inputs.keyRotate({ graceSeconds: I.MAX_GRACE_SECONDS + 1 }).ok).toBe(false);
		expect(I.inputs.merchantCreate(merchant)).toEqual({
			ok: true,
			value: { ...merchant, phone: null, address: null, country: null },
		});
		expect(I.inputs.merchantProfile({}).ok).toBe(false);
		expect(I.inputs.adminUpdate({}).ok).toBe(false);
		expect(I.inputs.adminInvite({ email: 'a@b.co', role: 'superadmin' }).ok).toBe(false);
		expect(I.inputs.bulk({ action: 'suspend', merchantIds: [] }).ok).toBe(false);
		expect(I.inputs.bulk({ action: 'suspend', merchantIds: ['nope'] }).ok).toBe(false);
		expect(I.inputs.bulk({ action: 'resume', merchantIds: ['mer_0123456789', 'mer_0123456789'] })).toEqual({
			ok: true,
			value: { action: 'resume', merchantIds: ['mer_0123456789'] },
		});
	});
});

describe('tokens and links', () => {
	it('mints 256-bit tokens and purpose-bound HMACs', () => {
		const t = newToken(() => new Uint8Array(32).fill(1));
		expect(t).toHaveLength(43);
		const secret = Buffer.alloc(32, 9);
		expect(hashToken(secret, 'setup', t)).toMatch(/^[0-9a-f]{64}$/);
		expect(hashToken(secret, 'setup', t)).not.toBe(hashToken(secret, 'password_reset', t));
		expect(hashToken(secret, 'setup', t)).not.toBe(hashToken(Buffer.alloc(32, 8), 'setup', t));
		expect(() => hashToken(secret, /** @type {any} */ ('invite'), t)).toThrow(/purpose/);
		expect(TOKEN_TTL_MS.password_reset).toBe(30 * 60_000);
		expect(SETUP_TTL_MS).toEqual({ merchant: 72 * 3_600_000, admin: 24 * 3_600_000 });
	});
	it('puts tokens in the fragment', () => {
		expect(linkFor('https://p.test/', 'setup', 'a b')).toBe('https://p.test/set-password#token=a%20b');
		expect(linkFor('https://p.test', 'password_reset', 't')).toBe('https://p.test/reset-password#token=t');
		expect(linkFor('https://p.test', 'email_change', 't')).toBe('https://p.test/confirm-email#token=t');
	});
});

describe('revocation cursors', () => {
	it('encodes and decodes', () => {
		expect(decodeRevocationCursor(undefined)).toEqual({ ok: true, value: { t: 0, k: '' } });
		expect(decodeRevocationCursor('')).toEqual({ ok: true, value: { t: 0, k: '' } });
		expect(decodeRevocationCursor(null)).toEqual({ ok: true, value: { t: 0, k: '' } });
		const c = encodeRevocationCursor({ t: 5, k: 'key_a' });
		expect(decodeRevocationCursor(c)).toEqual({ ok: true, value: { t: 5, k: 'key_a' } });
		expect(decodeRevocationCursor('2026-10-01T00:00:00Z')).toEqual({
			ok: true,
			value: { t: Date.parse('2026-10-01T00:00:00Z'), k: '' },
		});
		expect(decodeRevocationCursor('2026-99-99T00:00:00Z').ok).toBe(false);
		expect(decodeRevocationCursor('***').ok).toBe(false);
		expect(decodeRevocationCursor(42).ok).toBe(false);
		expect(decodeRevocationCursor('x'.repeat(300)).ok).toBe(false);
		expect(decodeRevocationCursor(Buffer.from('nope').toString('base64url')).ok).toBe(false);
		expect(decodeRevocationCursor(Buffer.from('{"t":-1,"k":""}').toString('base64url')).ok).toBe(false);
		expect(decodeRevocationCursor(Buffer.from('{"t":1,"k":3}').toString('base64url')).ok).toBe(false);
		expect(decodeRevocationCursor(Buffer.from('null').toString('base64url')).ok).toBe(false);
	});
	it('builds filters and pages without skipping', () => {
		const filter = revocationFilter({ t: 10, k: 'b' }, 100);
		expect(filter).toEqual({
			revokeAt: { $ne: null, $lte: new Date(100) },
			$or: [{ revokeAt: { $gt: new Date(10) } }, { revokeAt: new Date(10), _id: { $gt: 'b' } }],
		});
		const rows = [
			{ _id: 'a', revokeAt: new Date(20) },
			{ _id: 'b', revokeAt: new Date(30) },
			{ _id: 'c', revokeAt: new Date(30) },
		];
		const full = revocationPage(rows, { t: 0, k: '' }, 1000, { limit: 2, lagMs: 50 });
		expect(full.keyIds).toEqual(['a', 'b']);
		expect(decodeRevocationCursor(full.cursor)).toEqual({ ok: true, value: { t: 30, k: 'b' } });
		const partial = revocationPage(rows, { t: 0, k: '' }, 1000, { limit: 5, lagMs: 50 });
		expect(partial.keyIds).toEqual(['a', 'b', 'c']);
		expect(decodeRevocationCursor(partial.cursor)).toEqual({ ok: true, value: { t: 950, k: '' } });
		const recent = revocationPage([], { t: 990, k: 'z' }, 1000, { lagMs: 50 });
		expect(decodeRevocationCursor(recent.cursor)).toEqual({ ok: true, value: { t: 990, k: 'z' } });
		expect(revocationPage([], { t: 0, k: '' }, 1000).keyIds).toEqual([]);
	});
});

describe('key rules', () => {
	const base = {
		_id: 'key_1',
		merchantId: 'mer_1',
		websiteId: WEB,
		kind: /** @type {const} */ ('sk'),
		env: /** @type {const} */ ('live'),
		scopes: ['events.write'],
		allowSubdomains: false,
		kid: 'k',
		hint: 'sk_live_…abcdef',
		secretHash: 'h',
		expiresAt: null,
		revokeAt: null,
		revokeReason: null,
		replacedBy: null,
		rotatedFrom: null,
		createdAt: new Date(0),
	};
	it('status', () => {
		expect(keyStatus(base, 10)).toBe('active');
		expect(keyStatus({ ...base, revokeAt: new Date(20) }, 10)).toBe('revoking');
		expect(keyStatus({ ...base, revokeAt: new Date(10) }, 10)).toBe('revoked');
		expect(keyStatus({ ...base, expiresAt: new Date(5) }, 10)).toBe('expired');
		expect(keyStatus({ ...base, expiresAt: new Date(5), revokeAt: new Date(1) }, 10)).toBe('revoked');
	});
	it('presentation never leaks hashes', () => {
		const shown = presentKey({ ...base, expiresAt: new Date(50), revokeAt: new Date(40) }, 10);
		expect(shown).toMatchObject({
			keyId: 'key_1',
			status: 'revoking',
			expiresAt: new Date(50).toISOString(),
			revokeAt: new Date(40).toISOString(),
		});
		expect(JSON.stringify(shown)).not.toContain('secretHash');
		expect(
			presentKey(/** @type {any} */ ({ ...base, revokeReason: undefined, replacedBy: undefined, rotatedFrom: undefined }), 0),
		).toMatchObject({
			revokeReason: null,
			replacedBy: null,
			rotatedFrom: null,
		});
	});
	it('hint, binding, rotation and expiry', () => {
		expect(keyHint('sk_live_abcdefghijklmnop')).toBe('sk_live_…klmnop');
		const claims = { websiteId: WEB, merchantId: 'mer_1', kind: 'sk', env: 'live' };
		expect(claimsMatch(base, claims)).toBe(true);
		expect(claimsMatch(null, claims)).toBe(false);
		expect(claimsMatch(base, { ...claims, merchantId: 'mer_2' })).toBe(false);
		expect(claimsMatch(base, { ...claims, kind: 'pk' })).toBe(false);
		expect(claimsMatch(base, { ...claims, env: 'test' })).toBe(false);
		expect(claimsMatch(base, { ...claims, websiteId: 'web_x' })).toBe(false);
		expect(rotationRevokeAt(1000, 2)).toEqual(new Date(3000));
		expect(expirySeconds(undefined, 0)).toEqual({ ok: true, value: undefined });
		expect(expirySeconds(120_000, 0)).toEqual({ ok: true, value: 120 });
		expect(expirySeconds(30_000, 0).ok).toBe(false);
	});
});

describe('presentation', () => {
	it('shapes records without secrets; the suspension reason only for admins', () => {
		const at = new Date(0);
		expect(iso(null)).toBeNull();
		expect(iso(at)).toBe(at.toISOString());
		const merchant = {
			_id: 'mer_1',
			name: 'M',
			email: 'e@x.co',
			status: 'suspended',
			suspension: { reason: 'r', at, by: 'adm_1' },
			passwordHash: 'scrypt$x',
			totp: { secret: 'sealed' },
			recoveryHashes: ['h'],
			createdAt: at,
		};
		expect(presentMerchant(merchant)).toMatchObject({
			ownerName: null,
			setupPending: false,
			twoStep: { enabled: true, recoveryCodesLeft: 1 },
			suspension: { reason: 'r', at: at.toISOString(), by: 'adm_1' },
		});
		expect(presentMerchant(merchant, { forAdmin: false })).not.toHaveProperty('suspension');
		expect(JSON.stringify(presentMerchant(merchant))).not.toMatch(/scrypt|sealed/);
		expect(presentMerchant({ _id: 'mer_2', name: 'N', status: 'active' })).toMatchObject({
			setupPending: true,
			suspension: null,
		});
		expect(presentMerchant({ _id: 'mer_3', name: 'D', status: 'deleted' }).setupPending).toBe(false);
		expect(
			presentWebsite({ _id: WEB, merchantId: 'mer_1', domain: 'd', env: 'live', twinId: 'web_2', status: 'active' }),
		).toMatchObject({ deletedAt: null });
		const admin = presentAdmin({
			_id: 'adm_1',
			email: 'e',
			role: 'owner',
			status: 'active',
			passwordHash: 'x',
			totp: { secret: 's' },
		});
		expect(admin).toMatchObject({ name: null, twoStep: { enabled: true, recoveryCodesLeft: 0 }, lastSignInAt: null });
		expect(JSON.stringify(admin)).not.toContain('passwordHash');
	});
});

describe('website settings and the key scope vocabulary (F.16)', () => {
	it('validates time zones (Intl), BCP 47 languages and ISO 4217 currencies, canonicalised', () => {
		expect(I.timeZone('Europe/Berlin')).toEqual({ ok: true, value: 'Europe/Berlin' });
		expect(I.timeZone('UTC')).toMatchObject({ ok: true });
		expect(I.timeZone('Mars/Olympus').ok).toBe(false);
		expect(I.timeZone('+01:00').ok).toBe(false);
		expect(I.language('en-us')).toEqual({ ok: true, value: 'en-US' });
		expect(I.language('de-CH')).toMatchObject({ ok: true });
		expect(I.language('not a tag').ok).toBe(false);
		expect(I.language('x'.repeat(40)).ok).toBe(false);
		expect(I.currency('eur')).toEqual({ ok: true, value: 'EUR' });
		expect(I.currency('EURO').ok).toBe(false);
		expect(I.currency('ZZZ').ok).toBe(false);
		expect(I.inputs.websiteSettings({ timeZone: 'Europe/Paris', currency: null })).toEqual({
			ok: true,
			value: { timeZone: 'Europe/Paris', currency: null },
		});
		expect(I.inputs.websiteSettings({}).ok).toBe(false);
		expect(I.inputs.websiteSettings({ locale: 'en' }).ok).toBe(false);
	});

	it('builds the scope catalogue from products and checks requested scopes', () => {
		const catalogue = scopeCatalogue([
			{ slug: 'reviews', name: 'Reviews' },
			{ slug: 'events', name: 'Clash' },
			{ slug: 'chatbot' },
		]);
		expect(catalogue.map((e) => e.scope)).toEqual([
			'elements.read',
			'events.write',
			'chatbot.read',
			'chatbot.write',
			'reviews.read',
			'reviews.write',
		]);
		expect(checkScopes([], catalogue)).toEqual({ ok: true, value: [...DEFAULT_SCOPES] });
		expect(checkScopes(['reviews.write', 'events.*', 'chatbot.*'], catalogue)).toMatchObject({ ok: true });
		expect(checkScopes(['reviews.delete', 'graph.*', 'elements.read'], catalogue)).toEqual({
			ok: false,
			errors: [
				{ path: '/scopes/0', message: 'reviews.delete is not a website-key scope' },
				{ path: '/scopes/1', message: 'graph.* is not a website-key scope' },
			],
		});
	});
});
