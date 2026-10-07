/**
 * Pure core: codes (patterns, unbiased generation), limits (claims, velocity, blocklist), links, CSV, money, reports,
 * views and merge patch, configuration, rules and request validation.
 */
import { describe, expect, it } from 'vitest';
import {
	byteReader,
	drawCode,
	entropyBits,
	isValidAlphabet,
	isValidCode,
	normaliseCode,
	parsePattern,
	unbiasedIndex,
} from '../core/codes.js';
import { defaultsOf, effectiveConfig } from '../core/config.js';
import { csvCell, toCsv } from '../core/csv.js';
import { claimRefusal, claimsFor, isBlocked, parseClaimKey, velocitySubject, windowStart } from '../core/limits.js';
import { codeFromUrl, shareLink } from '../core/links.js';
import { formatMoney, minorDigits } from '../core/money.js';
import { reportWindow, summarise } from '../core/report.js';
import { checkCondition, compileCondition, conditionMatches, RULE_ROOTS } from '../core/rules.js';
import {
	checkFields,
	validateAction,
	validateBlock,
	validateCart,
	validateCodePatch,
	validateCondition,
	validateCoupon,
	validateEligibilityCheck,
	validateGenerate,
	validateQuote,
	validateRedeem,
	validateRelease,
	validateReservation,
	validateShareLink,
	validateValidation,
} from '../core/validate.js';
import { codeView, couponView, editableOf, mergePatch, reservationView } from '../core/views.js';

const codes = (/** @type {Array<{ path: string, code: string }>} */ problems) => problems.map((p) => `${p.path}:${p.code}`);
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

describe('codes', () => {
	it('normalises and validates codes', () => {
		expect(normaliseCode('  fall10 ', { caseSensitive: false })).toBe('FALL10');
		expect(normaliseCode(' Fall10 ', { caseSensitive: true })).toBe('Fall10');
		expect(normaliseCode(42, { caseSensitive: false })).toBe('');
		expect(isValidCode('FALL-10_X', { minLength: 4, maxLength: 32 })).toBe(true);
		expect(isValidCode('-FALL', { minLength: 4, maxLength: 32 })).toBe(false);
		expect(isValidCode('ABC', { minLength: 4, maxLength: 32 })).toBe(false);
		expect(isValidCode('A B C D', { minLength: 4, maxLength: 32 })).toBe(false);
	});

	it('parses patterns and measures their entropy', () => {
		const parsed = parsePattern('VIP-????-##', { maxLength: 32, minRandom: 6 });
		expect(parsed).toMatchObject({ ok: true, random: 4, digits: 2 });
		if (!parsed.ok) throw new Error();
		expect(entropyBits(parsed, 32)).toBeCloseTo(20 + 2 * Math.log2(10), 5);
		expect(parsePattern('AB-??', { maxLength: 32, minRandom: 6 })).toEqual({ ok: false, error: 'pattern_too_weak' });
		expect(parsePattern('????????', { maxLength: 4, minRandom: 1 })).toEqual({ ok: false, error: 'pattern_too_long' });
		expect(parsePattern('??*??', { maxLength: 32, minRandom: 1 })).toEqual({ ok: false, error: 'pattern_invalid' });
		expect(parsePattern('-????', { maxLength: 32, minRandom: 1 })).toEqual({ ok: false, error: 'pattern_invalid' });
		expect(parsePattern('', { maxLength: 32, minRandom: 1 })).toEqual({ ok: false, error: 'pattern_invalid' });
	});

	it('draws codes with rejection sampling (uniform over the alphabet)', () => {
		const parsed = parsePattern('X-??##', { maxLength: 32, minRandom: 4 });
		if (!parsed.ok) throw new Error();
		const bytes = [255, 0, 31, 250, 9, 3]; // 255 and 250 are rejected for a 31-letter alphabet (limit 248)
		let i = 0;
		expect(drawCode(parsed, ALPHABET, () => /** @type {number} */ (bytes[i++]))).toBe('X-AA93');
		expect(() => unbiasedIndex(0, () => 0)).toThrow(RangeError);
		// every index is equally likely over all byte values
		const counts = new Array(10).fill(0);
		for (let b = 0; b < 256; b += 1) {
			let sent = false;
			const index = unbiasedIndex(10, () => {
				if (sent) return 0;
				sent = true;
				return b;
			});
			if (b < 250) counts[index] += 1;
		}
		expect(new Set(counts)).toEqual(new Set([25]));
		let calls = 0;
		const read = byteReader((n) => {
			calls += 1;
			return new Uint8Array(n).fill(calls);
		}, 2);
		expect([read(), read(), read()]).toEqual([1, 1, 2]);
		expect(isValidAlphabet(ALPHABET)).toBe(true);
		expect(isValidAlphabet('AABBCCDDEEFF')).toBe(false);
		expect(isValidAlphabet('ABC')).toBe(false);
	});
});

