/** Pure core: plain inputs, plain outputs. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanText, fill, httpsUrl, idList, isNil, normalizeEmail, normalizePhone, phoneMatchKey } from '../core/text.js';
import { amountFor, exponentOf, formatMajor, formatMoney, parseMajor } from '../core/money.js';
import {
	checkMove,
	confirmMoveOf,
	createMatrix,
	customerCancelMove,
	expiryOf,
	initialStatus,
	isPayOnDelivery,
	isRevenue,
	nextStatuses,
	openStatuses,
	revenueStatuses,
} from '../core/lifecycle.js';
import {
	customerKeys,
	customerRef,
	eventContext,
	formatNumber,
	ownerView,
	placedToInput,
	validateOrder,
} from '../core/orders.js';
import { applyMapping, getPath, mappingsOf, segments } from '../core/mapping.js';
import { applyFulfilment, carriersOf, safeTemplate, trackingUrl } from '../core/fulfilment.js';
import {
	applySerials,
	isLuhnValid,
	lineNeedsSerials,
	missingSerials,
	rulesOf,
	validateLineSerials,
	validateSerial,
} from '../core/serials.js';
import { methodsOf, netRevenue, summarize, validateEntry } from '../core/ledger.js';
import { codAdvance, evaluateRisk, isRtoFlagged } from '../core/risk.js';
import { catalogFor, pickChannel, pickTemplate, renderMessage } from '../core/messages.js';
import {
	addressLine,
	esc,
	formatDate,
	invoiceHtml,
	packingSlipsHtml,
	pickListHtml,
	pickRows,
	serialSlots,
	warrantyText,
} from '../core/documents.js';
import { customerView, trackingOf } from '../core/views.js';
import { exportCell, importRows } from '../core/bulk.js';
import { parseCsv, recordsOf, toCsv } from '../core/csv.js';
import { defaultsOf, effectiveConfig } from '../core/config.js';
import { createTranslator } from '../core/strings.js';
import { maskOf } from '../api/risk.js';
import { filterOf } from '../api/bulk.js';
import { statsOf } from '../api/dashboard.js';
import { settingsFrom } from '../api/settings.js';

const lifecycleSchema = JSON.parse(readFileSync(new URL('../schemas/lifecycle.features.json', import.meta.url), 'utf8'));
const strings = JSON.parse(readFileSync(new URL('../strings/en.json', import.meta.url), 'utf8'));
const matrix = createMatrix(defaultsOf(lifecycleSchema));
const t = createTranslator(strings);

describe('text and money', () => {
	it('cleans, normalises and fills', () => {
		expect(cleanText('  a\nb ', 10)).toBe('a b');
		expect(cleanText('a\r\nb', 10, { multiline: true })).toBe('a\nb');
		expect(cleanText(12, 5)).toBe('12');
		expect(cleanText({}, 5)).toBeNull();
		expect(cleanText('toolong', 3)).toBeNull();
		expect(normalizeEmail('A@B.c')).toBe('a@b.c');
		expect(normalizeEmail('nope')).toBeNull();
		expect(normalizePhone('+44 (20) 7946-0000')).toBe('+442079460000');
		expect(normalizePhone('020 7946')).toBe('0207946');
		expect(normalizePhone('12')).toBeNull();
		expect(normalizePhone(null)).toBeNull();
		expect(phoneMatchKey('+442079460000', 4)).toBe('0000');
		expect(phoneMatchKey('+44', 0)).toBe('44');
		expect(fill('{a} {b} {c}', { a: 1, b: null })).toBe('1  {c}');
		expect(httpsUrl('http://x.example.com')).toBeNull();
		expect(httpsUrl('https://u:p@x.example.com')).toBeNull();
		expect(httpsUrl('not a url')).toBeNull();
		expect(httpsUrl(null)).toBeNull();
		expect(idList('a,b,a, ,', 5)).toEqual(['a', 'b']);
		expect(idList(['a', 'b c'], 5)).toBeNull();
		expect(idList('a,b', 1)).toBeNull();
		expect(idList(3, 1)).toBeNull();
		expect(isNil(undefined)).toBe(true);
	});

	it('handles minor units without assuming a currency', () => {
		expect(exponentOf('JPY')).toBe(0);
		expect(exponentOf(null)).toBe(2);
		expect(exponentOf('XXXX')).toBe(2);
		expect(parseMajor('12.50', 2)).toBe(1250);
		expect(parseMajor(9.99, 2)).toBe(999);
		expect(parseMajor('1.230', 2)).toBe(123);
		expect(parseMajor('1.234', 2)).toBeNull();
		expect(parseMajor('x', 2)).toBeNull();
		expect(parseMajor({}, 2)).toBeNull();
		expect(formatMajor(-5, 2)).toBe('-0.05');
		expect(formatMajor(5, 0)).toBe('5');
		expect(formatMoney(1250, 'EUR', 'en')).toBe('€12.50');
		expect(formatMoney(1250, null, 'en')).toBe('12.50');
		expect(formatMoney(1250, 'ZZZ', 'xx-invalid-locale-%%')).toContain('12.50');
		expect(amountFor([{ currency: 'EUR', amount: 5 }], 'USD')).toBe(0);
	});
});

describe('lifecycle matrix', () => {
	it('normalises the matrix and answers revenue, open and next', () => {
		const custom = createMatrix({
			statuses: [{ key: 'a', revenue: true, label: ' A ' }, { key: 'a' }, { key: 'b', terminal: true }, { key: 'BAD' }],
			transitions: [
				{ from: 'a', to: 'b', actors: ['staff', 'robot'], requires: ['tracking', 'x'], publish: 'weird' },
				{ from: 'a', to: 'b' },
				{ from: 'b', to: 'a' },
				{ from: 'a', to: 'a' },
				{ from: 'a', to: 'zzz' },
			],
			initial_status: 'zzz',
			cod_methods: ['cod', 'BAD'],
		});
		expect(custom.statuses.map((s) => s.key)).toEqual(['a', 'b']);
		expect(custom.statuses[0]?.label).toBe('A');
		expect(custom.transitions).toEqual([
			{ from: 'a', to: 'b', actors: ['staff'], requires: ['tracking'], publish: 'none', reasons: [] },
		]);
		expect(custom.initial.unpaid).toBe('a');
		expect(custom.codMethods).toEqual(['cod']);
		expect(createMatrix({}).initial.unpaid).toBe('pending');
		expect(isRevenue(matrix, 'confirmed')).toBe(true);
		expect(isRevenue(matrix, 'pending_payment')).toBe(false);
		expect(revenueStatuses(matrix)).toEqual(['confirmed', 'packed', 'dispatched', 'delivered']);
		expect(openStatuses(matrix)).toContain('awaiting_confirmation');
		expect(nextStatuses(matrix, 'dispatched')).toEqual(['delivered', 'returned']);
		expect(nextStatuses(matrix, 'delivered', 'customer')).toEqual([]);
	});

	it('checks moves, initial statuses, expiry, cancellation and confirmation', () => {
		const order = { status: 'delivered' };
		expect(checkMove(matrix, order, 'nope', 'staff')).toMatchObject({ ok: false, code: 'unknown_status' });
		expect(checkMove(matrix, order, 'delivered', 'staff')).toMatchObject({ code: 'status_unchanged' });
		expect(checkMove(matrix, order, 'refunded', 'customer')).toMatchObject({ code: 'actor_not_allowed' });
		expect(checkMove(matrix, order, 'refunded', 'staff', { money: { total: 10, paid: 10, refunded: 5 } })).toMatchObject({
			code: 'refund_incomplete',
		});
		expect(checkMove(matrix, order, 'refunded', 'staff', { money: { total: 10, paid: 10, refunded: 10 } }).ok).toBe(true);
		const strict = createMatrix({
			statuses: [{ key: 'a' }, { key: 'b' }],
			transitions: [
				{ from: 'a', to: 'b', actors: ['api'], requires: ['tracking', 'dispatch_video', 'paid_in_full', 'serials'] },
			],
		});
		expect(checkMove(strict, { status: 'a' }, 'b', 'api')).toMatchObject({ code: 'tracking_missing' });
		expect(checkMove(strict, { status: 'a' }, 'b', 'api', { hasTracking: true })).toMatchObject({
			code: 'dispatch_video_missing',
		});
		expect(
			checkMove(strict, { status: 'a' }, 'b', 'api', {
				hasTracking: true,
				hasDispatchVideo: true,
				money: { total: 5, paid: 1, refunded: 0 },
			}),
		).toMatchObject({ code: 'balance_due' });
		expect(
			checkMove(strict, { status: 'a' }, 'b', 'api', {
				hasTracking: true,
				hasDispatchVideo: true,
				money: { total: 5, paid: 5, refunded: 0 },
				missingSerials: ['Phone'],
			}),
		).toMatchObject({ code: 'serials_missing', detail: 'Phone' });
		expect(
			checkMove(
				createMatrix({
					statuses: [{ key: 'a' }, { key: 'b' }],
					transitions: [{ from: 'a', to: 'b', actors: ['api'], requires: ['return_reason'] }],
				}),
				{ status: 'a' },
				'b',
				'api',
				{ reason: 'any' },
			).ok,
		).toBe(true);
		expect(initialStatus(matrix, { paidInFull: true, cod: false, advanceDue: 0 })).toBe('confirmed');
		expect(initialStatus(matrix, { paidInFull: false, cod: true, advanceDue: 0 })).toBe('awaiting_confirmation');
		expect(initialStatus(matrix, { paidInFull: false, cod: true, advanceDue: 10 })).toBe('pending_payment');
		expect(expiryOf(matrix, 'pending_payment', 0)?.to).toBe('cancelled');
		expect(expiryOf(matrix, 'confirmed', 0)).toBeNull();
		expect(
			expiryOf(createMatrix({ statuses: [{ key: 'a', expire_after_hours: 1, expire_to: 'b' }, { key: 'b' }] }), 'a', 0),
		).toBeNull();
		const now = Date.parse('2026-10-01T10:00:00Z');
		expect(
			customerCancelMove(matrix, { status: 'pending_payment', placedAt: new Date(now) }, { now, windowMinutes: 0 })?.to,
		).toBe('cancelled');
		expect(
			customerCancelMove(
				matrix,
				{ status: 'pending_payment', placedAt: new Date(now - 3_600_000) },
				{ now, windowMinutes: 30 },
			),
		).toBeNull();
		expect(customerCancelMove(matrix, { status: 'confirmed', placedAt: new Date(now) }, { now, windowMinutes: 0 })).toBeNull();
		expect(confirmMoveOf(matrix, 'pending_payment')?.to).toBe('confirmed');
		expect(confirmMoveOf(matrix, 'confirmed')).toBeNull();
		expect(confirmMoveOf(matrix, 'packed')).toBeNull();
		expect(isPayOnDelivery(matrix, { payment: { method: 'cod' } })).toBe(true);
		expect(isPayOnDelivery(matrix, { payment: { cod: true } })).toBe(true);
		expect(isPayOnDelivery(matrix, {})).toBe(false);
	});
});

describe('orders', () => {
	const limits = { maxLines: 2, defaultCurrency: 'EUR' };
	it('validates every field of the canonical order', () => {
		expect(validateOrder(null, limits)).toMatchObject({ ok: false });
		const bad = validateOrder(
			{
				id: 'bad id',
				externalId: { x: 1 },
				number: '',
				placedAt: 'never',
				currency: 'eu',
				lang: 'EN_us',
				customer: { customerId: 'bad id', email: 'x', phone: '1' },
				amounts: { discount: -1, shipping: 'x', tax: 1.5, subtotal: -2, total: 'x' },
				taxLines: [
					{ label: '', amount: 1 },
					{ label: 'VAT', amount: 1, rate: {} },
				],
				adjustments: [{ label: 'x', amount: 1.5 }],
				payment: { method: 'Bad Method', status: 'maybe', paidAmount: -1 },
				delivery: { method: 'Bad' },
				custom: { 'bad key': 1 },
				lines: [
					5,
					{
						title: '',
						itemId: 'bad id',
						variantId: 'bad id',
						sku: {},
						quantity: 0,
						unitAmount: -1,
						totalAmount: -1,
						taxAmount: -1,
						warranty: { days: -1 },
						attributes: { ok: { nested: true } },
						imageUrl: 'http://x',
					},
				],
			},
			limits,
		);
		expect(bad.ok).toBe(false);
		const paths = /** @type {any} */ (bad).errors.map((/** @type {any} */ e) => e.path);
		for (const path of [
			'/id',
			'/externalId',
			'/number',
			'/placedAt',
			'/currency',
			'/lang',
			'/customer/customerId',
			'/customer/email',
			'/customer/phone',
			'/amounts/discount',
			'/taxLines/0',
			'/taxLines/1',
			'/adjustments/0',
			'/payment/method',
			'/payment/status',
			'/delivery/method',
			'/custom',
			'/lines/0',
			'/lines/1/title',
			'/lines/1/warranty',
			'/lines/1/imageUrl',
		])
			expect(paths).toContain(path);
		expect(validateOrder({ lines: [{}, {}, {}] }, limits)).toMatchObject({
			ok: false,
			errors: [{ path: '/lines', code: 'too_many_lines' }],
		});
		expect(
			validateOrder(
				{ lines: [{ title: 'x', quantity: 1, unitAmount: 1, warranty: 'x' }], taxLines: 'x', adjustments: 'x' },
				limits,
			).ok,
		).toBe(false);
		expect(validateOrder({ lines: [{ title: 'x', quantity: 1, unitAmount: 1, warranty: { label: '' } }] }, limits).ok).toBe(
			false,
		);
		expect(validateOrder({ lines: [{ title: 'x', quantity: 1000000, unitAmount: Number.MAX_SAFE_INTEGER }] }, limits).ok).toBe(
			false,
		);
	});

	it('computes totals, payment state and the event context', () => {
		const ok = validateOrder(
			{
				customerId: 'cus_1',
				customer: { subject: 'usr_1', name: 'Ada' },
				lang: 'de-CH',
				shipping: { name: 'Ada', phone: '+41 44 000 00 00', city: 'Zürich', nonsense: 'x' },
				billing: {},
				taxLines: [{ label: 'VAT', amount: 100 }],
				adjustments: [{ label: 'Points', amount: -50 }],
				amounts: { shipping: 200, discount: 100, tax: 100 },
				payment: { status: 'paid', reference: 'R' },
				lines: [
					{
						title: 'x',
						sku: 'SKU 1',
						quantity: 2,
						unitAmount: 500,
						attributes: { color: 'red', size: 3, gift: true, empty: '  ' },
						warranty: { label: 'Two years' },
					},
				],
				custom: { note: 'hi' },
			},
			{ maxLines: 5, defaultCurrency: 'CHF' },
		);
		expect(ok.ok).toBe(true);
		const draft = /** @type {any} */ (ok).draft;
		expect(draft.amounts).toEqual({ subtotal: 1000, discount: 100, shipping: 200, tax: 100, total: 1150 });
		expect(draft.payment).toMatchObject({ status: 'paid', paidAmount: 1150 });
		expect(draft.billing).toBeNull();
		expect(draft.lines[0].attributes).toEqual({ color: 'red', size: 3, gift: true });
		const ctx = eventContext({ ...draft, id: 'ord_1', number: '1' });
		expect(ctx.lines).toBeUndefined();
		expect(ctx.customer).toEqual({ customerId: 'cus_1', subject: 'usr_1' });
		expect(customerRef({ customer: null })).toBeNull();
		expect(eventContext({ ...draft, lines: [{ ...draft.lines[0], sku: 'SKU-1', variantId: 'v1' }] }).lines[0]).toMatchObject({
			itemId: 'SKU-1',
			variantId: 'v1',
		});
		expect(customerKeys({ customerId: 'c', subject: 's', email: 'e@x.y', phone: '+1 555 0100' }, 4)).toEqual([
			'c:c',
			's:s',
			'e:e@x.y',
			'p:0100',
		]);
		expect(formatNumber('A-', 7, 3)).toBe('A-007');
		expect(ownerView({ id: 'x', pending: [], _id: 1 })).toEqual({ id: 'x' });
		expect(placedToInput({ orderId: 'o', customerId: 'c', lines: [{ sku: 's', quantity: 1, unitAmount: 1 }] })).toMatchObject({
			id: 'o',
			customer: { customerId: 'c' },
			lines: [{ title: 's' }],
		});
		expect(placedToInput({ orderId: 'o', lines: 'x' }).lines).toBe('x');
	});
});

