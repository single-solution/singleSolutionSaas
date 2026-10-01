import { describe, expect, it } from 'vitest';
import {
	CONTROL_EVENT_DATA,
	ELEMENT_UI_EVENT_MAX_BYTES,
	EVENT_CATALOGUE,
	LOADER_EVENT_DATA,
	MANIFEST_RULES,
	RESERVED_EVENT_NAMESPACES,
	checkManifest,
	isElementUiEvent,
	standardEventDataSchemas,
	STANDARD_EVENT_DATA,
	validateEvent,
} from '../src/index.js';
import { SUBSCRIPTION, WEBSITE, event, manifest } from './fixtures.js';
import { expectProblem, expectRule } from './helpers.js';

const jws = 'eyJhbGciOiJFZERTQSJ9.eyJ2IjoxfQ.c2lnbmF0dXJl';
const lifecycle = { subscriptionId: SUBSCRIPTION, websiteId: WEBSITE, reason: 'balance_zero' };

/** @type {Record<string, Record<string, unknown>>} */
const valid = {
	'entitlement.changed@1': { subscriptionId: SUBSCRIPTION, websiteId: WEBSITE, version: 3, document: jws },
	'key.revoked@1': { keyIds: ['key_1', 'key_2'], revokedAt: '2026-10-01T00:00:00Z' },
	'resource.changed@1': { websiteId: WEBSITE, kind: 'storage', status: 'failing', ref: 'res_1' },
	'subscription.activated@1': { subscriptionId: SUBSCRIPTION, websiteId: WEBSITE },
	'subscription.paused@1': lifecycle,
	'subscription.resumed@1': lifecycle,
	'subscription.cancelled@1': lifecycle,
	'manifest.accepted@1': { appId: 'prd_1', version: '1.4.0' },
	'loader.vitals@1': { lcp: 1834.5, cls: 0.02, inp: 96, elements: [{ key: 'apply_box', mountMs: 12.3 }], sampled: true },
	'loader.element_failed@1': { element: 'apply_box', code: 'render_error', message: 'Selector not found' },
};

describe('platform control and loader events', () => {
	it('has a fixture for every catalogued platform event', () => {
		expect(Object.keys(valid).sort()).toEqual([...Object.keys(CONTROL_EVENT_DATA), ...Object.keys(LOADER_EVENT_DATA)].sort());
		for (const type of Object.keys(valid)) expect(Object.hasOwn(EVENT_CATALOGUE, type)).toBe(true);
		expect(standardEventDataSchemas()).toHaveLength(Object.keys(STANDARD_EVENT_DATA).length);
	});

	it.each(Object.entries(valid))('accepts %s', (type, data) => {
		expect(validateEvent({ ...event(type, data), actor: { type: 'system' } })).toMatchObject({ ok: true });
	});

	/** @type {Array<[string, Record<string, unknown>, string, string]>} */
	const invalid = [
		['entitlement.changed@1', { subscriptionId: SUBSCRIPTION, websiteId: WEBSITE, version: 0 }, '/data/version', 'minimum'],
		[
			'entitlement.changed@1',
			{ subscriptionId: SUBSCRIPTION, websiteId: WEBSITE, version: 1, document: '{"not":"jws"}' },
			'/data/document',
			'pattern',
		],
		['key.revoked@1', { keyIds: [], revokedAt: '2026-10-01T00:00:00Z' }, '/data/keyIds', 'minItems'],
		['key.revoked@1', { keyIds: ['k'], revokedAt: 'yesterday' }, '/data/revokedAt', 'format'],
		['resource.changed@1', { websiteId: WEBSITE, kind: 'storage', status: 'disconnected', ref: 'r' }, '/data/status', 'enum'],
		['resource.changed@1', { websiteId: WEBSITE, kind: 'cdn', status: 'revoked', ref: 'r' }, '/data/kind', 'enum'],
		['subscription.paused@1', { websiteId: WEBSITE }, '/data/subscriptionId', 'required'],
		['subscription.cancelled@1', { ...lifecycle, reason: 'Has Spaces' }, '/data/reason', 'pattern'],
		['manifest.accepted@1', { appId: 'prd_1', version: 'v1' }, '/data/version', 'pattern'],
		['loader.vitals@1', { elements: [], sampled: false }, '/data/sampled', 'const'],
		['loader.vitals@1', { elements: [{ key: 'x', mountMs: -1 }], sampled: true }, '/data/elements/0/mountMs', 'minimum'],
		['loader.vitals@1', { lcp: 1 }, '/data/elements', 'required'],
		['loader.element_failed@1', { element: 'x', code: 'e', message: 'm'.repeat(501) }, '/data/message', 'maxLength'],
		['loader.element_failed@1', { element: 'x', code: 'Bad Code', message: 'm' }, '/data/code', 'pattern'],
	];
	it.each(invalid)('rejects %s %j', (type, data, path, keyword) => {
		expectProblem(validateEvent(event(type, data)), path, keyword);
	});
});

