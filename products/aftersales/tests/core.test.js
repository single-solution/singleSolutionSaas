/** core/: pure rules with plain inputs and outputs, plus small adapters (tokens, settings). */
import { describe, expect, it } from 'vitest';
import { canTransition, kindOf, refundCap, restockPlan, transitionSet } from '../core/claims.js';
import { effectiveConfig } from '../core/config.js';
import { pickTarget, refundEventData, restockEventData, statusEventData } from '../core/events.js';
import { customerOf, hasCustomer, linesOf, mergeCustomer, orderFacts, purchaseTotal, withRefunded } from '../core/purchases.js';
import { checkCondition, compileCondition, conditionMatches } from '../core/rules.js';
import { serialKey, serialsOfEvent } from '../core/serials.js';
import { cleanText, fill, normalEmail, normalPhone } from '../core/text.js';
import { isTimeZone, toMs } from '../core/time.js';
import {
	validateAccess,
	validateAssign,
	validateMessage,
	validateNote,
	validatePhotoUpload,
	validateRefund,
	validateRestock,
	validateSerial,
	validateTransition,
	validateView,
} from '../core/validate.js';
import { formView, ownerPurchaseView, publicSerialView } from '../core/views.js';
import { windowDays, windowState } from '../core/windows.js';
import { createClaimTokens, tokenSecret } from '../adapters/tokens.js';
import { retentionDays } from '../adapters/platform.js';
import { settingsFrom } from '../api/settings.js';

const statuses = /** @type {const} */ ([
	{ key: 'a', label: 'A', kind: 'open' },
	{ key: 'r', label: 'R', kind: 'rejected' },
	{ key: 'd', label: 'D', kind: 'resolved' },
	{ key: 'c', label: 'C', kind: 'closed' },
]);

describe('claims core', () => {
	it('knows kinds and transitions and the fields a move sets', () => {
		expect(kindOf([...statuses], 'zzz')).toBe('open');
		const transitions = [
			{ from: 'a', to: 'r' },
			{ from: 'a', to: 'ghost' },
		];
		expect(canTransition(transitions, [...statuses], 'a', 'r')).toBe(true);
		expect(canTransition(transitions, [...statuses], 'a', 'ghost')).toBe(false);
		expect(transitionSet({ claim: {}, to: 'r', statuses: [...statuses], now: 0 })).toMatchObject({
			released: true,
			resolvedAt: '1970-01-01T00:00:00.000Z',
		});
		expect(transitionSet({ claim: { resolvedAt: 'x' }, to: 'd', statuses: [...statuses], now: 0 }).resolvedAt).toBeUndefined();
		expect(transitionSet({ claim: {}, to: 'c', statuses: [...statuses], now: 0 }).closedAt).toBeTruthy();
	});

	it('caps refunds by lines and purchase', () => {
		const claim = { lines: [{ unitAmount: 100, quantity: 2 }], refundedAmount: 50 };
		expect(refundCap({ claim, purchaseTotal: null, purchaseRefunded: 0, cap: 'claimed_lines' })).toBe(150);
		expect(refundCap({ claim, purchaseTotal: 100, purchaseRefunded: 20, cap: 'claimed_lines' })).toBe(80);
		expect(refundCap({ claim, purchaseTotal: 100, purchaseRefunded: 20, cap: 'purchase' })).toBe(80);
		expect(refundCap({ claim, purchaseTotal: null, purchaseRefunded: 0, cap: 'purchase' })).toBeNull();
		expect(refundCap({ claim, purchaseTotal: 1, purchaseRefunded: 0, cap: 'none' })).toBeNull();
		expect(
			refundCap({
				claim: { lines: [{ unitAmount: null, quantity: 1 }], refundedAmount: 0 },
				purchaseTotal: 70,
				purchaseRefunded: 0,
				cap: 'claimed_lines',
			}),
		).toBe(70);
	});

	it('plans restocks only for allowed statuses and returning types', () => {
		const claim = { status: 'a', lines: [{ lineId: 'l', restock: null }] };
		expect(restockPlan({ claim, decisions: [], allowedStatuses: ['b'], type: undefined })).toMatchObject({ ok: false });
		expect(
			restockPlan({ claim, decisions: [], allowedStatuses: ['a'], type: /** @type {any} */ ({ returns_item: false }) }),
		).toMatchObject({ ok: false });
	});
});