describe('mapping', () => {
	it('reads safe paths and converts values', () => {
		expect(segments('a.__proto__')).toBeNull();
		expect(segments('')).toBeNull();
		expect(getPath({ a: [{ b: 1 }] }, 'a[0].b')).toBe(1);
		expect(getPath({ a: 1 }, 'a.b')).toBeUndefined();
		expect(getPath({}, 'constructor')).toBeUndefined();
		const [mapping] = mappingsOf([
			{
				key: 'm',
				lines_path: 'items',
				fields: [
					{ target: 'number', source: 'n' },
					{ target: 'nope', source: 'x' },
					{ target: 'payment.cod', source: 'cod' },
					{ target: 'amounts.total', source: 't' },
				],
				line_fields: [
					{ target: 'quantity', source: 'q' },
					{ target: 'unitAmount', source: 'p' },
					{ target: 'serialRequired', source: 's' },
					{ target: 'attributes.x', source: 'x' },
					{ target: 'bad', source: 'b' },
				],
			},
			{ nope: true },
		]);
		expect(mapping?.fields).toHaveLength(3);
		expect(mapping?.amounts).toBe('minor');
		const result = applyMapping(
			{ n: 'A1', cod: 'true', t: '100', items: [{ q: '2', p: 50, s: 1, x: 'y' }] },
			/** @type {any} */ (mapping),
		);
		expect(result).toEqual({
			ok: true,
			input: {
				number: 'A1',
				payment: { cod: true },
				amounts: { total: 100 },
				lines: [{ quantity: 2, unitAmount: 50, serialRequired: true, attributes: { x: 'y' } }],
			},
		});
		expect(applyMapping('x', /** @type {any} */ (mapping)).ok).toBe(false);
		expect(applyMapping({ n: { o: 1 }, t: -1, items: [{ q: 'x' }] }, /** @type {any} */ (mapping))).toMatchObject({
			ok: false,
		});
		expect(applyMapping({ items: 'x' }, /** @type {any} */ (mapping))).toMatchObject({ ok: false });
	});
});

