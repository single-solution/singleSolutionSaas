import { describe, expect, it } from 'vitest';
import { addLine, cartUpdatedData, cartView, mergeCarts, reconcile, setQuantity, subtotalOf } from '../core/cart.js';
import { defaultsOf, effectiveConfig } from '../core/config.js';
import { checkField, countryFor, deliveryFee, matchesPostal, resolveForm, validateForm } from '../core/form.js';
import { checkProofUpload, paymentStatusOf, safeReturnUrl } from '../core/gateway.js';
import {
	applyInventoryChange,
	applyPriceChange,
	itemFromCatalogEvent,
	itemFromCatalogView,
	priceLine,
	validateItem,
} from '../core/items.js';
import { applyBasisPoints, clampAmount, formatMoney, minorDigits } from '../core/money.js';
import {
	customerMayCancel,
	customerRef,
	eventLines,
	orderNumber,
	orderView,
	releasesStock,
	validatePlacement,
} from '../core/orders.js';
import { codAdvance, codSurcharge, paymentOptions, startOf } from '../core/payments.js';
import { checkPhone, matchesTemplate, normalisePhone } from '../core/phone.js';
import { consentsOf, identityRequired, missingConsents, policiesView, signinLink } from '../core/policies.js';
import { chooseOffers, computeTotals, couponsFrom, dealsFrom, eventAmounts, linesAfterDeals } from '../core/pricing.js';
import { checkCondition, conditionMatches } from '../core/rules.js';
import { successSteps } from '../core/success.js';
import { boundedInt, cleanText, isEmail } from '../core/text.js';
import { settingsFrom } from '../api/settings.js';

const settings = settingsFrom({ can: () => true, config: () => ({}), website: { currency: 'EUR' } });
const t = (/** @type {string} */ key) => key;
const clock = { now: Date.parse('2026-10-01T10:00:00Z'), timeZone: 'UTC' };

describe('text and money', () => {
	it('cleans text, bounds integers, checks e-mails', () => {
		expect(cleanText(' a\u0001b\tc ', 10)).toBe('ab\tc');
		expect(cleanText('   ', 5)).toBeNull();
		expect(cleanText(3, 5)).toBeNull();
		expect(cleanText('abcdef', 3)).toBe('abc');
		expect(boundedInt(50, { min: 1, max: 10, fallback: 2 })).toBe(10);
		expect(boundedInt('x', { min: 1, max: 10, fallback: 2 })).toBe(2);
		expect(isEmail('a@b.co')).toBe(true);
		expect(isEmail('a@b')).toBe(false);
	});
	it('formats money by the currency digits and computes basis points', () => {
		expect(minorDigits('JPY')).toBe(0);
		expect(formatMoney(1234, 'EUR', 'en')).toContain('12.34');
		expect(formatMoney(5, 'JPY', 'en')).toContain('5');
		expect(formatMoney(100, 'NOPE!', 'en')).toBe('1.00 NOPE!');
		expect(formatMoney(100, 'EUR', 'not a locale ###')).toContain('1.00');
		expect(applyBasisPoints(10_000, 250)).toBe(250);
		expect(applyBasisPoints(0, 250)).toBe(0);
		expect(clampAmount(-5, 10)).toBe(0);
		expect(clampAmount(50, 10)).toBe(10);
	});
	it('overlays config on schema defaults with type checks', () => {
		const schema = /** @type {any} */ ({
			properties: {
				a: { type: 'integer', default: 1 },
				b: { type: 'number', default: 1.5 },
				c: { type: 'string', default: 'x' },
				d: { type: 'boolean', default: false },
				e: { type: 'array', default: [] },
				f: { type: 'object', default: {} },
				g: { default: null },
			},
		});
		expect(defaultsOf(schema).c).toBe('x');
		expect(effectiveConfig(schema, { a: 'no', b: 2, c: 3, d: true, e: [1], f: { x: 1 }, g: 'y' })).toEqual({
			a: 1,
			b: 2,
			c: 'x',
			d: true,
			e: [1],
			f: { x: 1 },
			g: 'y',
		});
	});
});