describe('purchases, serials and windows', () => {
	it('normalises lines, customers and totals', () => {
		expect(linesOf('x')).toEqual([]);
		expect(
			linesOf([null, { itemId: 'i', quantity: 0 }, { itemId: 'i', quantity: 1, lineId: 'L', grade: ' ', warrantyDays: 5 }]),
		).toMatchObject([{ lineId: 'L', grade: null, warrantyDays: 5 }]);
		expect(customerOf({ customerId: 'c1' })).toMatchObject({ customerId: 'c1', subject: null });
		expect(hasCustomer(customerOf({}))).toBe(false);
		expect(mergeCustomer(null, customerOf({ customer: { email: 'A@B.co' } })).email).toBe('a@b.co');
		expect(orderFacts('x')).toBeNull();
		expect(orderFacts({ orderId: 'bad id' })).toBeNull();
		expect(orderFacts({ orderId: 'o', currency: 'usd' })?.currency).toBeNull();
		expect(purchaseTotal({ total: null, lines: linesOf([{ itemId: 'i', quantity: 2, unitAmount: 5 }]) })).toBe(10);
		expect(purchaseTotal({ total: null, lines: linesOf([{ itemId: 'i', quantity: 2 }]) })).toBeNull();
		expect(withRefunded(linesOf([{ itemId: 'i', quantity: 1 }]), [{ itemId: 'i', quantity: 5 }])[0]?.refundedQuantity).toBe(1);
	});

	it('normalises serials and reads them from events', () => {
		const format = { case_sensitive: true, ignore_separators: false, min_length: 2, max_length: 8 };
		expect(serialKey('ab-c', format)).toBe('ab-c');
		expect(serialKey(5, format)).toBeNull();
		expect(serialKey('a', format)).toBeNull();
		expect(serialsOfEvent(null)).toEqual([]);
		expect(
			serialsOfEvent({
				lines: [{ itemId: 'i', variantId: 'v', serials: ['S1', { serial: 'S2', variantId: 'bad id' }, { serial: 3 }] }, 'x'],
			}),
		).toEqual([
			{ serial: 'S1', itemId: 'i', variantId: 'v' },
			{ serial: 'S2', itemId: 'i', variantId: null },
		]);
	});

	it('chooses windows and states', () => {
		const type = { key: 't', label: 'T', window_days: 3, use_snapshot_days: true, use_grade_windows: true };
		const line = /** @type {any} */ (linesOf([{ itemId: 'i', quantity: 1 }])[0]);
		const base = {
			type,
			line,
			grade: 'g',
			context: {},
			gradeWindows: [{ grade: 'h', type: 't', days: 1 }],
			rules: [],
			now: 0,
			timeZone: 'UTC',
		};
		expect(windowDays(base)).toMatchObject({ days: 3, source: 'type' });
		expect(windowDays({ ...base, line: { ...line, warrantyDays: 9 } })).toMatchObject({ days: 9, source: 'snapshot' });
		expect(
			windowDays({
				...base,
				rules: [
					{ id: 'x', type: 'other', days: 1 },
					{ id: 'y', type: 't', when: '1 ==', days: 2 },
				],
			}).source,
		).toBe('type');
		expect(windowState({ startedAt: 0, days: 1, source: 's', now: 2 * 86_400_000 })).toMatchObject({
			eligible: false,
			reason: 'window_closed',
		});
		expect(conditionMatches('line.x == 1', { line: { x: 1 } }, { now: 0, timeZone: 'UTC' })).toBe(true);
		expect(conditionMatches('nope(', {}, { now: 0, timeZone: 'UTC' })).toBe(false);
		expect(conditionMatches('1 / 0 > "a"', {}, { now: 0, timeZone: 'UTC' })).toBe(false);
		expect(compileCondition('line.a == 1')).toBe(compileCondition('line.a == 1'));
		for (let i = 0; i < 505; i += 1) compileCondition(`line.a == ${i}`);
		expect(checkCondition(null).ok).toBe(true);
		expect(checkCondition('foo == 1').warnings.length).toBeGreaterThan(0);
	});
});