describe('fulfilment', () => {
	const carriers = carriersOf([
		{ key: 'pc', name: 'Parcel', tracking_url_template: 'https://t.example.com/{tracking}', service_levels: ['std', 3] },
		{ key: 'pc', name: 'Dup' },
		{ key: 'no', name: '' },
		{ key: 'bad', name: 'Bad', tracking_url_template: 'http://t.example.com/{tracking}' },
		'x',
	]);
	it('keeps safe carriers and builds links', () => {
		expect(carriers.map((c) => c.key)).toEqual(['pc', 'bad']);
		expect(carriers[0]?.serviceLevels).toEqual(['std']);
		expect(carriers[1]?.template).toBeNull();
		expect(safeTemplate('https://x.example.com/')).toBeNull();
		expect(trackingUrl('https://t.example.com/{tracking}', ' a/b ')).toBe('https://t.example.com/a%2Fb');
		expect(trackingUrl(null, 'a')).toBe('');
	});
	it('applies patches with checks', () => {
		const settings = { carriers, allowOther: false, dispatchVideo: true, maxNote: 20 };
		expect(applyFulfilment(null, 'x', settings).ok).toBe(false);
		expect(applyFulfilment(null, {}, settings)).toMatchObject({ ok: false, errors: [{ code: 'nothing_to_change' }] });
		const full = applyFulfilment(
			null,
			{
				carrier: 'pc',
				serviceLevel: 'std',
				trackingNumber: 'T1',
				dispatchVideoUrl: 'https://v.example.com/1',
				eta: '2026-10-03',
				note: 'fragile',
			},
			settings,
		);
		expect(full).toMatchObject({
			ok: true,
			value: { carrierName: 'Parcel', trackingUrl: 'https://t.example.com/T1', eta: '2026-10-03T00:00:00.000Z' },
		});
		const value = /** @type {any} */ (full).value;
		expect(
			applyFulfilment(
				value,
				{ carrier: null, trackingNumber: null, dispatchVideoUrl: null, eta: null, note: null, serviceLevel: null },
				settings,
			),
		).toMatchObject({ ok: true, value: { carrier: null, trackingUrl: null } });
		const errors = applyFulfilment(
			value,
			{
				carrier: 'zz',
				serviceLevel: 'fast',
				trackingNumber: '',
				dispatchVideoUrl: 'ftp://x',
				eta: 'never',
				note: 'x'.repeat(30),
			},
			settings,
		);
		expect(/** @type {any} */ (errors).errors.map((/** @type {any} */ e) => e.code)).toEqual([
			'carrier_unknown',
			'service_level_unknown',
			'text_invalid',
			'url_invalid',
			'date_invalid',
			'text_invalid',
		]);
		expect(applyFulfilment(null, { dispatchVideoUrl: 'https://x.example.com' }, { ...settings, dispatchVideo: false }).ok).toBe(
			false,
		);
		expect(applyFulfilment(null, { carrier: 'other one' }, { ...settings, allowOther: true })).toMatchObject({
			ok: true,
			value: { carrierName: 'other one' },
		});
	});
});

