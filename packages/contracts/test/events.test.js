import { describe, expect, it } from 'vitest';
import { STANDARD_EVENT_DATA, createValidator, validateEvent } from '../src/index.js';
import { event, standardEventData } from './fixtures.js';
import { expectProblem } from './helpers.js';

describe('event envelope', () => {
	const data = standardEventData();

	it('covers every standard event with a fixture', () => {
		expect(Object.keys(data).sort()).toEqual(Object.keys(STANDARD_EVENT_DATA).sort());
	});

	it.each(Object.entries(data))('accepts %s', (type, payload) => {
		expect(validateEvent(event(type, payload))).toMatchObject({ ok: true });
	});

	it('accepts custom.* events with any object data and minimal envelopes', () => {
		expect(validateEvent(event('custom.quiz_completed@2', { score: 3, nested: { ok: true } })).ok).toBe(true);
		const minimal = event('order.completed@1', { orderId: 'o1' });
		delete minimal.context;
		expect(validateEvent(minimal).ok).toBe(true);
	});

	/** @type {Array<[string, (e: any) => unknown, string, string]>} */
	const envelopeInvalid = [
		['missing id', (e) => delete e.id, '/id', 'required'],
		['type without version', (e) => (e.type = 'order.placed'), '/type', 'pattern'],
		['version zero', (e) => (e.type = 'order.placed@0'), '/type', 'pattern'],
		['local-time occurredAt', (e) => (e.occurredAt = '2026-10-01T12:00:00'), '/occurredAt', 'format'],
		['offset occurredAt', (e) => (e.occurredAt = '2026-10-01T12:00:00+05:00'), '/occurredAt', 'pattern'],
		['unknown actor type', (e) => (e.actor.type = 'robot'), '/actor/type', 'enum'],
		['PII-bearing context member', (e) => (e.context.ip = '1.2.3.4'), '/context/ip', 'additionalProperties'],
		['non-object data', (e) => (e.data = []), '/data', 'type'],
		['whitespace idempotency key', (e) => (e.idempotencyKey = 'a b'), '/idempotencyKey', 'pattern'],
	];
	it.each(envelopeInvalid)('rejects envelope with %s', (_name, mutate, path, keyword) => {
		const e = event('order.completed@1', { orderId: 'o1' });
		mutate(e);
		expectProblem(validateEvent(e), path, keyword);
	});

	/** @type {Array<[string, string, Record<string, unknown>, string, string]>} */
	const dataInvalid = [
		['float money', 'item.viewed@1', { itemId: 'i', price: { amount: 19.99, currency: 'USD' } }, '/data/price/amount', 'type'],
		[
			'lowercase currency',
			'item.viewed@1',
			{ itemId: 'i', price: { amount: 1, currency: 'usd' } },
			'/data/price/currency',
			'pattern',
		],
		[
			'negative line amount',
			'cart.updated@1',
			{ cartId: 'c', currency: 'EUR', lines: [{ itemId: 'i', quantity: 1, unitAmount: -1 }], subtotalAmount: 0 },
			'/data/lines/0/unitAmount',
			'minimum',
		],
		[
			'zero quantity',
			'order.placed@1',
			{
				orderId: 'o',
				currency: 'EUR',
				lines: [{ itemId: 'i', quantity: 0, unitAmount: 1 }],
				amounts: { subtotal: 1, total: 1 },
			},
			'/data/lines/0/quantity',
			'minimum',
		],
		[
			'empty order',
			'order.placed@1',
			{ orderId: 'o', currency: 'EUR', lines: [], amounts: { subtotal: 0, total: 0 } },
			'/data/lines',
			'minItems',
		],
		[
			'missing amounts',
			'order.placed@1',
			{ orderId: 'o', currency: 'EUR', lines: [{ itemId: 'i', quantity: 1, unitAmount: 1 }] },
			'/data/amounts',
			'required',
		],
		['relative page url', 'page.viewed@1', { url: '/p', path: '/p' }, '/data/url', 'format'],
		['unknown data member', 'order.completed@1', { orderId: 'o', extra: 1 }, '/data/extra', 'additionalProperties'],
		[
			'bad content type',
			'file.uploaded@1',
			{ fileId: 'f', name: 'x', contentType: 'jpeg', size: 1 },
			'/data/contentType',
			'pattern',
		],
		['empty change list', 'customer.updated@1', { customerId: 'c', changed: [] }, '/data/changed', 'minItems'],
		['fractional inventory', 'inventory.changed@1', { itemId: 'i', quantity: 1.5 }, '/data/quantity', 'type'],
	];
	it.each(dataInvalid)('rejects data with %s', (_name, type, payload, path, keyword) => {
		expectProblem(validateEvent(event(type, payload)), path, keyword);
	});

	it('rejects unknown non-custom event types and versions', () => {
		expectProblem(validateEvent(event('coupons.redeemed@1', {})), '/type', 'eventType');
		expectProblem(validateEvent(event('order.placed@2', {})), '/type', 'eventType');
	});

	it('accepts product events registered on a validator', () => {
		const validator = createValidator({
			events: {
				'coupons.redeemed@1': {
					type: 'object',
					required: ['code'],
					additionalProperties: false,
					properties: { code: { type: 'string' }, discount: { $ref: 'urn:ss:contracts:v1:common#/$defs/money' } },
				},
			},
		});
		expect(
			validator.validateEvent(event('coupons.redeemed@1', { code: 'X', discount: { amount: 5, currency: 'GBP' } })).ok,
		).toBe(true);
		expectProblem(validator.validateEvent(event('coupons.redeemed@1', {})), '/data/code', 'required');
	});

	it('refuses to register invalid or custom product event types', () => {
		expect(() => createValidator({ events: { 'Coupon@1': { type: 'object' } } })).toThrow(TypeError);
		expect(() => createValidator({ events: { 'custom.x@1': { type: 'object' } } })).toThrow(TypeError);
	});
});