describe('text, time, config, events and views', () => {
	it('cleans text and contacts', () => {
		expect(cleanText(5)).toBe('');
		expect(cleanText(' a\r\nb\u0007 ')).toBe('a\nb');
		expect(normalEmail(1)).toBeNull();
		expect(normalPhone(1)).toBeNull();
		expect(fill('{a} {b}', { a: 1 })).toBe('1 {b}');
		expect(toMs(new Date(5))).toBe(5);
		expect(toMs(new Date('x'))).toBeNull();
		expect(toMs(Number.NaN)).toBeNull();
		expect(toMs(7)).toBe(7);
		expect(toMs('x'.repeat(50))).toBeNull();
		expect(isTimeZone('Mars/Base')).toBe(false);
		expect(isTimeZone('')).toBe(false);
		expect(isTimeZone('Europe/Paris')).toBe(true);
		const schema = {
			properties: {
				n: { type: 'number', default: 1 },
				o: { type: 'object', default: {} },
				x: { default: 1 },
				b: { type: 'boolean', default: false },
			},
		};
		expect(effectiveConfig(schema, { n: 'x', o: { a: 1 }, x: 2, b: true })).toEqual({ n: 1, o: { a: 1 }, x: 2, b: true });
	});

	it('builds event data and picks channels', () => {
		const claim = {
			id: 'c',
			reference: 'R',
			type: 't',
			orderId: null,
			lines: [{ itemId: 'i', variantId: null, sku: null, title: null, quantity: 1, unitAmount: null }],
		};
		const data = refundEventData({
			claim,
			purchase: { orderId: 'o', customer: null },
			refund: { amount: 1, currency: 'USD' },
			reason: 'x',
			includeLines: true,
		});
		expect(data).toEqual({
			orderId: 'o',
			amount: { amount: 1, currency: 'USD' },
			reason: 'x',
			lines: [{ itemId: 'i', quantity: 1 }],
		});
		expect(restockEventData({ line: { itemId: 'i', quantity: 2 }, previous: { quantity: 1 }, reason: 'r' })).toEqual({
			itemId: 'i',
			quantity: 3,
			previousQuantity: 1,
			reason: 'r',
		});
		expect(statusEventData({ claim, from: 'a', to: 'b', statuses: [] })).toMatchObject({ kind: 'open' });
		expect(pickTarget({ phone: '+1555' }, ['email', 'whatsapp'])).toEqual({ channel: 'whatsapp', to: '+1555' });
		expect(pickTarget(null, ['email'])).toBeNull();
	});

	it('builds views without optional parts', () => {
		const settings = settingsFrom({ can: () => false, config: () => ({}) });
		expect(
			formView({
				types: [
					{ key: 'x', label: 'X', window_days: 1, enabled: false },
					{ key: 'y', label: 'Y', window_days: 1 },
				],
				reasons: [{ key: 'r', label: 'R' }],
				claims: settings.claims,
				photos: null,
				messages: null,
			}),
		).toMatchObject({
			types: [{ key: 'y', minPhotos: 0, refundable: true }],
			reasons: [{ types: [], detailsRequired: false }],
		});
		expect(
			publicSerialView({
				serial: { serial: 'S' },
				entry: null,
				types: [{ key: 'w', label: 'W', window_days: 1 }],
				showSaleDate: true,
			}),
		).toEqual({
			serial: 'S',
			title: null,
			soldAt: null,
			cover: [{ type: 'w', label: 'W', active: false, endsAt: null }],
		});
		expect(ownerPurchaseView({ id: 'p', status: 'placed', lines: [] }, { lines: [], canClaim: false })).toMatchObject({
			number: null,
			refundedAmount: 0,
		});
		const odd = settingsFrom({
			can: () => true,
			config: (key) =>
				key === 'queue'
					? {
							statuses: [
								{ key: 'x', label: 'X', kind: 'open' },
								{ key: 'x', label: 'Dup', kind: 'open' },
							],
							initial_status: 'nope',
						}
					: {},
			website: { timeZone: 'Europe/Paris', language: 'fr', currency: 'EUR' },
		});
		expect(odd).toMatchObject({ initialStatus: 'x', timeZone: 'Europe/Paris', language: 'fr', currency: 'EUR' });
		expect(odd.vocabulary.statuses).toHaveLength(1);
	});
});