describe('serials', () => {
	const rules = rulesOf([
		{ key: 'luhn', chars: 'digits', min_length: 15, max_length: 15, checksum: 'luhn', strip: ' -' },
		{ key: 'code', chars: 'alphanumeric', min_length: 4, max_length: 8, uppercase: true },
		{ key: 'bad', chars: 'regex' },
	]);
	it('validates by rules as data', () => {
		expect(rules).toHaveLength(2);
		expect(isLuhnValid('79927398713')).toBe(true);
		expect(isLuhnValid('x')).toBe(false);
		expect(validateSerial('4901 5420 3237 518', rules)).toEqual({ ok: true, value: '490154203237518', rule: 'luhn' });
		expect(validateSerial('abcd12', rules)).toEqual({ ok: true, value: 'ABCD12', rule: 'code' });
		expect(validateSerial('ab', rules)).toMatchObject({ code: 'serial_invalid' });
		expect(validateSerial(' ', rules)).toMatchObject({ code: 'serial_empty' });
		expect(validateSerial(1, rules)).toMatchObject({ code: 'serial_invalid' });
		expect(validateSerial('x'.repeat(300), rules)).toMatchObject({ code: 'serial_invalid' });
		expect(validateLineSerials('x', 1, rules)).toMatchObject({ code: 'serials_invalid' });
		expect(validateLineSerials(['abcd', 'ABCD'], 2, rules)).toMatchObject({ code: 'serial_duplicate', index: 1 });
		expect(validateLineSerials(['abcd', 'efgh'], 1, rules)).toMatchObject({ code: 'too_many_serials' });
		expect(validateLineSerials(['', 'abcd'], 1, rules)).toEqual({ ok: true, serials: ['ABCD'] });
	});
	it('decides required lines and applies patches', () => {
		const settings = { required_for: 'flagged', required_attributes: [{ key: 'kind', values: ['device'] }] };
		expect(lineNeedsSerials({ attributes: { kind: 'device' } }, settings)).toBe(true);
		expect(lineNeedsSerials({ serialRequired: true }, settings)).toBe(true);
		expect(lineNeedsSerials({}, settings)).toBe(false);
		expect(lineNeedsSerials({}, { required_for: 'all', required_attributes: [] })).toBe(true);
		expect(lineNeedsSerials({ serialRequired: true }, { required_for: 'none', required_attributes: [] })).toBe(false);
		expect(missingSerials([{ title: 'P', quantity: 2, serials: ['a'], serialRequired: true }], settings)).toEqual(['P']);
		const lines = [
			{ id: 'l1', quantity: 1 },
			{ id: 'l2', quantity: 1, serials: ['ABCD'] },
		];
		expect(applySerials({}, lines, rules).ok).toBe(false);
		expect(
			applySerials(
				{
					lines: [
						{ lineId: 'zz', serials: [] },
						{ lineId: 'l1', serials: ['!'] },
					],
				},
				lines,
				rules,
			),
		).toMatchObject({ ok: false, errors: [{ code: 'line_unknown' }, { code: 'serial_invalid' }] });
		expect(applySerials({ lines: [{ lineId: 'l1', serials: ['abcd'] }] }, lines, rules)).toMatchObject({
			ok: false,
			errors: [{ code: 'serial_duplicate' }],
		});
		expect(applySerials({ lines: [{ lineId: 'l1', serials: 'x' }] }, lines, rules)).toMatchObject({ ok: false });
	});
});