describe('phone and form', () => {
	it('normalises and validates phones by pattern settings', () => {
		expect(normalisePhone('+44 (20) 7946-0958')).toBe('+442079460958');
		expect(normalisePhone('0+12')).toBe('012');
		expect(matchesTemplate('0712', '07##')).toBe(true);
		expect(matchesTemplate('0712', '08##')).toBe(false);
		expect(matchesTemplate('071', '07##')).toBe(false);
		const base = { mode: /** @type {const} */ ('any'), patterns: [], rewrites: [], minDigits: 6, maxDigits: 15 };
		expect(checkPhone('123', base)).toEqual({ ok: false, code: 'phone_invalid' });
		expect(checkPhone(5, base).ok).toBe(false);
		expect(checkPhone('12ab567', base).ok).toBe(false);
		expect(checkPhone('0712345678', { ...base, mode: 'e164', rewrites: [{ prefix: '0', replace: '+44' }] })).toEqual({
			ok: true,
			value: '+44712345678',
			e164: '+44712345678',
		});
		expect(checkPhone('0712345678', { ...base, mode: 'e164' }).ok).toBe(false);
		expect(checkPhone('0712345678', { ...base, mode: 'patterns', patterns: ['07########'] }).ok).toBe(true);
		expect(checkPhone('0812345678', { ...base, mode: 'patterns', patterns: ['07########'] }).ok).toBe(false);
	});
	it('resolves the form per country from data', () => {
		const form = {
			...settings.form,
			countries: ['DE', 'FR'],
			default_country: 'FR',
			address_formats: [
				{
					country: 'DE',
					fields: ['line1', 'postal_code', 'city', 'nope'],
					required: ['line1', 'postal_code'],
					postal_pattern: '#####',
				},
			],
			delivery_methods: [
				...settings.form.delivery_methods,
				{
					key: 'de_only',
					kind: /** @type {const} */ ('ship'),
					fee: 1,
					free_over: 0,
					requires_address: true,
					countries: ['DE'],
					label: 'DE',
				},
			],
		};
		expect(countryFor(form, 'DE')).toBe('DE');
		expect(countryFor(form, 'US')).toBe('FR');
		expect(countryFor({ ...form, default_country: '' }, null)).toBe('DE');
		expect(countryFor({ ...form, countries: [], default_country: '' }, null)).toBeNull();
		const de = resolveForm(form, { country: 'DE', t });
		expect(de.address.map((f) => f.key)).toEqual(['line1', 'postal_code', 'city']);
		expect(de.address.find((f) => f.key === 'city')?.required).toBe(false);
		expect(de.address.find((f) => f.key === 'postal_code')?.pattern).toBe('#####');
		expect(de.deliveryMethods.map((m) => m.key)).toContain('de_only');
		expect(de.contact[0]?.label).toBe('checkout_form.field.name');
		expect(resolveForm(form, { country: 'FR', t }).deliveryMethods.map((m) => m.key)).not.toContain('de_only');
	});
	it('checks fields of every kind', () => {
		const phone = settings.form.phone;
		/** @param {Record<string, any>} f */
		const field = (f) => /** @type {any} */ ({ key: 'k', required: false, autocomplete: '', max_length: 10, label: 'K', ...f });
		expect(checkField(field({ kind: 'checkbox', required: true }), false, phone)).toEqual({ ok: false, code: 'required' });
		expect(checkField(field({ kind: 'checkbox' }), 'x', phone)).toEqual({ ok: false, code: 'type_invalid' });
		expect(checkField(field({ kind: 'checkbox' }), true, phone)).toEqual({ ok: true, value: true });
		expect(checkField(field({ kind: 'text' }), 5, phone)).toEqual({ ok: false, code: 'type_invalid' });
		expect(checkField(field({ kind: 'text' }), 'x'.repeat(30), phone)).toEqual({ ok: false, code: 'too_long' });
		expect(checkField(field({ kind: 'text' }), 'x'.repeat(15), phone)).toEqual({ ok: false, code: 'too_long' });
		expect(checkField(field({ kind: 'text', required: true }), '', phone)).toEqual({ ok: false, code: 'required' });
		expect(checkField(field({ kind: 'text' }), undefined, phone)).toEqual({ ok: true, value: null });
		expect(checkField(field({ kind: 'email', max_length: 50 }), 'A@B.CO', phone)).toEqual({ ok: true, value: 'a@b.co' });
		expect(checkField(field({ kind: 'email' }), 'nope', phone).ok).toBe(false);
		expect(checkField(field({ kind: 'tel', max_length: 30 }), '+44 1234 567890', phone).ok).toBe(true);
		expect(checkField(field({ kind: 'tel' }), '12', phone).ok).toBe(false);
		expect(checkField(field({ kind: 'select', options: ['a'] }), 'a', phone).ok).toBe(true);
		expect(checkField(field({ kind: 'select' }), 'a', phone).ok).toBe(false);
		expect(checkField(field({ kind: 'postal', pattern: 'A# #A|#####' }), 'a1 2b', phone)).toEqual({ ok: true, value: 'A1 2B' });
		expect(checkField(field({ kind: 'postal', pattern: '#####' }), '1234', phone).ok).toBe(false);
		expect(matchesPostal('A1', '??')).toBe(true);
		expect(matchesPostal('-', '??')).toBe(false);
		expect(matchesPostal('X1', '#1')).toBe(false);
		expect(matchesPostal('1X', '1A')).toBe(true);
		expect(matchesPostal('anything', undefined)).toBe(true);
	});
	it('validates a submitted form, the address only when needed', () => {
		const form = { ...settings.form, pickup_locations: [{ key: 'main', name: 'Main store' }] };
		const ok = validateForm(
			form,
			{
				contact: { name: 'Ada', phone: '+441234567890' },
				address: { recipient_name: 'Ada', line1: 'x', city: 'y' },
				deliveryMethod: 'standard',
			},
			{ t, needsShipping: true },
		);
		expect(ok.problems).toEqual([]);
		expect(ok.values.address).toMatchObject({ line1: 'x' });
		const pickup = validateForm(
			form,
			{ contact: { name: 'Ada', phone: '+441234567890' }, deliveryMethod: 'pickup' },
			{ t, needsShipping: true },
		);
		expect(pickup.problems).toEqual([{ path: '/pickupLocation', code: 'pickup_unavailable' }]);
		const bad = validateForm(
			{ ...form, countries: ['DE'] },
			{ country: 'ZZ', contact: {}, deliveryMethod: 'nope' },
			{ t, needsShipping: false },
		);
		expect(bad.problems.map((p) => p.path)).toEqual(['/country', '/contact/name', '/contact/phone', '/deliveryMethod']);
		expect(validateForm(form, null, { t, needsShipping: false }).values.address).toBeNull();
		expect(deliveryFee(null, 100)).toBe(0);
		expect(deliveryFee(/** @type {any} */ ({ fee: 500, free_over: 1000 }), 1000)).toBe(0);
		expect(deliveryFee(/** @type {any} */ ({ fee: 500, free_over: 0 }), 1000)).toBe(500);
	});
});

