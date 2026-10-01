import { describe, expect, it } from 'vitest';
import {
	DOCUMENT_RULES,
	RUNTIME_STATES,
	checkEntitlementDocument,
	isLanguageTag,
	validateEntitlementDocument,
} from '../src/index.js';
import { entitlement } from '../src/testing.js';
import { expectProblem, expectRule } from './helpers.js';

describe('entitlement document', () => {
	it('accepts a valid document (with and without planCode)', () => {
		expect(validateEntitlementDocument(entitlement()).ok).toBe(true);
		const doc = entitlement();
		delete doc.planCode;
		expect(validateEntitlementDocument(doc).ok).toBe(true);
	});

	it.each(RUNTIME_STATES.filter((state) => state !== 'active'))('requires a reason for runtime state %s', (state) => {
		const doc = entitlement();
		doc.runtime = { state };
		expectProblem(validateEntitlementDocument(doc), '/runtime/reason', 'required');
		doc.runtime.reason = 'balance_zero';
		expect(validateEntitlementDocument(doc).ok).toBe(true);
	});

	/** @type {Array<[string, (d: any) => unknown, string, string]>} */
	const invalid = [
		['bad website id', (d) => (d.websiteId = 'site_1'), '/websiteId', 'pattern'],
		['uppercase domain', (d) => (d.domain = 'Shop.Example.com'), '/domain', 'pattern'],
		['IP domain', (d) => (d.domain = '10.0.0.1'), '/domain', 'pattern'],
		['unknown env', (d) => (d.env = 'staging'), '/env', 'enum'],
		['zero version', (d) => (d.version = 0), '/version', 'minimum'],
		['fractional version', (d) => (d.version = 1.5), '/version', 'type'],
		['non-UTC issuedAt', (d) => (d.issuedAt = '2026-10-01T10:00:00+01:00'), '/issuedAt', 'pattern'],
		['element without enabled', (d) => (d.elements.codes = {}), '/elements/codes/enabled', 'required'],
		['bad feature source', (d) => (d.features['codes.maxActive'].source = 'guess'), '/features/codes.maxActive/source', 'enum'],
		[
			'bad feature key',
			(d) => (d.features.maxActive = { value: 1, source: 'runtime', locked: false }),
			'/features/maxActive',
			'propertyNames',
		],
		['secret in resource', (d) => (d.resources[0].ref = 'mongodb+srv://user:pass@cluster/db'), '/resources/0/ref', 'pattern'],
		[
			'extra resource member',
			(d) => (d.resources[0].connectionString = 'x'),
			'/resources/0/connectionString',
			'additionalProperties',
		],
		['bad data prefix', (d) => (d.dataScope.prefix = 'SS-'), '/dataScope/prefix', 'pattern'],
		['unknown runtime state', (d) => (d.runtime.state = 'broken'), '/runtime/state', 'enum'],
		['missing experiments', (d) => delete d.experiments, '/experiments', 'required'],
		['missing validFrom', (d) => delete d.validFrom, '/validFrom', 'required'],
	];
	it.each(invalid)('rejects %s', (_name, mutate, path, keyword) => {
		const doc = entitlement();
		mutate(doc);
		expectProblem(validateEntitlementDocument(doc), path, keyword);
	});

	it('applies semantic checks', () => {
		/** @param {(d: any) => void} mutate */
		const check = (mutate) => {
			const doc = entitlement();
			mutate(doc);
			return checkEntitlementDocument(doc);
		};
		expect(check(() => {})).toEqual([]);
		expectRule(
			check((d) => (d.validUntil = d.issuedAt)),
			DOCUMENT_RULES.validityWindow,
			'/validUntil',
		);
		expectRule(
			check((d) => (d.validFrom = '2026-10-01T11:00:00Z')),
			DOCUMENT_RULES.validityWindow,
			'/validUntil',
		);
		expectRule(
			check((d) => (d.validFrom = '2026-04-31T00:00:00Z')),
			DOCUMENT_RULES.validityWindow,
			'/validFrom',
		);
		expectRule(
			check((d) => (d.validUntil = '2026-02-30T00:00:00Z')),
			DOCUMENT_RULES.validityWindow,
			'/validUntil',
		);
		expectRule(
			check((d) => (d.issuedAt = '2026-02-30T00:00:00Z')),
			DOCUMENT_RULES.validityWindow,
			'/issuedAt',
		);
		expectRule(
			check((d) => (d.features['ghost.x'] = { value: 1, source: 'runtime', locked: false })),
			DOCUMENT_RULES.unknownElement,
			'/features/ghost.x',
		);
		expectRule(
			check((d) => (d.config.ghost = {})),
			DOCUMENT_RULES.unknownElement,
			'/config/ghost',
		);
		expectRule(
			check((d) => d.experiments.push({ element: 'ghost', variant: 'a' })),
			DOCUMENT_RULES.unknownElement,
			'/experiments/1/element',
		);
		expectRule(
			check((d) => d.experiments.push({ element: 'codes', variant: 'c' })),
			DOCUMENT_RULES.duplicateExperiment,
			'/experiments/1',
		);
		expectRule(
			check((d) => d.resources.push({ ...d.resources[0] })),
			DOCUMENT_RULES.duplicateResource,
			'/resources/1',
		);
		const doc = entitlement();
		doc.validUntil = doc.issuedAt;
		expectProblem(validateEntitlementDocument(doc), '/validUntil', DOCUMENT_RULES.validityWindow);
	});
});

