import { describe, expect, it } from 'vitest';
import {
	BUSINESS_JSON_TEMPLATE,
	isTimeZone,
	validateActivityCopy,
	validateBusinessJson,
	validateDataRightsRequest,
} from '../src/index.js';
import { WEBSITE, businessJson } from '../src/testing.js';
import { expectProblem } from './helpers.js';

describe('validateBusinessJson', () => {
	it('normalises a full file', () => {
		expect(validateBusinessJson(businessJson())).toEqual({
			ok: true,
			value: {
				name: 'Example Shop',
				logo: 'https://shop.example.com/logo.png',
				email: 'hello@shop.example.com',
				phone: '+1 555 0100',
				address: '1 Example Street\nExample City',
				country: 'US',
				timeZone: 'Europe/London',
			},
		});
	});

	it('accepts the template', () => {
		const result = validateBusinessJson({ ...BUSINESS_JSON_TEMPLATE });
		expect(result.ok && result.value).toEqual(BUSINESS_JSON_TEMPLATE);
	});

	it('needs only the name and drops invalid fields', () => {
		expect(validateBusinessJson({ name: '  Shop  ', version: 1 })).toEqual({
			ok: true,
			value: { name: 'Shop', logo: null, email: null, phone: null, address: null, country: null, timeZone: null },
		});
		const result = validateBusinessJson({
			name: 'Shop',
			logo: 'http://shop.example.com/logo.png',
			email: 'not-an-email',
			phone: 'call us',
			address: 'x'.repeat(501),
			country: 'USA',
			timeZone: 'Mars/Olympus',
		});
		expect(result.ok && result.value).toEqual({
			name: 'Shop',
			logo: null,
			email: null,
			phone: null,
			address: null,
			country: null,
			timeZone: null,
		});
		const more = validateBusinessJson({
			name: 'Shop',
			logo: 'https://u:p@shop.example.com/logo.png',
			email: 5,
			address: 'a\u0000b',
			timeZone: 'utc',
		});
		expect(more.ok && more.value).toMatchObject({ logo: null, email: null, address: null, timeZone: 'UTC' });
		expect(validateBusinessJson({ name: 'Shop', logo: 'not a url' }).ok).toBe(true);
	});

	it('refuses a file without a usable name', () => {
		expectProblem(validateBusinessJson('Shop'), '', 'type');
		expectProblem(validateBusinessJson([]), '', 'type');
		expectProblem(validateBusinessJson({}), '/name', 'required');
		expectProblem(validateBusinessJson({ name: '   ' }), '/name', 'required');
		expectProblem(validateBusinessJson({ name: 'a\nb' }), '/name', 'required');
		expectProblem(validateBusinessJson({ name: 'x'.repeat(201) }), '/name', 'required');
	});

	it('knows IANA time zones', () => {
		expect(isTimeZone('Asia/Karachi')).toBe(true);
		expect(isTimeZone('Nowhere/Town')).toBe(false);
		expect(isTimeZone(5)).toBe(false);
	});
});

describe('validateDataRightsRequest', () => {
	it('needs at least one way to identify the user', () => {
		expect(validateDataRightsRequest({ user: { id: 'u_1' } }).ok).toBe(true);
		expect(validateDataRightsRequest({ user: { email: 'a@example.com', phone: '+92 300 1234567' } }).ok).toBe(true);
		expectProblem(validateDataRightsRequest({ user: {} }), '/user', 'minProperties');
		expectProblem(validateDataRightsRequest({}), '/user', 'required');
		expectProblem(validateDataRightsRequest({ user: { email: 'nope' } }), '/user/email', 'format');
		expectProblem(validateDataRightsRequest({ user: { phone: 'call me' } }), '/user/phone', 'pattern');
		expectProblem(validateDataRightsRequest({ user: { id: 'u', name: 'x' } }), '/user/name', 'additionalProperties');
	});
});

describe('validateActivityCopy', () => {
	const copy = () => ({
		websiteId: WEBSITE,
		productId: 'chat',
		actor: { kind: 'staff', id: 'u_1', name: 'Sara' },
		action: 'conversation.assigned',
		target: 'conversation:c_1',
		at: '2026-10-01T10:00:00Z',
	});
	it('accepts a copy', () => {
		expect(validateActivityCopy(copy()).ok).toBe(true);
		expect(validateActivityCopy({ ...copy(), actor: { kind: 'visitor', id: 'v_1' } }).ok).toBe(true);
	});
	it.each([
		['a bad product id', { productId: 'Chat' }, '/productId', 'pattern'],
		['a bad action', { action: 'Assigned' }, '/action', 'pattern'],
		['an actor without id', { actor: { kind: 'staff' } }, '/actor/id', 'required'],
		['an empty target', { target: '' }, '/target', 'minLength'],
		['an impossible time', { at: '2026-13-01T00:00:00Z' }, '/at', 'format'],
		['message contents', { text: 'hello' }, '/text', 'additionalProperties'],
	])('refuses %s', (_name, patch, path, keyword) => {
		expectProblem(validateActivityCopy({ ...copy(), ...patch }), path, keyword);
	});
});