describe('items', () => {
	it('validates merchant items with or without variants', () => {
		const one = validateItem('itm_1', {
			title: 'Socks',
			currency: 'EUR',
			price: 1200,
			available: 3,
			url: 'https://x.test/a',
			image: 'http://insecure',
		});
		expect(one.ok && one.item).toMatchObject({
			variants: [{ variantId: 'itm_1', price: 1200, available: 3 }],
			url: 'https://x.test/a',
			image: null,
		});
		const many = validateItem('itm_2', {
			title: 'Shirt',
			currency: 'EUR',
			status: 'draft',
			requiresShipping: false,
			collections: ['c1', 'c1', '!'],
			variants: [
				{
					variantId: 'v1',
					price: 100,
					compareAtPrice: 200,
					attributes: { size: ['M'], n: 2, bad_: { x: 1 }, '1x': 'y' },
					purchasable: false,
				},
			],
		});
		expect(many.ok && many.item).toMatchObject({
			status: 'draft',
			requiresShipping: false,
			collections: ['c1'],
			variants: [{ attributes: { size: 'M', n: '2' }, purchasable: false }],
		});
		const bad = validateItem('!', {
			currency: 'eur',
			status: 'x',
			variants: [{ variantId: 'v', price: -1, compareAtPrice: 'x', available: 1.5 }, 'x', { variantId: 'v', price: 1 }],
		});
		expect(bad.ok ? [] : bad.problems.map((p) => p.code)).toEqual(
			expect.arrayContaining([
				'id_invalid',
				'required',
				'currency_invalid',
				'status_invalid',
				'amount_invalid',
				'quantity_invalid',
				'variant_invalid',
			]),
		);
		expect(validateItem('itm', null).ok).toBe(false);
		expect(validateItem('itm', { title: 'x', currency: 'EUR', variants: [] }).ok).toBe(false);
		expect(validateItem('itm', { title: 'x', currency: 'EUR', url: 'not a url' }).ok).toBe(false);
	});
	it('mirrors Catalog events and views', () => {
		const item = itemFromCatalogEvent(
			{
				itemId: 'itm_c',
				title: 'Cat',
				currency: 'EUR',
				status: 'active',
				brand: 'B',
				collections: ['x'],
				variants: [{ variantId: 'v', price: 100, inventory: 4 }, { variantId: 'bad' }],
			},
			null,
		);
		expect(item).toMatchObject({ source: 'catalog', variants: [{ variantId: 'v', available: 4 }] });
		const updated = itemFromCatalogEvent({ itemId: 'itm_c', title: 'Cat 2' }, item);
		expect(updated).toMatchObject({ title: 'Cat 2', currency: 'EUR', variants: item?.variants });
		expect(itemFromCatalogEvent({ itemId: 'itm_c' }, null)).toBeNull();
		expect(itemFromCatalogEvent({ itemId: '!' }, null)).toBeNull();
		const view = itemFromCatalogView({
			id: 'itm_v',
			title: 'View',
			currency: 'EUR',
			url: 'https://shop.test/v',
			brand: { name: 'B' },
			collectionIds: ['c'],
			variants: [
				{ id: 'v1', price: 10, availability: 'out_of_stock', options: { size: 'm' } },
				{ id: 'v2', price: 20 },
			],
		});
		expect(view?.variants.map((v) => v.purchasable)).toEqual([false, true]);
		expect(itemFromCatalogView({ id: 'x', currency: 'EUR', title: 't', variants: [] })).toBeNull();
		expect(itemFromCatalogView(null)).toBeNull();
		const priced = /** @type {any} */ (item);
		expect(
			applyPriceChange(priced, { variantId: 'v', price: { amount: 150, currency: 'EUR' }, compareAtPrice: { amount: 200 } })
				?.variants[0],
		).toMatchObject({ price: 150, compareAtPrice: 200 });
		expect(applyPriceChange(priced, { price: { amount: 150, currency: 'USD' } })).toBeNull();
		expect(applyPriceChange(priced, { variantId: 'nope', price: { amount: 1, currency: 'EUR' } })).toBeNull();
		expect(applyInventoryChange(priced, { variantId: 'v', available: 9 })?.variants[0]?.available).toBe(9);
		expect(applyInventoryChange(priced, { quantity: 2 })?.variants[0]?.available).toBe(2);
		expect(applyInventoryChange(priced, { variantId: 'nope', quantity: 2 })).toBeNull();
		expect(applyInventoryChange(priced, { variantId: 'v' })).toBeNull();
	});
	it('prices lines from the item, never the request', () => {
		const item = /** @type {any} */ (
			validateItem('itm', {
				title: 'x',
				currency: 'EUR',
				variants: [
					{ variantId: 'a', price: 5, available: 0 },
					{ variantId: 'b', price: 7 },
					{ variantId: 'c', price: 9, available: 3 },
				],
			})
		).item;
		const rules = { currency: 'EUR' };
		expect(priceLine(null, { quantity: 1 }, rules)).toEqual({ ok: false, reason: 'item_unavailable' });
		expect(priceLine(item, { quantity: 1 }, rules)).toEqual({ ok: false, reason: 'variant_unavailable' });
		expect(priceLine(item, { variantId: 'a', quantity: 1 }, rules)).toEqual({ ok: false, reason: 'out_of_stock' });
		expect(priceLine(item, { variantId: 'b', quantity: 1 }, { ...rules, untracked: 'refuse' })).toEqual({
			ok: false,
			reason: 'untracked_stock',
		});
		expect(priceLine(item, { variantId: 'c', quantity: 1 }, { currency: 'USD' })).toEqual({
			ok: false,
			reason: 'currency_mismatch',
		});
		expect(priceLine(item, { variantId: 'c', quantity: 2 }, rules)).toMatchObject({
			ok: true,
			line: { unitAmount: 9, available: 3 },
		});
		const single = /** @type {any} */ (validateItem('one', { title: 'x', currency: 'EUR', price: 5 })).item;
		expect(priceLine(single, { quantity: 1 }, rules).ok).toBe(true);
		expect(priceLine({ ...single, status: 'archived' }, { quantity: 1 }, rules).ok).toBe(false);
	});
});