describe('element UI events', () => {
	it('recognises <element>.<verb>@1 outside reserved namespaces', () => {
		expect(isElementUiEvent('apply_box.applied@1')).toBe(true);
		expect(isElementUiEvent('launcher.opened@1')).toBe(true);
		expect(isElementUiEvent('apply_box.applied@2')).toBe(false);
		expect(isElementUiEvent('Apply.applied@1')).toBe(false);
		expect(isElementUiEvent('apply_box.applied.twice@1')).toBe(false);
		expect(isElementUiEvent('order.placed@1')).toBe(false);
		expect(isElementUiEvent('loader.anything@1')).toBe(false);
		expect(isElementUiEvent('custom.thing@1')).toBe(false);
		expect(isElementUiEvent(`${'a'.repeat(41)}.opened@1`)).toBe(false);
		expect(isElementUiEvent(7)).toBe(false);
		expect(RESERVED_EVENT_NAMESPACES).toEqual(expect.arrayContaining(['order', 'entitlement', 'loader', 'custom']));
	});

	/** @param {Record<string, unknown>} data */
	const uiEvent = (data, element = 'apply_box') => {
		const e = event('apply_box.applied@1', data);
		e.context = { source: 'loader', element };
		return e;
	};

	it('accepts any size-capped object when context.element names the element', () => {
		expect(validateEvent(uiEvent({ code: 'SAVE10', ok: true })).ok).toBe(true);
		expectProblem(validateEvent(uiEvent({ blob: 'x'.repeat(ELEMENT_UI_EVENT_MAX_BYTES) })), '/data', 'maxSize');
		const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, i]));
		expectProblem(validateEvent(uiEvent(many)), '/data', 'maxProperties');
	});

	it('treats it as unknown without a matching context.element', () => {
		expectProblem(validateEvent(uiEvent({}, 'other')), '/type', 'eventType');
		expectProblem(validateEvent(event('apply_box.applied@1', {})), '/type', 'eventType');
	});
});

describe('platform events in manifests', () => {
	/** @param {(m: any) => void} mutate */
	const semantic = (mutate) => {
		const m = manifest();
		mutate(m);
		return checkManifest(m);
	};

	it('rejects products publishing control or loader events', () => {
		for (const type of [
			'entitlement.changed@1',
			'subscription.paused@1',
			'key.revoked@1',
			'loader.vitals@1',
			'manifest.something@1',
		]) {
			expectRule(
				semantic((m) => ((m.events.publishes = [type]), m.scopes.push('events.publish:*'))),
				MANIFEST_RULES.platformEventNotPublishable,
				'/events/publishes/0',
			);
		}
	});

	it('lets products consume control events without a subscribe scope', () => {
		expect(semantic((m) => m.events.consumes.push('entitlement.changed@1', 'subscription.cancelled@1'))).toEqual([]);
		expectRule(
			semantic((m) => m.events.consumes.push('loader.vitals@1')),
			MANIFEST_RULES.eventNotSubscribed,
		);
	});
});
