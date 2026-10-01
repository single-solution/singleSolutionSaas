import { describe, expect, it } from 'vitest';
import { GRAPH_ENTITY_SCHEMAS, validateGraphEntity } from '../src/index.js';
import { graph } from '../src/testing.js';
import { expectProblem } from './helpers.js';

/** @typedef {import('../src/schemas/index.js').GraphEntityName} GraphEntityName */

describe('graph entities', () => {
	const entities = /** @type {Array<[GraphEntityName, any]>} */ (Object.entries(graph()));

	it('has a fixture for every entity', () => {
		expect(entities.map(([name]) => name).sort()).toEqual(Object.keys(GRAPH_ENTITY_SCHEMAS).sort());
	});

	it.each(entities)('accepts a valid %s', (name, value) => {
		expect(validateGraphEntity(name, value)).toMatchObject({ ok: true });
	});

	it.each(entities)('%s requires the base fields and rejects unknown members', (name, value) => {
		const rest = { ...value };
		delete rest.websiteId;
		expectProblem(validateGraphEntity(name, rest), '/websiteId', 'required');
		expectProblem(validateGraphEntity(name, { ...value, env: 'prod' }), '/env', 'enum');
		expectProblem(validateGraphEntity(name, { ...value, secret: 'x' }), '/secret', 'additionalProperties');
		expectProblem(validateGraphEntity(name, { ...value, updatedAt: '2026-10-01 00:00' }), '/updatedAt');
	});

	/** @type {Array<[GraphEntityName, string, (e: any) => unknown, string, string]>} */
	const invalid = [
		['customer', 'bad email', (e) => (e.identities[0].value = 'not-an-email'), '/identities/0/value', 'format'],
		['customer', 'non-E.164 phone', (e) => (e.identities[1].value = '03001234567'), '/identities/1/value', 'pattern'],
		['customer', 'external id without issuer', (e) => delete e.identities[2].issuer, '/identities/2/issuer', 'required'],
		[
			'customer',
			'bad consent',
			(e) => (e.consent.marketing = { granted: 'yes', updatedAt: '2026-10-01T00:00:00Z' }),
			'/consent/marketing/granted',
			'type',
		],
		['customer', 'nested attribute object', (e) => (e.attributes.address = { city: 'x' }), '/attributes/address', 'anyOf'],
		['item', 'float price', (e) => (e.prices[0].amount = 499.99), '/prices/0/amount', 'type'],
		['item', 'missing currency', (e) => delete e.variants[0].prices[0].currency, '/variants/0/prices/0/currency', 'required'],
		['item', 'bad status', (e) => (e.status = 'live'), '/status', 'enum'],
		['item', 'media without file', (e) => (e.media = [{ alt: 'x' }]), '/media/0/fileId', 'required'],
		['order', 'unknown status', (e) => (e.status = 'shipped'), '/status', 'enum'],
		['order', 'no lines', (e) => (e.lines = []), '/lines', 'minItems'],
		['order', 'negative total', (e) => (e.amounts.total = -1), '/amounts/total', 'minimum'],
		['session', 'bad device', (e) => (e.device = 'watch'), '/device', 'enum'],
		['session', 'missing start', (e) => delete e.startedAt, '/startedAt', 'required'],
		['session', 'relative referrer', (e) => (e.referrer = 'google'), '/referrer', 'format'],
		[
			'file',
			'signed URL as storage ref',
			(e) => (e.storageRef = 'https://bucket/x?X-Amz-Signature=abc'),
			'/storageRef',
			'pattern',
		],
		['file', 'negative size', (e) => (e.size = -1), '/size', 'minimum'],
		['file', 'weak checksum', (e) => (e.checksum.algorithm = 'md5'), '/checksum/algorithm', 'enum'],
		['consent-record', 'empty categories', (e) => (e.categories = {}), '/categories', 'minProperties'],
		['consent-record', 'non-boolean category', (e) => (e.categories.analytics = 'yes'), '/categories/analytics', 'type'],
		['consent-record', 'unknown source', (e) => (e.source = 'guess'), '/source', 'enum'],
		['custom-field-definition', 'enum without options', (e) => delete e.options, '/options', 'required'],
		['custom-field-definition', 'unknown type', (e) => (e.type = 'money'), '/type', 'enum'],
		['custom-field-definition', 'bad key', (e) => (e.key = '1st'), '/key', 'pattern'],
	];
	it.each(invalid)('%s: rejects %s', (name, _label, mutate, path, keyword) => {
		const value = /** @type {any} */ (graph())[name];
		mutate(value);
		expectProblem(validateGraphEntity(name, value), path, keyword);
	});

	it('rejects unknown entity names and non-objects', () => {
		expectProblem(validateGraphEntity(/** @type {any} */ ('planet'), {}), '', 'entity');
		expectProblem(validateGraphEntity('customer', 'x'), '', 'type');
	});
});