describe('cart rules', () => {
	const priced = (/** @type {Record<string, any>} */ extra = {}) =>
		/** @type {any} */ ({
			itemId: 'itm',
			variantId: 'v',
			quantity: 1,
			title: 'T',
			variantTitle: null,
			sku: 'S',
			image: null,
			url: null,
			unitAmount: 100,
			compareAtAmount: null,
			available: null,
			requiresShipping: true,
			collections: [],
			attributes: {},
			...extra,
		});
	const empty = /** @type {any} */ ({
		id: 'crt_1',
		status: 'open',
		currency: 'EUR',
		customerId: null,
		lines: [],
		note: null,
		lineSeq: 0,
	});
	const rules = { maxLines: 2, maxQuantity: 5 };
	it('adds, merges same lines, caps quantities and lines', () => {
		const a = /** @type {any} */ (addLine(empty, priced({ quantity: 2 }), rules));
		const b = /** @type {any} */ (addLine(a.cart, priced({ quantity: 9 }), rules));
		expect(b.cart.lines).toHaveLength(1);
		expect(b.cart.lines[0].quantity).toBe(5);
		expect(b.changes[0]).toMatchObject({ kind: 'quantity', to: 5 });
		const c = /** @type {any} */ (addLine(b.cart, priced({ variantId: 'w', quantity: 4, available: 2 }), rules));
		expect(c.changes[0]).toMatchObject({ kind: 'quantity', to: 2 });
		expect(addLine(c.cart, priced({ variantId: 'x' }), rules)).toEqual({ ok: false, reason: 'too_many_lines' });
		expect(setQuantity(c.cart, 'nope', 1, rules)).toEqual({ ok: false, reason: 'line_not_found' });
		expect(/** @type {any} */ (setQuantity(c.cart, 'l1', 0, rules)).cart.lines).toHaveLength(1);
		expect(/** @type {any} */ (setQuantity(c.cart, 'l2', 4, rules)).changes[0]).toMatchObject({ to: 2 });
		expect(subtotalOf(c.cart.lines)).toBe(700);
		const view = cartView({ ...c.cart, updatedAt: new Date(0) }, { unavailable: ['l2'] });
		expect(view).toMatchObject({ subtotalAmount: 500, quantity: 7, signedIn: false, updatedAt: '1970-01-01T00:00:00.000Z' });
		expect(view.lines[1]?.available).toBe(false);
		expect(cartUpdatedData(c.cart)).toMatchObject({ cartId: 'crt_1', currency: 'EUR', subtotalAmount: 700 });
	});
	it('merges a guest cart and reconciles with fresh prices', () => {
		const guest = /** @type {any} */ (addLine(empty, priced({ quantity: 2 }), rules)).cart;
		const withTwo = /** @type {any} */ (
			addLine(/** @type {any} */ (addLine(empty, priced({ variantId: 'p' }), rules)).cart, priced({ variantId: 'q' }), rules)
		).cart;
		const merged = mergeCarts(withTwo, guest, rules);
		expect(merged.changes[0]).toMatchObject({ kind: 'removed' });
		const fresh = reconcile(
			withTwo,
			[
				{ ok: true, line: priced({ variantId: 'p', unitAmount: 150, available: 0 }) },
				{ ok: false, reason: 'out_of_stock' },
			],
			{ ...rules, staleLines: 'flag' },
		);
		expect(fresh.changes.map((c) => c.kind)).toEqual(['price', 'quantity', 'unavailable']);
		expect(fresh.cart.lines).toHaveLength(2);
		const removed = reconcile(withTwo, [{ ok: true, line: priced({ variantId: 'p', available: 0 }) }], {
			...rules,
			staleLines: 'remove',
		});
		expect(removed.cart.lines).toHaveLength(0);
		expect(removed.unavailable).toEqual(['l1', 'l2']);
	});
});