describe('ledger and risk', () => {
	it('summarises money and validates entries', () => {
		expect(summarize({ amounts: { total: 100 }, paid: 150, refunded: 150 })).toMatchObject({
			paymentState: 'paid',
			refundState: 'full',
			balanceDue: 100,
		});
		expect(summarize({ amounts: { total: 100 } })).toMatchObject({ paymentState: 'unpaid', refundState: 'none' });
		expect(netRevenue({ amounts: { total: 100 }, refunded: 30 }, true)).toBe(70);
		expect(netRevenue({ amounts: { total: 100 } }, false)).toBe(0);
		const methods = methodsOf([{ key: 'cash', label: ' Cash ' }, { key: 'bank', requires_reference: true }, 'x']);
		expect(methods).toEqual([
			{ key: 'cash', label: 'Cash', requiresReference: false },
			{ key: 'bank', label: null, requiresReference: true },
		]);
		const lines = [{ id: 'l1', quantity: 2 }];
		expect(validateEntry(null, 'payment', { methods, lines }).ok).toBe(false);
		const bad = validateEntry(
			{ amount: 0, method: 'bank', reference: '', proofUrl: 'x', note: 5.5, occurredAt: 'x' },
			'payment',
			{ methods, lines },
		);
		expect(/** @type {any} */ (bad).errors.map((/** @type {any} */ e) => e.path)).toEqual([
			'/amount',
			'/reference',
			'/reference',
			'/proofUrl',
			'/occurredAt',
		]);
		const refund = validateEntry({ amount: 5, method: 'cash', reason: 'r', lines: [{ lineId: 'l1', quantity: 3 }] }, 'refund', {
			methods,
			lines,
		});
		expect(refund.ok).toBe(false);
		expect(validateEntry({ amount: 5, method: 'cash', reason: 'r', lines: 'x' }, 'refund', { methods, lines }).ok).toBe(false);
		expect(
			validateEntry(
				{
					amount: 5,
					method: 'cash',
					reason: 'r',
					lines: [{ lineId: 'l1', quantity: 1 }],
					proofUrl: 'https://p.example.com/1',
					occurredAt: '2026-10-01',
				},
				'refund',
				{ methods, lines },
			),
		).toMatchObject({ ok: true, value: { lines: [{ lineId: 'l1', quantity: 1 }] } });
	});
	it('evaluates risk per currency', () => {
		const settings = /** @type {any} */ ({
			open_order_cap: 2,
			cap_action: 'reject',
			blocked_action: 'review',
			cod_max_total: [{ currency: 'EUR', amount: 1000 }],
			cod_over_cap_action: 'review',
			cod_advance_percent: 10,
			cod_advance_amount: [{ currency: 'USD', amount: 50 }],
			rto_warning_threshold: 2,
			rto_require_advance: true,
		});
		expect(codAdvance(0, 'EUR', settings)).toBe(0);
		expect(codAdvance(1001, 'EUR', settings)).toBe(101);
		expect(codAdvance(30, 'USD', settings)).toBe(30);
		expect(codAdvance(100, 'GBP', { cod_advance_percent: 0, cod_advance_amount: [] })).toBe(0);
		expect(isRtoFlagged(5, 0)).toBe(false);
		expect(
			evaluateRisk(
				{ total: 2000, currency: 'EUR', cod: true, profiles: [{ blocked: true, rtoCount: 3 }], openCount: 2 },
				settings,
			),
		).toEqual({
			flags: ['blocked', 'open_cap', 'rto_flagged', 'cod_over_cap'],
			decision: 'reject',
			advance: 200,
			rtoCount: 3,
		});
		expect(
			evaluateRisk(
				{ total: 100, currency: 'GBP', cod: true, profiles: [{ rtoCount: 2 }], openCount: 0 },
				{ ...settings, cod_advance_percent: 0 },
			),
		).toMatchObject({ decision: 'review', flags: ['rto_flagged', 'advance_unavailable'] });
		expect(evaluateRisk({ total: 100, currency: 'EUR', cod: false, profiles: [], openCount: 0 }, settings).decision).toBe(
			'accept',
		);
		expect(maskOf('email', 'ada@example.com')).toBe('a***@example.com');
		expect(maskOf('phone', '+15550100')).toBe('***100');
		expect(maskOf('customer', 'cus_1')).toBe('cus_1');
	});
});

