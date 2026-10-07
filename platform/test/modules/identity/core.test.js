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
import {
	iso,
	presentInvite,
	presentMember,
	presentMerchant,
	presentStaff,
	presentUser,
	presentWebsite,
} from '../../../src/modules/identity/core/present.js';
import {
	decodeRevocationCursor,
	encodeRevocationCursor,
	revocationFilter,
	revocationPage,
} from '../../../src/modules/identity/core/revocations.js';
import {
	applyMemberChange,
	checkOwnerTransfer,
	grantsSomething,
	isOwner,
	statusTransition,
	unknownGrantWebsites,
} from '../../../src/modules/identity/core/team.js';
import { hashToken, newToken, TOKEN_TTL_MS } from '../../../src/modules/identity/core/tokens.js';

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
	it('roles and grants', () => {
		const merchant = I.roles(I.ASSIGNABLE_MERCHANT_ROLES);
		expect(merchant(['admin', 'editor'])).toEqual({ ok: true, value: ['admin', 'editor'] });
		expect(merchant([]).ok).toBe(false);
		expect(I.roles(I.ASSIGNABLE_MERCHANT_ROLES, { allowEmpty: true })([]).ok).toBe(true);
		expect(merchant(['owner']).ok).toBe(false);
		expect(merchant(['admin', 'admin']).ok).toBe(false);
		expect(merchant('admin').ok).toBe(false);
		expect(merchant([1]).ok).toBe(false);
		expect(I.grants([{ websiteId: WEB, roles: ['editor'] }])).toEqual({
			ok: true,
			value: [{ websiteId: WEB, roles: ['editor'] }],
		});
		expect(I.grants([]).ok).toBe(true);
		expect(I.grants('x').ok).toBe(false);
		expect(I.grants(Array(101).fill({ websiteId: WEB, roles: ['editor'] })).ok).toBe(false);
		expect(I.grants([null]).ok).toBe(false);
		expect(I.grants([[]]).ok).toBe(false);
		expect(I.grants([{ websiteId: WEB, roles: ['editor'], extra: 1 }]).ok).toBe(false);
		expect(I.grants([{ websiteId: 'nope', roles: ['editor'] }])).toMatchObject({
			ok: false,
			message: expect.stringMatching(/^websiteId/),
		});
		expect(I.grants([{ websiteId: WEB, roles: [] }]).ok).toBe(false);
		expect(
			I.grants([
				{ websiteId: WEB, roles: ['editor'] },
				{ websiteId: WEB, roles: ['admin'] },
			]).ok,
		).toBe(false);
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
		const ok = /** @type {Array<[keyof typeof I.inputs, unknown]>} */ ([
			['signup', { email: 'a@b.co', password: 'x'.repeat(12), merchantName: 'M', name: 'N' }],
			['login', { email: 'a@b.co', password: 'p', merchantId: 'mer_0123456789' }],
			['staffLogin', { email: 'a@b.co', password: 'p' }],
			['tokenOnly', { token }],
			['emailOnly', { email: 'a@b.co' }],
			['resetConfirm', { token, password: 'x'.repeat(12) }],
			['inviteAccept', { token, password: 'p', name: 'N' }],
			['passwordChange', { currentPassword: 'p', newPassword: 'x'.repeat(12) }],
			['mfaChallenge', { challenge: token, code: '123456' }],
			['mfaCode', { recoveryCode: 'abcde-fghij' }],
			['mfaConfirm', { code: '123456' }],
			['mfaDisable', { password: 'p', code: '123456' }],
			['switchMerchant', { merchantId: 'mer_0123456789' }],
			['merchantUpdate', { name: 'N' }],
			['invite', { email: 'a@b.co', roles: [], grants: [{ websiteId: WEB, roles: ['editor'] }] }],
			['memberUpdate', { roles: ['admin'] }],
			['ownerTransfer', { userId: 'usr_0123456789', password: 'p' }],
			['website', { domain: 'a.example' }],
			['keyIssue', { kind: 'sk', scopes: ['events.write'], expiresAt: '2030-01-01T00:00:00Z', allowSubdomains: false }],
			['keyRotate', undefined],
			['keyRevoke', undefined],
			['reason', { reason: 'r' }],
			['websiteTransfer', { toMerchantId: 'mer_0123456789', reason: 'r' }],
			['staffCreate', { email: 'a@b.co', roles: ['support'], name: 'N' }],
			['staffUpdate', { status: 'disabled' }],
		]);
		for (const [name, body] of ok) expect(/** @type {any} */ (I.inputs[name])(body).ok, name).toBe(true);
		for (const name of /** @type {Array<keyof typeof I.inputs>} */ (Object.keys(I.inputs)))
			expect(/** @type {any} */ (I.inputs[name])({ unexpected: true }).ok, name).toBe(false);
		expect(I.inputs.keyRotate({ graceSeconds: I.MAX_GRACE_SECONDS + 1 }).ok).toBe(false);
	});
});