describe('input validators', () => {
	it('refuses malformed bodies everywhere', () => {
		for (const validate of [validateAccess, validateView, validateAssign, validateRefund, validateRestock, validateSerial])
			expect(validate(null).problems.length).toBeGreaterThan(0);
		expect(validateTransition(null, 10).problems.length).toBe(1);
		expect(validateNote(null, 10).problems.length).toBe(1);
		expect(validateMessage(null, 10).problems.length).toBe(1);
		expect(validatePhotoUpload(null, { allowedTypes: [], maxBytes: 1 }).problems.length).toBe(1);
		expect(validateNote({ body: 'x'.repeat(11) }, 10).problems[0]?.code).toBe('too_long');
		expect(validateNote({ body: 5 }, 10).problems[0]?.code).toBe('invalid');
		expect(validateTransition({ to: 'Bad' }, 10).problems[0]?.code).toBe('invalid');
		expect(validateRefund({ claimId: 'c', amount: 1, method: 'BAD' }).problems[0]?.code).toBe('invalid');
		expect(validateRefund({ claimId: 'c', amount: 1 }).problems[0]?.code).toBe('required');
		expect(validateRestock({ claimId: 'c', lines: Array.from({ length: 101 }, () => ({})) }).problems[0]?.code).toBe(
			'too_many',
		);
		expect(validateRestock({ claimId: 'c', lines: [{ lineId: 'l', restock: 'yes' }] }).problems[0]?.path).toBe('/lines/0');
		expect(validateSerial({ serial: 'S', itemId: 'i', soldAt: 'x' }).problems[0]?.path).toBe('/soldAt');
		expect(validateSerial({ serial: 'S', itemId: 'i', soldAt: '2026-01-01T00:00:00Z' }).value?.soldAt).toBe(
			Date.parse('2026-01-01T00:00:00Z'),
		);
		expect(validateView({ token: 'x'.repeat(2000) }).problems[0]?.code).toBe('invalid');
		expect(validateAccess({ orderId: 'o', email: 'a@b.co' }).value).toMatchObject({ orderId: 'o', number: null });
	});
});

describe('adapters', () => {
	it('issues and verifies claim tokens and derives secrets', () => {
		let now = 0;
		const tokens = createClaimTokens({ secret: tokenSecret({ secret: 's'.repeat(32) }), now: () => now });
		const { token } = tokens.issue({ websiteId: 'w', purchaseId: 'p', ttlDays: 1 });
		expect(tokens.verify(token, 'w')).toBe('p');
		expect(tokens.verify(token, 'x')).toBeNull();
		expect(tokens.verify(5, 'w')).toBeNull();
		expect(tokens.verify('ct1.a', 'w')).toBeNull();
		expect(tokens.verify(`${token}x`, 'w')).toBeNull();
		expect(tokens.verify(`${token}.extra`, 'w')).toBeNull();
		now = 2 * 86_400_000;
		expect(tokens.verify(token, 'w')).toBeNull();
		expect(() => tokenSecret({ signingKey: null })).toThrow();
		expect(tokenSecret({ signingKey: `k:${Buffer.from('k').toString('base64url')}` })).toHaveLength(32);
		expect(
			createClaimTokens({ secret: Buffer.from('x') }).issue({ websiteId: 'w', purchaseId: 'p', ttlDays: 0 }).token,
		).toMatch(/^ct1\./);
		expect(retentionDays('P3D', 1)).toBe(3);
		expect(retentionDays('nope', 1)).toBe(1);
	});
});