describe('messages', () => {
	const templates = [
		{ status: 'placed', text: 'any {number}' },
		{ status: 'placed', lang: 'de', channel: 'sms', text: 'de sms' },
		{ status: 'placed', lang: 'de-CH', channel: 'email', subject: 'S {number}', text: 'de-CH email' },
	];
	it('picks channels, templates and catalogs', () => {
		expect(pickChannel({ email: 'a@b.c' }, ['sms', 'email'])).toEqual({ channel: 'email', to: { email: 'a@b.c' } });
		expect(pickChannel({ phone: '+1' }, ['whatsapp'])).toEqual({ channel: 'whatsapp', to: { phone: '+1' } });
		expect(pickChannel({}, ['email', 'sms'])).toBeNull();
		expect(pickTemplate(templates, { status: 'placed', lang: 'de-CH', channel: 'email' })?.text).toBe('de-CH email');
		expect(pickTemplate(templates, { status: 'placed', lang: 'de-CH', channel: 'sms' })?.text).toBe('de sms');
		expect(pickTemplate(templates, { status: 'placed', lang: 'fr', channel: 'sms' })?.text).toBe('any {number}');
		expect(pickTemplate(templates, { status: 'x', lang: 'fr', channel: 'sms' })).toBeNull();
		expect(catalogFor({ en: { a: '1' }, de: { a: '2' } }, 'de-AT').lang).toBe('de');
		expect(catalogFor({ en: { a: '1' } }, null).lang).toBe('en');
		expect(catalogFor({}, 'fr')).toEqual({ lang: 'en', strings: {} });
	});
	it('renders with fallbacks', () => {
		expect(
			renderMessage({ status: 'placed', channel: 'email', lang: 'de-CH', templates, strings, values: { number: '7' } }),
		).toEqual({ subject: 'S 7', text: 'de-CH email' });
		expect(
			renderMessage({
				status: 'shipped_custom',
				channel: 'email',
				lang: 'en',
				templates: [],
				strings,
				values: { name: 'A', number: '7', brand: 'B', status: 'X' },
			}).subject,
		).toBe('Order 7: X');
		expect(
			renderMessage({ status: 'confirmed', channel: 'sms', lang: 'en', templates: [], strings: {}, values: { number: '7' } }),
		).toEqual({ subject: null, text: '7' });
		expect(
			renderMessage({
				status: 'placed',
				channel: 'email',
				lang: 'en',
				templates: [{ status: 'placed', text: 'x' }],
				strings: {},
				values: {},
			}).subject,
		).toBeNull();
	});
});

