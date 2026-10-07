import { describe, expect, it } from 'vitest';
import * as I from '../../../src/modules/identity/core/inputs.js';
import { linkFor } from '../../../src/modules/identity/core/links.js';
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
	it('domains, nullable fields, enums', () => {
		expect(I.domain()('https://WWW.Example.com:8080/x')).toEqual({ ok: true, value: 'www.example.com' });
		expect(I.domain()('10.0.0.1').ok).toBe(false);
		expect(I.domain({ isPublicSuffix: (d) => d === 'github.io' })('github.io').ok).toBe(false);
		expect(I.nullable(I.country)(null)).toEqual({ ok: true, value: null });
		expect(I.nullable(I.country)('pk')).toEqual({ ok: true, value: 'PK' });
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
			['tokenRegenerate', { kind: 'server' }],
			['reason', { reason: 'r' }],
			['adminInvite', { email: 'a@b.co', role: 'finance', copy: true }],
			['adminUpdate', { role: 'owner' }],
		]);
		for (const [name, body] of ok) expect(/** @type {any} */ (I.inputs[name])(body).ok, name).toBe(true);
		for (const name of /** @type {Array<keyof typeof I.inputs>} */ (Object.keys(I.inputs)))
			expect(/** @type {any} */ (I.inputs[name])({ unexpected: true }).ok, name).toBe(false);
		expect(I.inputs.tokenRegenerate({ kind: 'secret' }).ok).toBe(false);
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
		const filter = revocationFilter('notes', { t: 10, k: 'b' });
		expect(filter).toEqual({
			productId: 'notes',
			$or: [{ revokedAt: { $gt: new Date(10) } }, { revokedAt: new Date(10), _id: { $gt: 'b' } }],
		});
		const rows = [
			{ _id: 'a', revokedAt: new Date(20) },
			{ _id: 'b', revokedAt: new Date(30) },
			{ _id: 'c', revokedAt: new Date(30) },
		];
		const full = revocationPage(rows, { t: 0, k: '' }, 1000, { limit: 2, lagMs: 50 });
		expect(full.tokenIds).toEqual(['a', 'b']);
		expect(decodeRevocationCursor(full.cursor)).toEqual({ ok: true, value: { t: 30, k: 'b' } });
		const partial = revocationPage(rows, { t: 0, k: '' }, 1000, { limit: 5, lagMs: 50 });
		expect(partial.tokenIds).toEqual(['a', 'b', 'c']);
		expect(decodeRevocationCursor(partial.cursor)).toEqual({ ok: true, value: { t: 950, k: '' } });
		const recent = revocationPage([], { t: 990, k: 'z' }, 1000, { lagMs: 50 });
		expect(decodeRevocationCursor(recent.cursor)).toEqual({ ok: true, value: { t: 990, k: 'z' } });
		expect(revocationPage([], { t: 0, k: '' }, 1000).tokenIds).toEqual([]);
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
		expect(presentWebsite({ _id: WEB, merchantId: 'mer_1', domain: 'd', status: 'active' })).toEqual({
			websiteId: WEB,
			merchantId: 'mer_1',
			domain: 'd',
			status: 'active',
			createdAt: null,
			removedAt: null,
		});
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