describe('entitlement document identity section (bring-your-own identity)', () => {
	const ed = {
		kty: 'OKP',
		crv: 'Ed25519',
		x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
		kid: 'site-1',
		alg: 'EdDSA',
		use: 'sig',
	};
	const ec = {
		kty: 'EC',
		crv: 'P-256',
		x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
		y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
		kid: 'site-2',
	};
	const rsa = { kty: 'RSA', n: 'A'.repeat(342), e: 'AQAB', kid: 'site-3', alg: 'RS256' };
	/** @param {Record<string, unknown>} identity */
	const withIdentity = (identity) => ({ ...entitlement(), identity });
	const section = {
		issuer: 'https://login.shop.example.com/',
		jwks: [ed, ec, rsa],
		claimMap: { subject: 'sub', email: 'email' },
	};

	it('accepts an issuer with inline public keys, an optional audience and a claim map', () => {
		expect(validateEntitlementDocument(withIdentity(section)).ok).toBe(true);
		expect(validateEntitlementDocument(withIdentity({ ...section, audience: 'shop-web' })).ok).toBe(true);
	});

	/** @type {Array<[string, Record<string, unknown>, string, string]>} */
	const invalid = [
		['a private key member', { ...section, jwks: [{ ...ed, d: 'secret' }] }, '/identity/jwks/0/d', 'additionalProperties'],
		['too many keys', { ...section, jwks: [ed, ec, rsa, ed, ec, rsa] }, '/identity/jwks', 'maxItems'],
		['no keys', { ...section, jwks: [] }, '/identity/jwks', 'minItems'],
		['a mismatched algorithm', { ...section, jwks: [{ ...ed, alg: 'RS256' }] }, '/identity/jwks/0/alg', 'const'],
		['a short RSA modulus', { ...section, jwks: [{ ...rsa, n: 'AQAB' }] }, '/identity/jwks/0/n', 'minLength'],
		['an EC key without y', { ...section, jwks: [{ ...ec, y: undefined }] }, '/identity/jwks/0/y', 'required'],
		['a missing subject claim', { ...section, claimMap: {} }, '/identity/claimMap/subject', 'required'],
		['a bad claim name', { ...section, claimMap: { subject: '1 sub' } }, '/identity/claimMap/subject', 'pattern'],
		['a missing issuer', { jwks: [ed], claimMap: { subject: 'sub' } }, '/identity/issuer', 'required'],
	];
	it.each(invalid)('rejects %s', (_name, identity, path, keyword) => {
		expectProblem(validateEntitlementDocument(withIdentity(JSON.parse(JSON.stringify(identity)))), path, keyword);
	});

	it('rejects duplicate key ids', () => {
		const result = validateEntitlementDocument(withIdentity({ ...section, jwks: [ed, { ...ec, kid: 'site-1' }] }));
		expect(result.ok).toBe(false);
		expectRule(result.ok ? [] : result.problems, DOCUMENT_RULES.duplicateIdentityKey, '/identity/jwks/1/kid');
	});
});

describe('entitlement document website section', () => {
	/** @param {unknown} website */
	const withWebsite = (website) => ({ ...entitlement(), website });

	it.each([
		['every field', { timeZone: 'America/Argentina/Buenos_Aires', language: 'pt-BR', currency: 'BRL' }],
		['UTC only', { timeZone: 'UTC' }],
		['an Etc offset zone', { timeZone: 'Etc/GMT+5' }],
		['a script subtag', { language: 'zh-Hant-TW' }],
		['nothing', {}],
	])('accepts %s', (_name, website) => {
		expect(validateEntitlementDocument(withWebsite(website)).ok).toBe(true);
	});

	/** @type {Array<[string, unknown, string, string]>} */
	const invalid = [
		['an offset time zone', { timeZone: '+01:00' }, '/website/timeZone', 'pattern'],
		['an unknown time zone', { timeZone: 'Mars/Olympus_Mons' }, '/website/timeZone', DOCUMENT_RULES.timezone],
		['a malformed language', { language: 'EN_us' }, '/website/language', 'pattern'],
		['an invalid language tag', { language: 'de-1901-1901' }, '/website/language', DOCUMENT_RULES.languageTag],
		['a lowercase currency', { currency: 'eur' }, '/website/currency', 'pattern'],
		['an unknown member', { country: 'DE' }, '/website/country', 'additionalProperties'],
	];
	it.each(invalid)('rejects %s', (_name, website, path, keyword) => {
		expectProblem(validateEntitlementDocument(withWebsite(website)), path, keyword);
	});

	it('isLanguageTag accepts BCP-47 tags only', () => {
		expect(isLanguageTag('en')).toBe(true);
		expect(isLanguageTag('de-CH-1901')).toBe(true);
		expect(isLanguageTag('not a tag')).toBe(false);
	});
});