describe('limits', () => {
	const coupon = { id: 'cpn_1', limits: { total: 10, per_customer: 2, per_device: 1 } };
	const code = { code: 'ONE', maxUses: 1 };
	const hash = (/** @type {string} */ v) => `h(${v})`;

	it('derives the claims of a code', () => {
		expect(claimsFor({ coupon, code, customerId: 'cus_1', deviceId: 'dev_1', defaultPerCustomer: 0, hash })).toEqual([
			{ kind: 'code', key: 'code:ONE', couponId: 'cpn_1', code: 'ONE', max: 1 },
			{ kind: 'coupon', key: 'coupon:cpn_1', couponId: 'cpn_1', code: 'ONE', max: 10 },
			{ kind: 'customer', key: 'customer:cpn_1:h(cus_1)', couponId: 'cpn_1', code: 'ONE', max: 2, subject: 'cus_1' },
			{ kind: 'device', key: 'device:cpn_1:h(dev_1)', couponId: 'cpn_1', code: 'ONE', max: 1, subject: 'dev_1' },
		]);
		const unlimited = claimsFor({
			coupon: { id: 'c', limits: {} },
			code: { code: 'X' },
			customerId: 'cus',
			deviceId: null,
			defaultPerCustomer: 3,
			hash,
		});
		expect(unlimited.map((claim) => [claim.kind, claim.max])).toEqual([
			['code', null],
			['coupon', null],
			['customer', 3],
		]);
		expect(
			claimsFor({ coupon: { id: 'c' }, code: { code: 'X' }, customerId: null, deviceId: 'd', defaultPerCustomer: 3, hash }),
		).toHaveLength(2);
		expect([claimRefusal('code'), claimRefusal('coupon'), claimRefusal('customer'), claimRefusal('device')]).toEqual([
			'exhausted',
			'exhausted',
			'customer_limit_reached',
			'device_limit_reached',
		]);
		expect(parseClaimKey('code:A-1')).toEqual({ kind: 'code', couponId: null, code: 'A-1', hashed: null });
		expect(parseClaimKey('coupon:cpn_1')).toEqual({ kind: 'coupon', couponId: 'cpn_1', code: null, hashed: null });
		expect(parseClaimKey('customer:cpn_1:abc')).toEqual({ kind: 'customer', couponId: 'cpn_1', code: null, hashed: 'abc' });
	});

	it('picks velocity subjects, windows and blocks', () => {
		expect(velocitySubject({ customerId: 'c', deviceId: 'd', address: 'a' })).toBe('c:c');
		expect(velocitySubject({ customerId: null, deviceId: 'd', address: 'a' })).toBe('d:d');
		expect(velocitySubject({ customerId: null, deviceId: null, address: 'a' })).toBe('a:a');
		expect(velocitySubject({ customerId: null, deviceId: null, address: null })).toBeNull();
		expect(windowStart(Date.parse('2026-10-01T10:07:30Z'), 15)).toBe(Date.parse('2026-10-01T10:00:00Z'));
		expect(windowStart(1000, 0)).toBe(0);
		const blocks = [
			{ kind: 'email', value: 'x@y.z' },
			{ kind: 'code', value: 'BAD' },
		];
		expect(isBlocked(blocks, { customerId: null, email: 'x@y.z', deviceId: null, code: null })).toBe(true);
		expect(isBlocked(blocks, { customerId: null, email: null, deviceId: null, code: 'BAD' })).toBe(true);
		expect(isBlocked(blocks, { customerId: 'c', email: null, deviceId: 'd', code: 'OK' })).toBe(false);
		expect(
			isBlocked(
				[
					{ kind: 'customer', value: 'c' },
					{ kind: 'device', value: 'd' },
				],
				{ customerId: null, email: null, deviceId: 'd', code: null },
			),
		).toBe(true);
	});
});

