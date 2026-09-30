import { describe, expect, it } from 'vitest';
import { DOCUMENT_RULES, RUNTIME_STATES, checkEntitlementDocument, validateEntitlementDocument } from '../src/index.js';
import { entitlement } from './fixtures.js';
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