describe('tokens and links', () => {
	it('mints 256-bit tokens and purpose-bound HMACs', () => {
		const t = newToken(() => new Uint8Array(32).fill(1));
		expect(t).toHaveLength(43);
		const secret = Buffer.alloc(32, 9);
		expect(hashToken(secret, 'signup', t)).toMatch(/^[0-9a-f]{64}$/);
		expect(hashToken(secret, 'signup', t)).not.toBe(hashToken(secret, 'invite', t));
		expect(hashToken(secret, 'signup', t)).not.toBe(hashToken(Buffer.alloc(32, 8), 'signup', t));
		expect(() => hashToken(secret, /** @type {any} */ ('other'), t)).toThrow(/purpose/);
		expect(TOKEN_TTL_MS.password_reset).toBe(30 * 60_000);
	});
	it('puts tokens in the fragment', () => {
		expect(linkFor('https://p.test/', 'invite', 'a b')).toBe('https://p.test/invites/accept#token=a%20b');
		expect(linkFor('https://p.test', 'staff_password_reset', 't')).toBe('https://p.test/staff/reset-password#token=t');
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

describe('team rules', () => {
	const member = { userId: 'usr_1', roles: ['editor'], grants: [] };
	it('owner protection and non-empty memberships', () => {
		expect(isOwner({ roles: ['owner'] })).toBe(true);
		expect(grantsSomething([], [])).toBe(false);
		expect(grantsSomething([], [{ websiteId: WEB, roles: ['editor'] }])).toBe(true);
		expect(applyMemberChange({ ...member, roles: ['owner'] }, { roles: ['admin'] })).toMatchObject({
			ok: false,
			code: 'owner_protected',
		});
		expect(applyMemberChange(member, { roles: [] })).toMatchObject({ ok: false, code: 'validation_failed' });
		expect(applyMemberChange(member, { grants: [{ websiteId: WEB, roles: ['admin'] }] })).toEqual({
			ok: true,
			roles: ['editor'],
			grants: [{ websiteId: WEB, roles: ['admin'] }],
		});
		expect(applyMemberChange(member, {})).toEqual({ ok: true, roles: ['editor'], grants: [] });
	});
	it('grants, ownership transfer and status transitions', () => {
		expect(
			unknownGrantWebsites(
				[
					{ websiteId: 'a', roles: [] },
					{ websiteId: 'b', roles: [] },
				],
				new Set(['a']),
			),
		).toEqual(['b']);
		expect(checkOwnerTransfer(null, 'usr_1')).toMatchObject({ ok: false, code: 'not_found' });
		expect(checkOwnerTransfer(member, 'usr_1')).toMatchObject({ ok: false, code: 'conflict' });
		expect(checkOwnerTransfer(member, 'usr_2')).toEqual({ ok: true });
		expect(statusTransition('active', 'suspended')).toBe(true);
		expect(statusTransition('active', 'active')).toBe(false);
	});
});

describe('presentation', () => {
	it('shapes records without secrets', () => {
		const at = new Date(0);
		expect(iso(null)).toBeNull();
		expect(iso(at)).toBe(at.toISOString());
		expect(presentMerchant({ _id: 'mer_1', name: 'M', status: 'active', createdAt: at })).toMatchObject({
			ownerUserId: null,
			suspension: null,
		});
		expect(
			presentMerchant({ _id: 'mer_1', name: 'M', status: 'suspended', suspension: { reason: 'r', at, by: 's' } }).suspension,
		).toEqual({
			reason: 'r',
			at: at.toISOString(),
			by: 's',
		});
		expect(
			presentWebsite({ _id: WEB, merchantId: 'mer_1', domain: 'd', env: 'live', twinId: 'web_2', status: 'active' }),
		).toMatchObject({
			deletedAt: null,
		});
		const user = presentUser({
			_id: 'usr_1',
			email: 'e',
			status: 'active',
			passwordHash: 'scrypt$x',
			totp: { secret: 'sealed' },
			recoveryHashes: ['h'],
		});
		expect(user).toMatchObject({ name: null, mfa: { enabled: true, recoveryCodesLeft: 1 } });
		expect(JSON.stringify(user)).not.toMatch(/scrypt|sealed/);
		expect(presentUser({ _id: 'usr_1', email: 'e', status: 'active', totp: { secret: 's' } }).mfa.recoveryCodesLeft).toBe(0);
		expect(presentStaff({ _id: 'stf_1', email: 'e', status: 'active', passwordHash: 'x' })).toMatchObject({
			roles: [],
			passwordSet: true,
		});
		expect(presentMember({ userId: 'usr_1' }, null)).toMatchObject({ email: null, roles: [], grants: [], status: 'unknown' });
		expect(presentInvite({ _id: 'inv_1', email: 'e', status: 'pending' })).toMatchObject({ roles: [], grants: [] });
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