describe('links, CSV and money', () => {
	it('builds share links on the website domain and reads auto-apply codes', () => {
		expect(
			shareLink({
				domain: 'shop.example.com',
				path: '/sale?x=1',
				param: 'coupon',
				code: 'A B',
				utm: { source: 'nl', medium: '' },
			}),
		).toBe('https://shop.example.com/sale?x=1&coupon=A+B&utm_source=nl');
		expect(shareLink({ domain: 'localhost', path: '/', param: 'coupon', code: 'A' })).toBeNull();
		expect(shareLink({ domain: 'shop.example.com', path: '//evil.com', param: 'coupon', code: 'A' })).toBeNull();
		expect(shareLink({ domain: 'shop.example.com', path: 'x', param: 'coupon', code: 'A' })).toBeNull();
		expect(shareLink({ domain: 'shop.example.com', path: '/', param: 'Bad-Param', code: 'A' })).toBeNull();
		expect(shareLink({ domain: 'shop.example.com', path: '/\\evil.com', param: 'coupon', code: 'A' })).toBeNull();
		expect(codeFromUrl('https://shop.example.com/?coupon=%20fall10%20', 'coupon')).toBe('fall10');
		expect(codeFromUrl('?promo=X1', 'promo')).toBe('X1');
		expect(codeFromUrl('https://shop.example.com/', 'coupon')).toBeNull();
		expect(codeFromUrl('not a url', 'coupon')).toBeNull();
		expect(codeFromUrl(undefined, 'coupon')).toBeNull();
		expect(codeFromUrl('?coupon=X', 'BAD')).toBeNull();
	});

	it('writes RFC 4180 CSV with formula injection neutralised', () => {
		expect(csvCell('plain')).toBe('plain');
		expect(csvCell('a,b')).toBe('"a,b"');
		expect(csvCell('say "hi"')).toBe('"say ""hi"""');
		expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
		expect(csvCell('-1')).toBe("'-1");
		expect(csvCell(null)).toBe('');
		expect(csvCell(3)).toBe('3');
		expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
		expect(toCsv(['a', 'b'], [{ a: 1, b: 'x' }, { a: 2 }])).toBe('a,b\r\n1,x\r\n2,\r\n');
	});

	it('formats minor units with the currency’s own digits', () => {
		expect(minorDigits('EUR')).toBe(2);
		expect(minorDigits('JPY')).toBe(0);
		expect(minorDigits('KWD')).toBe(3);
		expect(formatMoney(1250, 'EUR', 'en')).toBe('€12.50');
		expect(formatMoney(1250, 'JPY', 'en')).toBe('¥1,250');
		expect(formatMoney(1250, 'EUR', 'de')).toMatch(/12,50/);
		expect(formatMoney(1250, 'EUR', 'not-a-locale-!!')).toBe('€12.50');
		expect(formatMoney(1250, 'XXXX')).toBe('12.50 XXXX');
	});
});

