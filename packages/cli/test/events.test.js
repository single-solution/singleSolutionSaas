import { describe, expect, it } from 'vitest';
import { ELEMENT_EVENT_DATA, EVENT_CATALOGUE, eventScopeOf, validateEvent } from '@ss/contracts';
import {
	HAND_TUNED,
	SAMPLE_DATA,
	buildEnvelope,
	concreteEventType,
	sampleData,
	sampleFromSchema,
} from '../src/emulator/events.js';

const WEBSITE = 'web_devwebsite01';
const NOW = Date.parse('2026-10-01T00:00:00Z');

/** @param {string} type */
const envelope = (type) => buildEnvelope({ type, websiteId: WEBSITE, env: 'test', now: NOW });

describe('emulator sample data', () => {
	it('has a sample for every catalogued event type', () => {
		expect(Object.keys(SAMPLE_DATA).sort()).toEqual(Object.keys(EVENT_CATALOGUE).sort());
		for (const type of Object.keys(HAND_TUNED)) expect(Object.keys(EVENT_CATALOGUE)).toContain(type);
	});

	it.each(Object.keys(EVENT_CATALOGUE))('builds a valid %s event from its sample', (type) => {
		const event = envelope(type);
		const result = validateEvent(event);
		expect(result.ok ? [] : result.problems).toEqual([]);
		if (eventScopeOf(type) === 'platform') {
			expect(event).toMatchObject({ scope: 'platform' });
			expect(event).not.toHaveProperty('websiteId');
		} else expect(event.websiteId).toBe(WEBSITE);
	});

	it.each(Object.keys(ELEMENT_EVENT_DATA))('builds a valid element UI event <element>.%s', (verb) => {
		const event = envelope(`notes.${verb}`);
		expect(event.context).toMatchObject({ element: 'notes' });
		const result = validateEvent(event);
		expect(result.ok ? [] : result.problems).toEqual([]);
	});

	it('generated samples are valid without hand tuning too', () => {
		for (const [type, schema] of Object.entries(EVENT_CATALOGUE)) {
			const event = buildEnvelope({
				type,
				websiteId: WEBSITE,
				env: 'test',
				now: NOW,
				data: /** @type {Record<string, unknown>} */ (sampleFromSchema(schema)),
			});
			const result = validateEvent(event);
			expect(result.ok ? [] : result.problems, type).toEqual([]);
		}
	});

	it('control samples name the envelope website; others fall back to {}', () => {
		expect(sampleData('resource.changed@1', { websiteId: 'web_other0000001' })).toMatchObject({
			websiteId: 'web_other0000001',
		});
		expect(sampleData('subscription.paused@1')).toMatchObject({ websiteId: WEBSITE });
		expect(sampleData('custom.thing@1')).toEqual({});
		expect(sampleData('notes.clicked@1')).toEqual({});
	});

	it('picks concrete types for consumed globs (inventory and price events are deliverable)', () => {
		expect(concreteEventType('inventory.changed@1')).toBe('inventory.changed@1');
		expect(concreteEventType('price.*')).toBe('price.changed@1');
		expect(concreteEventType('item.*@1')).toBe('item.viewed@1');
		expect(concreteEventType('order.*@1')).toBe('order.placed@1');
		expect(concreteEventType('custom.*')).toBe('custom.ss_probe@1');
		expect(concreteEventType('notes_app.*')).toBeNull();
	});
});

describe('sampleFromSchema', () => {
	it.each([
		['const', { const: 7 }, 7],
		['enum', { type: 'string', enum: ['b', 'a'] }, 'b'],
		['anyOf', { anyOf: [{ type: 'integer', minimum: 5 }, { type: 'string' }] }, 5],
		['oneOf', { oneOf: [{ type: 'boolean' }] }, true],
		['nullable string', { type: ['null', 'string'], minLength: 8 }, 'samplexx'],
		['null', { type: 'null' }, null],
		['short string', { type: 'string', maxLength: 3 }, 'sam'],
		['date', { type: 'string', format: 'date' }, '2026-10-01'],
		['email', { type: 'string', format: 'email' }, 'dev@example.com'],
		['uri', { type: 'string', format: 'uri' }, 'https://shop.example.com/'],
		['duration', { type: 'string', format: 'duration' }, 'PT1H'],
		['uuid', { type: 'string', format: 'uuid' }, '00000000-0000-4000-8000-000000000000'],
		['pattern', { type: 'string', pattern: '^\\+[1-9]\\d{6,14}$' }, '+15555550100'],
		['unmatched pattern', { type: 'string', pattern: '^zz$' }, 'sample'],
		['integer above 1', { type: 'integer', minimum: 10 }, 10],
		['integer exclusive', { type: 'integer', exclusiveMinimum: 3 }, 4],
		['negative integer', { type: 'integer', maximum: -2 }, -2],
		['zero allowed', { type: 'integer', minimum: -5, maximum: 0 }, 0],
		['number fraction', { type: 'number', minimum: 0, exclusiveMaximum: 1 }, 0],
		['number lower bound', { type: 'number', exclusiveMinimum: 2 }, 2.5],
		['unbounded below', { type: 'number', exclusiveMaximum: -1 }, -1.5],
		['unique array', { type: 'array', minItems: 2, uniqueItems: true, items: { type: 'string' } }, ['sample', 'sample1']],
		['empty array', { type: 'array', items: { type: 'string' } }, []],
		['common ref', { $ref: 'urn:ss:contracts:v1:common#/$defs/currency' }, 'USD'],
		['common ref resolved', { $ref: 'urn:ss:contracts:v1:common#/$defs/minorUnits' }, 1],
		['unknown', { type: 'thing' }, {}],
		['not a schema', true, {}],
	])('%s', (_name, schema, expected) => {
		expect(sampleFromSchema(schema)).toEqual(expected);
	});

	it('fills required, dependent and minProperties members', () => {
		expect(
			sampleFromSchema({
				type: 'object',
				minProperties: 2,
				required: ['a'],
				dependentRequired: { b: ['c'] },
				properties: { a: { type: 'boolean' }, b: { type: 'integer' }, c: { type: 'string' }, d: { type: 'string' } },
			}),
		).toEqual({ a: true, b: 1, c: 'sample' });
		expect(sampleFromSchema({ properties: { x: { type: 'string' } } })).toEqual({});
	});
});