describe('payments, pricing and orders', () => {
	const manual = { ...settings.manual, bank_transfer_enabled: true, cod_enabled: true, pickup_pay_enabled: true };
	const context = {
		subtotal: 10_000,
		total: 10_000,
		currency: 'EUR',
		deliveryKind: /** @type {const} */ ('ship'),
		deliveryMethod: 'standard',
		signedIn: false,
		country: 'DE',
		quantity: 1,
	};
	it('offers manual methods with COD caps, surcharge, advance and rules', () => {
		expect(codSurcharge({ ...manual, cod_surcharge_bp: 200, cod_surcharge_flat: 50 }, 10_000)).toBe(250);
		expect(codSurcharge(manual, 0)).toBe(0);
		expect(codAdvance({ ...manual, cod_advance_flat: 2000 }, 1000)).toBe(1000);
		expect(codAdvance({ ...manual, cod_advance_bp: 1000 }, 10_001)).toBe(1001);
		expect(codAdvance(manual, 1000)).toBe(0);
		expect(codAdvance({ ...manual, bank_transfer_enabled: false, cod_advance_flat: 5 }, 1000)).toBe(0);
		const options = paymentOptions({ manual, gatewayEnabled: true }, context, clock);
		expect(options.map((o) => [o.key, o.available, o.reason])).toEqual([
			['bank_transfer', true, null],
			['cod', true, null],
			['pickup_pay', false, 'delivery_unsupported'],
			['gateway', true, null],
		]);
		/** @param {Record<string, any>} m @param {Record<string, any>} [c] */
		const cod = (m, c = {}) =>
			paymentOptions({ manual: { ...manual, ...m }, gatewayEnabled: false }, { ...context, ...c }, clock).find(
				(o) => o.key === 'cod',
			)?.reason;
		expect(cod({ cod_max_order: 5000 })).toBe('over_cap');
		expect(cod({ cod_min_order: 50_000 })).toBe('under_minimum');
		expect(cod({ cod_requires_identity: true })).toBe('identity_required');
		expect(cod({ cod_available_when: 'cart.total < 100' })).toBe('rule_not_met');
		expect(cod({}, { deliveryKind: 'pickup' })).toBe('delivery_unsupported');
		expect(
			paymentOptions(
				{ manual: { ...manual, bank_available_when: 'country == "FR"' }, gatewayEnabled: false },
				context,
				clock,
			)[0]?.available,
		).toBe(false);
		expect(paymentOptions({ manual: null, gatewayEnabled: false }, context, clock)).toEqual([]);
		expect(conditionMatches('cart.(', {}, clock)).toBe(false);
		expect(conditionMatches('', {}, clock)).toBe(true);
		expect(conditionMatches('cart.total > 1', { cart: { total: 5 } }, clock)).toBe(true);
		expect(checkCondition('').ok).toBe(true);
		expect(checkCondition('cart.total > ').ok).toBe(false);
	});
	it('starts orders with the right status and hold', () => {
		const now = clock.now;
		const HOUR = 3_600_000;
		expect(startOf('bank_transfer', { manual, gatewayHoldMinutes: 30, total: 100, now })).toMatchObject({
			status: 'pending_payment',
			expiresAt: now + 48 * HOUR,
			dueNow: 100,
		});
		expect(startOf('gateway', { manual, gatewayHoldMinutes: 30, total: 100, now }).expiresAt).toBe(now + 30 * 60_000);
		expect(startOf('pickup_pay', { manual, gatewayHoldMinutes: 30, total: 100, now })).toMatchObject({
			dueNow: 0,
			dueLater: 100,
		});
		expect(startOf('cod', { manual, gatewayHoldMinutes: 30, total: 100, now })).toMatchObject({
			status: 'awaiting_confirmation',
			expiresAt: now + 24 * HOUR,
		});
		expect(
			startOf('cod', { manual: { ...manual, cod_confirmation_hours: 0 }, gatewayHoldMinutes: 30, total: 100, now }).expiresAt,
		).toBeNull();
		expect(
			startOf('cod', { manual: { ...manual, cod_confirmation: false }, gatewayHoldMinutes: 30, total: 100, now }).status,
		).toBe('confirmed');
		expect(
			startOf('cod', { manual: { ...manual, cod_advance_flat: 30 }, gatewayHoldMinutes: 30, total: 100, now }),
		).toMatchObject({ status: 'pending_payment', advance: 30, dueNow: 30, dueLater: 70 });
	});
	it('normalises offers and computes clamped totals', () => {
		const deals = dealsFrom({
			id: 'q1',
			discountTotal: 300,
			lines: [{ lineId: 'l1', discount: 300 }, {}],
			shipping: { discount: 100 },
			couponsAllowed: false,
			deals: [{ dealId: 'd', name: 'D', amount: 300 }, {}],
		});
		expect(deals).toMatchObject({
			quoteId: 'q1',
			discount: 300,
			shippingDiscount: 100,
			couponsAllowed: false,
			loyaltyAllowed: true,
		});
		expect(dealsFrom(null)).toMatchObject({ quoteId: null, discount: 0, deals: [] });
		const coupons = couponsFrom({
			discount: 500,
			applied: [{ code: 'A', name: 'A', discount: 500, shippingDiscount: 0 }, {}],
			rejected: [{ code: 'B' }, {}],
			freeShipping: true,
			dealsAllowed: true,
		});
		expect(coupons.rejected).toEqual([{ code: 'B', reason: 'not_eligible' }]);
		expect(couponsFrom(undefined).applied).toEqual([]);
		const lines = [{ lineId: 'l1', unitAmount: 1000, quantity: 3 }];
		expect(linesAfterDeals(lines, deals)[0]?.unitAmount).toBe(900);
		expect(linesAfterDeals(lines, null)[0]).toBe(lines[0]);
		expect(chooseOffers({ deals: null, couponsOnDeals: coupons, couponsOnList: null, precedence: 'best' }).coupons).toBe(
			coupons,
		);
		expect(chooseOffers({ deals, couponsOnDeals: coupons, couponsOnList: null, precedence: 'deals_first' }).dropped).toBe(
			'coupons',
		);
		expect(chooseOffers({ deals, couponsOnDeals: coupons, couponsOnList: null, precedence: 'coupons_first' }).dropped).toBe(
			'deals',
		);
		expect(chooseOffers({ deals, couponsOnDeals: coupons, couponsOnList: coupons, precedence: 'best' }).dropped).toBe('deals');
		expect(
			chooseOffers({ deals: { ...deals, discount: 5000 }, couponsOnDeals: coupons, couponsOnList: null, precedence: 'best' })
				.dropped,
		).toBe('coupons');
		expect(
			chooseOffers({
				deals: { ...deals, couponsAllowed: true },
				couponsOnDeals: coupons,
				couponsOnList: null,
				precedence: 'best',
			}).dropped,
		).toBeNull();
		const delivery = /** @type {any} */ ({ fee: 500, free_over: 0 });
		const priced = computeTotals({
			currency: 'EUR',
			lines,
			deals,
			coupons: { ...coupons, freeShipping: false, shippingDiscount: 50 },
			delivery,
			surchargeFor: (m) => m / 100,
			loyaltyValue: 999_999,
			loyaltyMaxShareBp: 5000,
		});
		expect(priced.totals).toEqual({
			currency: 'EUR',
			subtotal: 3000,
			itemDiscount: 300,
			couponDiscount: 500,
			shipping: 500,
			shippingDiscount: 150,
			surcharge: 22,
			loyalty: 1100,
			tax: 0,
			total: 1472,
		});
		expect(
			computeTotals({
				currency: 'EUR',
				lines,
				deals: { ...deals, loyaltyAllowed: false },
				coupons,
				delivery,
				surchargeFor: () => 0,
				loyaltyValue: 10,
				loyaltyMaxShareBp: 10_000,
			}).totals,
		).toMatchObject({ loyalty: 0, shippingDiscount: 500 });
		expect(eventAmounts(priced.totals)).toEqual({ subtotal: 3000, discount: 1900, shipping: 350, tax: 0, total: 1472 });
	});
	it('validates placements and builds order views and events', () => {
		const rules = { maxLines: 3, maxQuantity: 5, maxCodes: 1, serverKey: false };
		expect(validatePlacement(null, rules).problems).toEqual([{ path: '', code: 'body_invalid' }]);
		const bad = validatePlacement(
			{
				cartId: 'c',
				lines: [],
				paymentMethod: 'x',
				codes: ['A', 'B'],
				loyaltyPoints: -1,
				consents: ['NO'],
				expectedTotal: 'x',
				note: 5,
				customer: {},
			},
			rules,
		);
		expect(bad.problems.map((p) => p.code)).toEqual([
			'cart_or_lines',
			'lines_count',
			'payment_unavailable',
			'codes_invalid',
			'points_invalid',
			'consents_invalid',
			'amount_invalid',
			'too_long',
			'server_key_only',
		]);
		const lines = validatePlacement(
			{
				lines: [
					{ itemId: 'a', quantity: 2 },
					{ itemId: 'a', quantity: 2 },
					{ itemId: '!' },
					{ itemId: 'b', variantId: '!' },
					{ itemId: 'c', quantity: 9 },
				],
				paymentMethod: 'cod',
			},
			{ ...rules, maxLines: 10 },
		);
		expect(lines.problems.map((p) => p.path)).toEqual(['/lines/2/itemId', '/lines/3/variantId', '/lines/4/quantity']);
		expect(
			validatePlacement(
				{
					lines: [
						{ itemId: 'a', quantity: 3 },
						{ itemId: 'a', quantity: 3 },
					],
					paymentMethod: 'cod',
				},
				rules,
			).problems,
		).toEqual([{ path: '/lines', code: 'quantity_invalid' }]);
		expect(
			validatePlacement({ cartId: 'c', paymentMethod: 'cod', customer: { subject: '' } }, { ...rules, serverKey: true })
				.problems,
		).toEqual([{ path: '/customer', code: 'customer_invalid' }]);
		const good = validatePlacement(
			{
				cartId: 'crt',
				paymentMethod: 'cod',
				codes: [' A1 '],
				customer: { subject: 'u', email: 'e@x.y' },
				returnUrl: 'https://x',
			},
			{ ...rules, serverKey: true },
		);
		expect(good.input).toMatchObject({
			cartId: 'crt',
			codes: ['A1'],
			customer: { subject: 'u', email: 'e@x.y', phone: null },
			returnUrl: 'https://x',
			expectedTotal: null,
		});
		expect(orderNumber(42, { prefix: 'W-', padding: 5 })).toBe('W-00042');
		expect(customerMayCancel({ status: 'awaiting_confirmation' }, true)).toBe(true);
		expect(customerMayCancel({ status: 'confirmed' }, true)).toBe(false);
		expect(releasesStock({ status: 'confirmed', stock: { state: 'reserved' } })).toBe(true);
		expect(releasesStock({ status: 'completed', stock: { state: 'reserved' } })).toBe(false);
		expect(customerRef({ subject: 's', email: 'bad', phone: '0123' })).toEqual({ subject: 's' });
		expect(customerRef({})).toBeNull();
		expect(eventLines([{ itemId: 'i', variantId: null, sku: null, title: 'T', quantity: 2, unitAmount: 5 }])).toEqual([
			{ itemId: 'i', title: 'T', quantity: 2, unitAmount: 5, totalAmount: 10 },
		]);
		const view = orderView({
			id: 'o',
			number: '1',
			status: 'confirmed',
			placedAt: new Date(0),
			currency: 'EUR',
			totals: {},
			payment: { method: 'cod', kind: 'manual', status: 'unpaid' },
		});
		expect(view).toMatchObject({
			expiresAt: null,
			lines: [],
			proofs: [],
			payments: [],
			offers: { codes: [], loyaltyPoints: 0 },
		});
	});
	it('builds success steps from the real order state', () => {
		const order = (/** @type {Record<string, any>} */ extra) => ({
			number: 'N1',
			status: 'pending_payment',
			delivery: { kind: 'ship' },
			payment: { method: 'bank_transfer', status: 'unpaid', dueNow: 100, dueLater: 0, advance: 0 },
			...extra,
		});
		const s = { ...settings.success, prep_sla: 'Today', ship_sla: ' ', pickup_sla: 'Tomorrow' };
		const money = (/** @type {number} */ n) => String(n);
		expect(successSteps(order({}), s, { formatMoney: money, proofsEnabled: true }).map((x) => x.key)).toEqual([
			'pay',
			'proof',
			'prepare',
			'ship',
		]);
		expect(
			successSteps(
				order({
					payment: { method: 'cod', status: 'unpaid', dueNow: 0, dueLater: 100, advance: 0 },
					status: 'awaiting_confirmation',
				}),
				s,
				{ formatMoney: money, proofsEnabled: false },
			).map((x) => x.text),
		).toEqual(['success.step.confirm', 'success.step.prepare', 'success.step.ship_cod']);
		expect(
			successSteps(order({ payment: { method: 'gateway', status: 'unpaid', dueNow: 5 }, delivery: { kind: 'digital' } }), s, {
				formatMoney: money,
				proofsEnabled: false,
			}).map((x) => x.key),
		).toEqual(['pay', 'prepare', 'deliver']);
		const pickup = successSteps(
			order({
				status: 'confirmed',
				payment: { method: 'pickup_pay', status: 'unpaid', dueLater: 9 },
				delivery: { kind: 'pickup' },
				pickupLocation: { name: 'Main' },
			}),
			s,
			{ formatMoney: money, proofsEnabled: false },
		);
		expect(pickup.map((x) => [x.key, x.when, x.current])).toEqual([
			['prepare', 'Today', true],
			['pickup', 'Tomorrow', false],
		]);
		expect(successSteps(order({ status: 'cancelled' }), s, { formatMoney: money, proofsEnabled: false })[0]?.text).toBe(
			'success.step.cancelled',
		);
		expect(
			successSteps(order({ delivery: null, payment: { method: 'cod', status: 'unpaid', dueNow: 10, advance: 10 } }), s, {
				formatMoney: money,
				proofsEnabled: false,
			})[0]?.text,
		).toBe('success.step.pay_advance');
	});
	it('handles policies, the sign-in gate and gateway helpers', () => {
		const p = {
			policies: [
				{ key: 'terms', url: '', required: true, version: '2' },
				{ key: 'privacy', url: '/privacy', required: false, version: '1', label: 'Privacy' },
			],
			content_url_template: 'https://c.test/{key}',
		};
		expect(policiesView(p, t).map((x) => x.url)).toEqual(['https://c.test/terms', '/privacy']);
		expect(policiesView({ ...p, content_url_template: '' }, t)[0]?.url).toBeNull();
		expect(missingConsents(p, [])).toEqual(['terms']);
		expect(consentsOf(p, ['privacy'], 'now')).toEqual([{ key: 'privacy', version: '1', acceptedAt: 'now' }]);
		const gate = { required: /** @type {any} */ ('never'), over_amount: 100, signin_url: '/login', return_param: 'back' };
		expect(identityRequired(gate, {})).toBe(false);
		expect(identityRequired({ ...gate, required: 'always' }, {})).toBe(true);
		expect(identityRequired({ ...gate, required: 'for_cod' }, { paymentMethod: 'cod' })).toBe(true);
		expect(identityRequired({ ...gate, required: 'over_amount' }, { total: 101 })).toBe(true);
		expect(identityRequired({ ...gate, required: 'over_amount' }, {})).toBe(false);
		expect(signinLink(gate, '/checkout')).toBe('/login?back=%2Fcheckout');
		expect(signinLink({ ...gate, signin_url: 'https://id.test/in' }, 'https://shop.test/c')).toBe(
			'https://id.test/in?back=https%3A%2F%2Fshop.test%2Fc',
		);
		expect(signinLink(gate, '//evil')).toBe('/login');
		expect(signinLink({ ...gate, signin_url: '' }, '/x')).toBeNull();
		expect(paymentStatusOf('succeeded')).toBe('paid');
		expect(paymentStatusOf('weird')).toBe('pending');
		const site = { domain: 'shop.test', allowSubdomains: true };
		expect(safeReturnUrl('https://a.shop.test/r', site)).toBe('https://a.shop.test/r');
		expect(safeReturnUrl('https://evil.test/r', site)).toBeNull();
		expect(safeReturnUrl('http://shop.test/r', site)).toBeNull();
		expect(safeReturnUrl('nope', site)).toBeNull();
		expect(safeReturnUrl(5, site)).toBeNull();
		const rules = { contentTypes: ['image/png'], maxBytes: 100 };
		expect(checkProofUpload({ contentType: 'image/gif', size: 1 }, rules)).toMatchObject({ code: 'content_type_unsupported' });
		expect(checkProofUpload({ contentType: 'image/png', size: 0 }, rules)).toMatchObject({ code: 'size_invalid' });
		expect(checkProofUpload({ contentType: 'image/png', size: 101 }, rules)).toMatchObject({ code: 'too_large' });
		expect(checkProofUpload({ contentType: 'image/png', size: 1, reference: 5 }, rules)).toMatchObject({
			code: 'reference_invalid',
		});
		expect(checkProofUpload({ contentType: 'IMAGE/PNG', size: 1, reference: ' R ' }, rules)).toEqual({
			ok: true,
			contentType: 'image/png',
			size: 1,
			extension: 'png',
			reference: 'R',
		});
		expect(checkProofUpload(null, rules).ok).toBe(false);
	});
	it('reads settings from the website and the schemas', () => {
		expect(settings.currency).toBe('EUR');
		expect(
			settingsFrom({ can: () => false, config: () => ({ default_currency: 'USD' }), website: { timeZone: 'Nope/Zone' } }),
		).toMatchObject({ currency: 'USD', timeZone: 'UTC', language: 'en' });
		expect(settingsFrom({ can: () => false, config: () => null }).currency).toBeNull();
		expect(
			settingsFrom({ can: () => true, config: () => ({}), website: { timeZone: 'Europe/Berlin', language: 'de' } }),
		).toMatchObject({ timeZone: 'Europe/Berlin', language: 'de' });
	});
});