describe('reports and views', () => {
	it('summarises per currency and ranks codes', () => {
		const report = summarise({
			from: 'a',
			to: 'b',
			orders: [
				{ currency: 'USD', count: 1, discount: 100, revenue: 900 },
				{ currency: 'EUR', count: 0, discount: 0, revenue: 0 },
			],
			codes: [
				{ couponId: 'c1', code: 'B', currency: 'USD', redemptions: 1, discount: 100 },
				{ couponId: 'c1', code: 'A', currency: 'USD', redemptions: 1, discount: 100 },
				{ couponId: 'c2', code: 'C', currency: 'USD', redemptions: 3, discount: 10 },
			],
			released: 2,
			top: 2,
		});
		expect(report.currencies).toEqual([
			{ currency: 'EUR', orders: 0, discount: 0, revenue: 0, averageOrder: 0, discountRate: 0 },
			{ currency: 'USD', orders: 1, discount: 100, revenue: 900, averageOrder: 900, discountRate: 10 },
		]);
		expect(report.topCodes.map((row) => row.code)).toEqual(['C', 'A']);
		expect(report.coupons).toEqual(
			[
				{ couponId: 'c1', redemptions: 2, codes: 2 },
				{ couponId: 'c2', redemptions: 3, codes: 1 },
			].sort((a, b) => b.redemptions - a.redemptions),
		);
		expect(report).toMatchObject({ redemptions: 5, orders: 1, released: 2 });
		const now = Date.parse('2026-10-31T00:00:00Z');
		expect(reportWindow({ now, days: 30 })).toEqual({ from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T00:00:00.000Z' });
		expect(reportWindow({ from: '2026-10-02', to: '2026-10-01', now, days: 1 })).toBeNull();
		expect(reportWindow({ from: 'nope', now, days: 1 })).toBeNull();
	});

	it('shapes public views and merges patches (RFC 7386)', () => {
		expect(mergePatch({ a: 1, b: { c: 2, d: 3 } }, { b: { c: null, e: 4 }, f: [1] })).toEqual({
			a: 1,
			b: { d: 3, e: 4 },
			f: [1],
		});
		expect(mergePatch({ a: 1 }, 'x')).toBe('x');
		expect(mergePatch(null, { a: { b: 1 } })).toEqual({ a: { b: 1 } });
		const stored = {
			id: 'cpn_1',
			name: 'N',
			status: 'active',
			mode: 'shared',
			action: { type: 'percent', percent: 5 },
			currency: null,
			createdAt: new Date(0),
			websiteId: 'w',
		};
		expect(editableOf(stored)).toEqual({ name: 'N', status: 'active', action: { type: 'percent', percent: 5 } });
		expect(couponView(stored)).toMatchObject({
			id: 'cpn_1',
			description: '',
			codes: 0,
			usage: { taken: 0, redeemed: 0 },
			createdAt: '1970-01-01T00:00:00.000Z',
			archivedAt: null,
		});
		expect(couponView(stored)).not.toHaveProperty('websiteId');
		expect(codeView({ code: 'A', couponId: 'c', status: 'active', maxUses: 3, taken: 1 })).toMatchObject({
			remaining: 2,
			redeemed: 0,
			createdAt: null,
		});
		expect(
			reservationView({
				id: 'r',
				status: 'reserved',
				coupons: [{ couponId: 'c', code: 'A', discount: 1 }],
				cart: { currency: 'EUR' },
			}),
		).toMatchObject({
			codes: ['A'],
			currency: 'EUR',
			loyaltyAllowed: true,
			coupons: [{ couponId: 'c', code: 'A', discount: 1, gifts: [], lines: [] }],
		});
	});
});

describe('configuration and rules', () => {
	it('overlays entitlement values of the right type on schema defaults', () => {
		const schema = {
			properties: {
				n: { type: 'integer', default: 1 },
				f: { type: 'number', default: 0.5 },
				s: { type: 'string', default: 'x' },
				b: { type: 'boolean', default: false },
				a: { type: 'array', default: [1] },
				o: { type: 'object', default: { k: 1 } },
				any: { default: null },
			},
		};
		expect(defaultsOf(schema)).toEqual({ n: 1, f: 0.5, s: 'x', b: false, a: [1], o: { k: 1 }, any: null });
		expect(effectiveConfig(schema, { n: 2.5, f: 2, s: 3, b: true, a: [2], o: [], any: 'y', extra: 1 })).toEqual({
			n: 1,
			f: 2,
			s: 'x',
			b: true,
			a: [2],
			o: { k: 1 },
			any: 'y',
		});
		expect(effectiveConfig({}, null)).toEqual({});
	});

	it('compiles (cached), checks and evaluates rules@1 conditions', () => {
		expect(compileCondition('')).toEqual({ ok: true, program: null });
		const first = compileCondition('cart.subtotal > 1');
		expect(compileCondition('cart.subtotal > 1')).toBe(first);
		for (let i = 0; i < 510; i += 1) compileCondition(`cart.quantity > ${i}`);
		expect(checkCondition('')).toMatchObject({ ok: true, paths: [] });
		expect(checkCondition('order.total > 1').warnings[0]).toMatchObject({ code: 'unknown_identifier' });
		expect(RULE_ROOTS).toContain('cart');
		expect(conditionMatches('', {}, { now: 0, timeZone: 'UTC' })).toEqual({ matched: true, error: null });
		expect(conditionMatches('cart.x >', {}, { now: 0, timeZone: 'UTC' })).toEqual({ matched: false, error: 'syntax' });
		expect(
			conditionMatches("between(now, '09:00', '17:00')", {}, { now: Date.parse('2026-10-01T10:00:00Z'), timeZone: 'UTC' })
				.matched,
		).toBe(true);
		expect(conditionMatches('cart.subtotal', { cart: { subtotal: 5 } }, { now: 0, timeZone: 'UTC' }).matched).toBe(true);
		expect(conditionMatches("dateParts(now, 'Bad/Zone').weekday == 1", {}, { now: 0, timeZone: 'Nope/Zone' }).matched).toBe(
			false,
		);
	});
});

describe('request validation', () => {
	const rules = {
		code: { minLength: 4, maxLength: 32 },
		minRandom: 6,
		maxCodesPerBatch: 100,
		allowedTypes: ['percent', 'fixed', 'free_shipping', 'bxgy', 'tiered', 'gift'],
		maxPercent: 50,
		maxFixedAmount: 10_000,
		maxTiers: 2,
		maxConditions: 3,
		allowRules: true,
		maxRuleLength: 100,
		classes: ['item', 'order'],
	};

	it('validates carts', () => {
		const good = {
			currency: 'EUR',
			lines: [{ itemId: 'i', quantity: 1, unitAmount: 0, attributes: { size: 'M', tags: ['a'] }, collections: ['c'] }],
			shipping: 0,
			customer: { id: 'c', orderCount: 0, segments: ['vip'], email: 'a@b.c', country: 'DE' },
			paymentMethod: 'card',
			deliveryMethod: 'pickup',
			context: { country: 'DE', device: 'mobile', source: 'ads', deviceId: 'dev' },
		};
		expect(validateCart(good, { maxLines: 5 })).toEqual([]);
		expect(codes(validateCart({ currency: 'eur', lines: 'x' }, { maxLines: 5 }))).toEqual([
			'/cart/currency:currency_invalid',
			'/cart/lines:lines_invalid',
		]);
		expect(
			codes(
				validateCart(
					{ currency: 'EUR', lines: [{ itemId: 'a b', quantity: 0, unitAmount: -1, attributes: { k: 5 } }] },
					{ maxLines: 5 },
				),
			),
		).toEqual([
			'/cart/lines/0/itemId:id_invalid',
			'/cart/lines/0/quantity:integer_invalid',
			'/cart/lines/0/unitAmount:integer_invalid',
			'/cart/lines/0/attributes/k:attribute_invalid',
		]);
		expect(
			codes(
				validateCart(
					{
						currency: 'EUR',
						lines: [
							{ itemId: 'a', quantity: 1, unitAmount: 1, lineId: 'x' },
							{ itemId: 'b', quantity: 1, unitAmount: 1, lineId: 'x' },
						],
					},
					{ maxLines: 5 },
				),
			),
		).toEqual(['/cart/lines:duplicate_line_id']);
		expect(
			codes(
				validateCart(
					{
						currency: 'EUR',
						lines: [],
						customer: { email: 'nope', country: 'de' },
						context: { country: 'x', source: '' },
						extra: 1,
					},
					{ maxLines: 5 },
				),
			),
		).toEqual([
			'/cart/extra:unknown_field',
			'/cart/customer/email:email_invalid',
			'/cart/customer/country:country_invalid',
			'/cart/context/country:country_invalid',
			'/cart/context/source:text_invalid',
		]);
		expect(codes(validateCart({ currency: 'EUR', lines: [{}, {}] }, { maxLines: 1 }))).toEqual(['/cart/lines:lines_invalid']);
		expect(codes(validateCart({ currency: 'EUR', lines: [], customer: 'x' }, { maxLines: 1 }))).toEqual([
			'/cart/customer:object_invalid',
		]);
		expect(
			codes(
				validateCart(
					{ currency: 'EUR', lines: [{ itemId: 'a', quantity: 1, unitAmount: 1, attributes: [] }] },
					{ maxLines: 1 },
				),
			),
		).toEqual(['/cart/lines/0/attributes:object_invalid']);
		expect(checkFields(null, {}, [])).toEqual([{ path: '', code: 'body_invalid' }]);
	});

	it('validates conditions', () => {
		const ok = (/** @type {unknown} */ c) => validateCondition(c, '/c');
		expect(ok({ type: 'items', operator: 'in', value: ['a'] })).toEqual([]);
		expect(ok({ type: 'attributes', operator: 'not_in', value: { key: 'k', values: ['v'] } })).toEqual([]);
		expect(ok({ type: 'subtotal', operator: 'between', value: [1, 2] })).toEqual([]);
		expect(ok({ type: 'first_order', operator: 'eq', value: false })).toEqual([]);
		expect(ok({ type: 'group', operator: 'or', value: [{ type: 'country', operator: 'in', value: ['DE'] }] })).toEqual([]);
		expect(codes(ok('x'))).toEqual(['/c:condition_invalid']);
		expect(codes(ok({ type: 'nope', operator: 'in', value: [] }))).toEqual(['/c/type:enum_invalid']);
		expect(codes(ok({ type: 'items', operator: 'gte', value: ['a'] }))).toEqual(['/c/operator:operator_invalid']);
		expect(codes(ok({ type: 'items', operator: 'in', value: [] }))).toEqual(['/c/value:list_invalid']);
		expect(codes(ok({ type: 'subtotal', operator: 'between', value: [2, 1] }))).toEqual(['/c/value:range_invalid']);
		expect(codes(ok({ type: 'subtotal', operator: 'gte', value: -1 }))).toEqual(['/c/value:integer_invalid']);
		expect(codes(ok({ type: 'subtotal', operator: 'in', value: 1 }))).toEqual(['/c/operator:operator_invalid']);
		expect(codes(ok({ type: 'first_order', operator: 'in', value: true }))).toEqual(['/c/operator:operator_invalid']);
		expect(codes(ok({ type: 'first_order', operator: 'eq', value: 'yes' }))).toEqual(['/c/value:boolean_invalid']);
		expect(codes(ok({ type: 'attributes', operator: 'in', value: { key: 'k' } }))).toEqual(['/c/value:attribute_invalid']);
		expect(codes(ok({ type: 'attributes', operator: 'in', value: 'k' }))).toEqual(['/c/value:attribute_invalid']);
		expect(codes(ok({ type: 'group', operator: 'not', value: [] }))).toEqual(['/c/operator:operator_invalid']);
		expect(codes(ok({ type: 'group', operator: 'and', value: [] }))).toEqual(['/c/value:group_invalid']);
		const deep = {
			type: 'group',
			operator: 'and',
			value: [
				{
					type: 'group',
					operator: 'and',
					value: [{ type: 'group', operator: 'and', value: [{ type: 'items', operator: 'in', value: ['a'] }] }],
				},
			],
		};
		expect(codes(ok(deep))).toEqual(['/c/value/0/value/0/value:group_too_deep']);
		expect(codes(ok({ type: 'items', operator: 'in' }))).toEqual(['/c/value:required']);
	});

	it('validates actions within the website’s bounds', () => {
		const action = (/** @type {unknown} */ a) => codes(validateAction(a, '/action', rules));
		expect(action({ type: 'percent', percent: 50, target: 'order', max_discount: 100 })).toEqual([]);
		expect(action({ type: 'percent', percent: 51 })).toEqual(['/action/percent:percent_invalid']);
		expect(action({ type: 'fixed', amount: 10_001 })).toEqual(['/action/amount:above_maximum']);
		expect(action({ type: 'fixed', amount: 0, per_unit: 'yes' })).toEqual([
			'/action/amount:integer_invalid',
			'/action/per_unit:boolean_invalid',
		]);
		expect(action({ type: 'free_shipping', max_amount: 10 })).toEqual([]);
		expect(action({ type: 'bxgy', buy: 2, get: 1, percent: 50, max_applications: 3 })).toEqual([]);
		expect(action({ type: 'bxgy', buy: 0 })).toEqual(['/action/buy:integer_invalid', '/action/get:required']);
		expect(
			action({
				type: 'tiered',
				basis: 'quantity',
				tiers: [
					{ min: 2, percent: 5 },
					{ min: 5, amount: 100 },
				],
			}),
		).toEqual([]);
		expect(action({ type: 'tiered', basis: 'quantity', tiers: [{ min: 2, percent: 5, amount: 1 }] })).toEqual([
			'/action/tiers/0:percent_or_amount',
		]);
		expect(
			action({
				type: 'tiered',
				basis: 'quantity',
				tiers: [
					{ min: 2, percent: 5 },
					{ min: 2, percent: 6 },
				],
			}),
		).toEqual(['/action/tiers:duplicate_min']);
		expect(action({ type: 'tiered', basis: 'x', tiers: [] })).toEqual([
			'/action/basis:enum_invalid',
			'/action/tiers:tiers_invalid',
		]);
		expect(action({ type: 'tiered', basis: 'quantity', tiers: [{ min: -1 }] })).toEqual([
			'/action/tiers/0/min:integer_invalid',
		]);
		expect(action({ type: 'gift', item_id: 'itm', quantity: 1, discount_in_cart: true })).toEqual([]);
		expect(action({ type: 'gift' })).toEqual(['/action/item_id:required']);
		expect(action({ type: 'nope' })).toEqual(['/action/type:enum_invalid']);
		expect(action('x')).toEqual(['/action:object_invalid']);
		expect(codes(validateAction({ type: 'gift', item_id: 'x' }, '/action', { ...rules, allowedTypes: ['percent'] }))).toEqual([
			'/action/type:type_not_allowed',
		]);
	});

	it('validates coupons (create and update)', () => {
		const base = { name: 'N', action: { type: 'percent', percent: 5 } };
		expect(
			validateCoupon({ ...base, code: 'GOOD1', description: '', status: 'paused', currency: null, custom: { a: 1 } }, rules),
		).toEqual([]);
		expect(codes(validateCoupon({ ...base, code: 'x' }, rules))).toEqual(['/code:code_invalid']);
		expect(codes(validateCoupon({ ...base, code: 5 }, rules))).toEqual(['/code:code_invalid']);
		expect(codes(validateCoupon({ ...base, pattern: '', count: 101 }, rules))).toEqual([
			'/pattern:pattern_invalid',
			'/count:integer_invalid',
		]);
		expect(codes(validateCoupon({ ...base, code: 'GOOD1', pattern: '????' }, rules))).toEqual(['/pattern:conflicts_with_code']);
		expect(codes(validateCoupon({ ...base, status: 'archived' }, rules))).toEqual(['/status:enum_invalid']);
		expect(validateCoupon({ ...base, status: 'archived' }, rules, { mode: 'update' })).toEqual([]);
		expect(codes(validateCoupon({ ...base, code: 'GOOD1' }, rules, { mode: 'update' }))).toEqual(['/code:unknown_field']);
		expect(codes(validateCoupon({ ...base, eligibility: { when: 'x'.repeat(101) } }, rules))).toEqual([
			'/eligibility/when:text_invalid',
		]);
		expect(
			codes(validateCoupon({ ...base, eligibility: { when: 'cart.subtotal > 1' } }, { ...rules, allowRules: false })),
		).toEqual(['/eligibility/when:rules_not_allowed']);
		expect(validateCoupon({ ...base, eligibility: { when: '  ' } }, { ...rules, allowRules: false })).toEqual([]);
		expect(codes(validateCoupon({ ...base, eligibility: { conditions: 'x' } }, rules))).toEqual([
			'/eligibility/conditions:list_invalid',
		]);
		const many = Array.from({ length: 4 }, () => ({ type: 'items', operator: 'in', value: ['a'] }));
		expect(codes(validateCoupon({ ...base, eligibility: { conditions: many } }, rules))).toEqual([
			'/eligibility/conditions:too_many_conditions',
		]);
		expect(
			codes(
				validateCoupon({ ...base, eligibility: { conditions: [{ type: 'subtotal', operator: 'gte', value: 1 }] } }, rules),
			),
		).toEqual(['/currency:required']);
		expect(
			codes(validateCoupon({ ...base, limits: { total: 0, per_customer: null, per_device: 1.5, per_code: 1 } }, rules)),
		).toEqual(['/limits/total:integer_invalid', '/limits/per_device:integer_invalid']);
		expect(
			codes(
				validateCoupon(
					{ ...base, stacking: { class: 'shipping', exclusive: 1, priority: 5000, with_loyalty: 'x', with_deals: true } },
					rules,
				),
			),
		).toEqual([
			'/stacking/class:class_invalid',
			'/stacking/exclusive:boolean_invalid',
			'/stacking/priority:integer_invalid',
			'/stacking/with_loyalty:boolean_invalid',
		]);
		expect(validateCoupon({ ...base, stacking: { class: 'anything' } }, { ...rules, classes: [] })).toEqual([]);
		expect(
			codes(
				validateCoupon(
					{
						...base,
						validity: {
							starts_at: '2026-10-02',
							ends_at: '2026-10-01',
							time_zone: 'Europe/Berlin',
							windows: [{ days: ['mon'], start: '22:00', end: '02:00' }],
						},
					},
					rules,
				),
			),
		).toEqual(['/validity/ends_at:before_start']);
		expect(
			codes(
				validateCoupon(
					{
						...base,
						validity: {
							starts_at: 'x',
							time_zone: 'Bad/Zone',
							windows: [{ days: ['funday'], start: '24:00', end: '25:00' }],
						},
					},
					rules,
				),
			),
		).toEqual([
			'/validity/starts_at:date_invalid',
			'/validity/time_zone:time_zone_invalid',
			'/validity/windows/0/days:list_invalid',
			'/validity/windows/0/start:clock_invalid',
			'/validity/windows/0/end:clock_invalid',
		]);
		expect(
			codes(validateCoupon({ ...base, validity: { windows: 'x' }, custom: [], description: 5, currency: 'eur' }, rules)),
		).toEqual([
			'/description:text_invalid',
			'/currency:currency_invalid',
			'/validity/windows:list_invalid',
			'/custom:object_invalid',
		]);
		expect(codes(validateCoupon({}, rules))).toEqual(['/name:required', '/action:required']);
	});

	it('validates the other request bodies', () => {
		const cart = { currency: 'EUR', lines: [] };
		const r = { maxLines: 5, maxCodes: 2 };
		expect(validateGenerate({ count: 5, pattern: '????' }, { maxCodesPerBatch: 10, maxLength: 32 })).toEqual([]);
		expect(codes(validateGenerate({ count: 11, pattern: '' }, { maxCodesPerBatch: 10, maxLength: 32 }))).toEqual([
			'/count:integer_invalid',
			'/pattern:pattern_invalid',
		]);
		expect(validateCodePatch({ status: 'disabled' })).toEqual([]);
		expect(validateValidation({ code: 'X', cart }, r)).toEqual([]);
		expect(codes(validateValidation({ code: ' ', cart }, r))).toEqual(['/code:code_invalid']);
		expect(codes(validateQuote({ codes: ['A', 'B', 'C'], cart }, r))).toEqual(['/codes:codes_invalid']);
		expect(validateReservation({ codes: ['A'], cart, orderId: 'o', reference: 'r' }, r)).toEqual([]);
		expect(validateRedeem(undefined)).toEqual([]);
		expect(codes(validateRedeem({ orderId: 'a b' }))).toEqual(['/orderId:id_invalid']);
		expect(validateRelease(null)).toEqual([]);
		expect(codes(validateRelease({ reason: '' }))).toEqual(['/reason:text_invalid']);
		expect(validateBlock({ kind: 'code', value: 'X', note: 'n' })).toEqual([]);
		expect(codes(validateBlock({ kind: 'ip', value: '' }))).toEqual(['/kind:enum_invalid', '/value:text_invalid']);
		expect(validateShareLink({ code: 'X', path: '/a', campaign: 'c-1' })).toEqual([]);
		expect(codes(validateShareLink({ code: '', path: 'a', campaign: 'c 1' }))).toEqual([
			'/code:code_invalid',
			'/path:path_invalid',
			'/campaign:token_invalid',
		]);
		const checkRules = { maxLines: 5, maxConditions: 1, maxRuleLength: 10 };
		expect(validateEligibilityCheck({ when: 'x', conditions: [], cart }, checkRules)).toEqual([]);
		expect(codes(validateEligibilityCheck({ when: 'x'.repeat(11), conditions: [{}] }, checkRules))).toEqual([
			'/when:text_invalid',
			'/conditions/0/type:required',
			'/conditions/0/operator:required',
			'/conditions/0/value:required',
		]);
		const two = [
			{ type: 'items', operator: 'in', value: ['a'] },
			{ type: 'items', operator: 'in', value: ['b'] },
		];
		expect(codes(validateEligibilityCheck({ conditions: two }, checkRules))).toEqual(['/conditions:too_many_conditions']);
		expect(codes(validateEligibilityCheck({ conditions: 'x' }, checkRules))).toEqual(['/conditions:list_invalid']);
	});
});