describe('documents and views', () => {
	const ctx = /** @type {any} */ ({
		t,
		locale: 'en',
		timeZone: 'UTC',
		brand: {
			name: 'Shop',
			logoUrl: 'https://l.example.com/x.png',
			addressLines: [],
			contactLines: ['+1 555'],
			taxId: null,
			legalText: null,
			footerText: 'Thanks',
		},
		statusLabel: (/** @type {string} */ s) => s,
		methodLabel: (/** @type {string} */ m) => m ?? '—',
		deliveryLabel: (/** @type {string} */ m) => m ?? '—',
		payOnDelivery: (/** @type {any} */ o) => o.payment?.method === 'cod',
		now: Date.parse('2026-10-01T10:00:00Z'),
	});
	const order = {
		id: 'o1',
		number: '1',
		status: 'confirmed',
		source: 'api',
		currency: 'EUR',
		placedAt: '2026-10-01T10:00:00Z',
		customer: { name: 'Ada', email: 'a@b.c', phone: '+1' },
		shipping: { name: 'Ada', line1: '1 Main', city: 'X' },
		payment: { method: 'cod' },
		delivery: { method: 'pickup' },
		lines: [
			{
				id: 'l1',
				title: 'A',
				variantTitle: 'Red',
				sku: 'A1',
				quantity: 2,
				unitAmount: 100,
				totalAmount: 200,
				warranty: { label: null, days: 30 },
				serials: ['S1'],
			},
			{ id: 'l2', title: 'B', quantity: 1, unitAmount: 50, totalAmount: 50, warranty: null, variantId: 'v2' },
		],
		amounts: { subtotal: 250, discount: 10, shipping: 20, tax: 5, total: 265 },
		taxLines: [],
		adjustments: [{ label: 'Bonus', amount: 5 }],
		paid: 100,
		refunded: 20,
		payments: [{ id: 'p', amount: 100, method: 'cash', at: '2026-10-01', reference: 'R1' }],
		refunds: [{ id: 'r', amount: 20, method: 'cash', at: '2026-10-02' }],
		notes: { internal: 'vip', customer: 'ring twice' },
		risk: { flags: ['rto_flagged'] },
		fulfilment: {
			carrierName: 'Parcel',
			serviceLevel: 'std',
			trackingNumber: 'T1',
			trackingUrl: 'https://t/1',
			dispatchVideoUrl: 'https://v/1',
		},
		timeline: [{ status: 'confirmed', at: '2026-10-01' }],
	};
	it('renders invoices, slips and pick lists', () => {
		expect(esc('<a href="x">\'</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&lt;/a&gt;');
		expect(formatDate(null, ctx)).toBe('');
		expect(formatDate('nope', ctx)).toBe('');
		expect(formatDate('2026-10-01T10:00:00Z', { ...ctx, timeZone: 'Not/AZone' })).toBe('2026-10-01');
		expect(addressLine(null)).toBe('');
		expect(warrantyText({ warranty: { label: 'Lifetime', days: null } }, ctx)).toBe('Lifetime');
		expect(warrantyText({ warranty: { label: null, days: null } }, ctx)).toBe('');
		const internal = invoiceHtml(order, ctx, {
			kind: 'internal',
			invoiceNumber: 'I1',
			showWarranty: true,
			showSerials: true,
			showSku: true,
			showTaxLines: true,
			showPayments: true,
		});
		for (const text of [
			'Internal invoice',
			'30 days',
			'Serials: S1',
			'SKU A1',
			'Tax',
			'Bonus',
			'To pay on delivery',
			'R1',
			'vip',
			'rto_flagged',
			'Net paid',
			'Thanks',
			'x.png',
		])
			expect(internal).toContain(text);
		const plain = invoiceHtml(
			{
				...order,
				customer: null,
				shipping: null,
				adjustments: [{ label: 'Points', amount: -5 }],
				payments: [],
				refunds: [],
				amounts: { ...order.amounts, discount: 0, shipping: 0, tax: 0 },
			},
			{ ...ctx, brand: { ...ctx.brand, logoUrl: null, contactLines: [], taxId: 'T', legalText: 'L', footerText: null } },
			{
				kind: 'customer',
				invoiceNumber: 'I2',
				showWarranty: false,
				showSerials: false,
				showSku: false,
				showTaxLines: false,
				showPayments: true,
			},
		);
		expect(plain).toContain('−');
		expect(plain).not.toContain('Warranty');
		const slips = packingSlipsHtml(
			[order, { ...order, id: 'o2', payment: { method: 'card' }, shipping: null, customer: {}, notes: {}, fulfilment: {} }],
			ctx,
			{ showPrices: true, showCollect: true, serialSlots: true, signature: true },
		);
		expect(slips).toContain('Collect on delivery');
		expect(slips).toContain('Prepaid');
		expect(slips).toContain('ring twice');
		expect(
			packingSlipsHtml([], ctx, { showPrices: false, showCollect: false, serialSlots: false, signature: false }),
		).toContain('No orders selected.');
		expect(serialSlots({ quantity: 2, serials: ['a'] })).toEqual(['a', null]);
		expect(pickRows([order, order], 'sku').map((r) => r.quantity)).toEqual([2, 4]);
		expect(pickRows([order], 'title')[0]?.title).toBe('A');
		expect(pickListHtml([order], ctx, { sort: 'title' })).toContain('1 orders');
		expect(pickListHtml([], ctx, { sort: 'title' })).toContain('No orders selected.');
	});
	it('builds customer views without internal data', () => {
		const view = customerView(order, {
			statusLabel: (s) => s,
			methodLabel: (m) => String(m),
			showTracking: true,
			showVideo: true,
			canCancel: false,
		});
		expect(view.tracking).toMatchObject({ carrier: 'Parcel', dispatchVideoUrl: 'https://v/1' });
		expect(JSON.stringify(view)).not.toContain('vip');
		expect(view.ledger).toHaveLength(2);
		expect(trackingOf({ fulfilment: {} }, { showTracking: true, showVideo: true })).toBeNull();
		expect(trackingOf(order, { showTracking: false, showVideo: true })).toMatchObject({
			carrier: null,
			dispatchVideoUrl: 'https://v/1',
		});
		expect(
			customerView(
				{
					...order,
					fulfilment: null,
					payment: null,
					payments: null,
					refunds: null,
					timeline: null,
					lines: null,
					notes: null,
				},
				{ statusLabel: (s) => s, methodLabel: () => '—', showTracking: true, showVideo: false, canCancel: true },
			).lines,
		).toEqual([]);
	});
});

describe('bulk, csv, config, settings, stats', () => {
	it('exports cells and reads import rows', () => {
		const order = {
			id: 'o',
			number: '1',
			source: 'api',
			placedAt: '2026-10-01T00:00:00Z',
			status: 's',
			currency: 'EUR',
			amounts: { subtotal: 1, discount: 0, shipping: 0, tax: 0, total: 1 },
			lines: [
				{ quantity: 2, sku: 'A', title: 'a', serials: ['x'] },
				{ quantity: 1, title: 'b' },
			],
			customer: { name: 'A', email: 'e', phone: 'p' },
			shipping: { city: 'C', country: 'K', line1: 'l' },
			payment: { method: 'm' },
			delivery: { method: 'd' },
			fulfilment: { carrierName: 'c', trackingNumber: 't' },
			risk: { flags: ['f'] },
		};
		const columns = [
			'id',
			'number',
			'external_id',
			'source',
			'placed_at',
			'status',
			'revenue',
			'customer_name',
			'customer_email',
			'customer_phone',
			'city',
			'country',
			'currency',
			'subtotal',
			'total',
			'paid',
			'refunded',
			'balance_due',
			'payment_method',
			'delivery_method',
			'carrier',
			'tracking_number',
			'units',
			'lines',
			'serials',
			'risk_flags',
			'address',
			'unknown',
		];
		expect(columns.map((c) => exportCell(order, c, { revenue: true }))).toEqual([
			'o',
			'1',
			null,
			'api',
			'2026-10-01T00:00:00.000Z',
			's',
			true,
			'A',
			'e',
			'p',
			'C',
			'K',
			'EUR',
			1,
			1,
			0,
			0,
			1,
			'm',
			'd',
			'c',
			't',
			3,
			'2 × A; 1 × b',
			'x',
			'f',
			'l, C, K',
			null,
		]);
		expect(exportCell({ amounts: { total: 0 }, placedAt: 0 }, 'customer_name', { revenue: false })).toBeNull();
		const { rows, problems } = importRows([
			{ line: 2, values: { id: 'bad id' } },
			{ line: 3, values: {} },
			{ line: 4, values: { number: '1', status: 'Bad!' } },
			{ line: 5, values: { number: '1' } },
			{
				line: 6,
				values: {
					id: 'o1',
					status: 'Packed',
					reason: 'RTO',
					carrier: 'c',
					service_level: 's',
					tracking_number: 't',
					note: 'n',
				},
			},
		]);
		expect(problems.map((p) => p.code)).toEqual(['id_invalid', 'order_ref_missing', 'status_invalid', 'nothing_to_change']);
		expect(rows[0]).toEqual({
			line: 6,
			ref: { id: 'o1' },
			status: 'packed',
			reason: 'rto',
			fulfilment: { carrier: 'c', serviceLevel: 's', trackingNumber: 't', note: 'n' },
		});
	});
	it('round-trips CSV and filters', () => {
		const csv = toCsv(
			['a', 'b'],
			[
				['=x', 'y,"z"'],
				[1, true],
				[null, Number.NaN],
			],
			{ bom: true },
		);
		const parsed = parseCsv(csv);
		expect(parsed.ok && recordsOf(parsed.rows).records[0]?.values).toEqual({ a: '=x', b: 'y,"z"' });
		expect(parseCsv('')).toMatchObject({ ok: false, code: 'empty' });
		expect(parseCsv('a\n1\n2\n', { maxRows: 1 })).toMatchObject({ ok: false, code: 'too_many_rows' });
		expect(parseCsv('a\r1\r\n"2\n3"')).toMatchObject({ ok: true });
		expect(filterOf({ status: 'a', from: '2026-01-01', to: '2026-02-01', payment: 'cod', customerId: 'c1' })).toMatchObject({
			status: 'a',
			'payment.method': 'cod',
			customerId: 'c1',
		});
		expect(filterOf({ status: 'A!' })).toBeNull();
		expect(filterOf({ payment: 'A!' })).toBeNull();
		expect(filterOf({ from: 'x' })).toBeNull();
		expect(filterOf({ customerId: 'bad id' })).toBeNull();
		expect(
			effectiveConfig(
				{
					properties: {
						n: { type: 'integer', default: 1 },
						s: { type: 'string', default: 'a' },
						b: { type: 'boolean', default: true },
						a: { type: 'array', default: [] },
						o: { type: 'object', default: {} },
						x: { type: 'number', default: 1 },
						any: { default: 1 },
					},
				},
				{ n: 'x', s: 'b', b: false, a: 'x', o: [], x: 2.5, any: 3 },
			),
		).toEqual({ n: 1, s: 'b', b: false, a: [], o: {}, x: 2.5, any: 3 });
		const settings = settingsFrom({ can: () => true, config: () => null, domain: 'd' });
		expect(settings).toMatchObject({ language: 'en', currency: null, timeZone: null });
		const stats = statsOf(settings.matrix, [
			{ _id: { status: 'confirmed', currency: 'EUR' }, orders: 2, total: 100, paid: 100, refunded: 10 },
			{ _id: { status: 'cancelled', currency: 'EUR' }, orders: 1, total: 50, paid: 0, refunded: 0 },
			{ _id: { status: 'pending_payment', currency: 'USD' }, orders: 1, total: 5, paid: 0, refunded: 0 },
		]);
		expect(stats).toMatchObject({ orders: 4, open: 3, byCurrency: { EUR: { revenue: 90, orders: 2 }, USD: { revenue: 0 } } });
	});
});
