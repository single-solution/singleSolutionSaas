import { describe, expect, it } from 'vitest';
import { settingsFrom } from '../api/settings.js';
import { effectiveConfig } from '../core/config.js';
import { dealInput, mergePatch, normaliseDeal, validateDeal } from '../core/deals.js';
import { applyLock, isLockClaims, lockClaims } from '../core/locks.js';
import { dealCard, evaluateItem, sortCards, stockLeft } from '../core/offers.js';
import { checkCondition, compileCondition, conditionMatches } from '../core/rules.js';
import { catalogPrice, isStorewide, lineInScope, normaliseAttributes, normaliseLine, scopeCatalogFilter } from '../core/scope.js';
import { catalogItem, validateCommit, validateItem, validateOffers, validateQuote } from '../core/validate.js';

const settings = settingsFrom({ can: () => true, config: () => ({}) });
const rules = settings.dealRules;
const codes = (/** @type {Array<{ path: string, code: string }>} */ problems) => problems.map((p) => `${p.path}:${p.code}`);
const NOW = Date.parse('2026-10-02T12:00:00Z');

describe('scopes and lines', () => {
	/** @type {any} */
	const catalog = {
		itemId: 'itm_1',
		brand: 'acme',
		collections: ['shoes'],
		attributes: { colour: 'red', size: ['42', 43] },
		price: 9000,
		cost: 4000,
		variants: [{ variantId: 'v1', price: 8000, attributes: { size: '41' }, cost: 3500 }],
	};
	it('normalises lines from the cart and the synced catalog', () => {
		const line = normaliseLine({ itemId: 'itm_1', variantId: 'v1', quantity: 2 }, 0, catalog);
		expect(line).toMatchObject({
			lineId: '1',
			unitAmount: 8000,
			brand: 'acme',
			collections: ['shoes'],
			attributes: { colour: ['red'], size: ['41'] },
			unitCost: 3500,
		});
		const sent = normaliseLine(
			{ lineId: 'x', itemId: 'itm_1', quantity: 1, unitAmount: 100, attributes: { a: 'b' }, collections: ['c'], brand: 'b' },
			1,
			catalog,
		);
		expect(sent).toMatchObject({ lineId: 'x', unitAmount: 100, attributes: { a: ['b'] }, collections: ['c'], brand: 'b' });
		expect(normaliseLine({ itemId: 'none', quantity: 1 }, 0)).toMatchObject({ unitAmount: 0, brand: null, unitCost: null });
		expect(catalogPrice(catalog, 'v9')).toBe(9000);
		expect(catalogPrice(null, null)).toBeNull();
		expect(normaliseAttributes([1])).toEqual({});
		expect(normaliseAttributes({ a: [' ', null, 'x', 'x'] })).toEqual({ a: ['x'] });
	});

	it('matches scopes (AND across, OR within; exclusions; amount bounds; rules@1)', () => {
		const line = normaliseLine({ itemId: 'itm_1', quantity: 1 }, 0, catalog);
		expect(lineInScope(line, null)).toBe(true);
		expect(lineInScope(line, { collections: ['shoes', 'hats'], brands: ['acme'] })).toBe(true);
		expect(lineInScope(line, { collections: ['shoes'], brands: ['other'] })).toBe(false);
		expect(lineInScope(line, { variants: ['v1'] })).toBe(false);
		expect(
			lineInScope(normaliseLine({ itemId: 'itm_1', variantId: 'v1', quantity: 1 }, 0, catalog), { variants: ['v1'] }),
		).toBe(true);
		expect(lineInScope(line, { attributes: [{ name: 'size', values: ['43'] }] })).toBe(true);
		expect(lineInScope(line, { attributes: [{ name: 'size', values: ['44'] }] })).toBe(false);
		expect(lineInScope(line, { exclude: { items: ['itm_1'] } })).toBe(false);
		expect(lineInScope(line, { exclude: { collections: ['shoes'] } })).toBe(false);
		expect(lineInScope(line, { exclude: { brands: ['acme'] } })).toBe(false);
		expect(
			lineInScope(normaliseLine({ itemId: 'itm_1', variantId: 'v1', quantity: 1 }, 0, catalog), {
				exclude: { variants: ['v1'] },
			}),
		).toBe(false);
		expect(lineInScope(line, { minUnitAmount: 9500 })).toBe(false);
		expect(lineInScope(line, { maxUnitAmount: 8000 })).toBe(false);
		expect(lineInScope(line, { when: "item.brand == 'acme' and item.amount >= 9000" })).toBe(true);
		expect(lineInScope(line, { when: 'item.amount >' })).toBe(false);
		expect(isStorewide({})).toBe(true);
		expect(isStorewide({ when: 'true' })).toBe(false);
	});

	it('translates scopes to catalog queries', () => {
		expect(scopeCatalogFilter(null)).toEqual({});
		expect(scopeCatalogFilter({ collections: ['a'] })).toEqual({ collections: { $in: ['a'] } });
		const filter = scopeCatalogFilter({
			items: ['i'],
			variants: ['v'],
			brands: ['b'],
			attributes: [{ name: 'size', values: ['42'] }],
			exclude: { items: ['x'], collections: ['y'], brands: ['z'] },
		});
		expect(filter.$and).toHaveLength(6);
	});
});

describe('rules@1 conditions', () => {
	it('compiles once, checks for editors and treats errors as no match', () => {
		expect(compileCondition('')).toEqual({ ok: true, program: null });
		const first = compileCondition('cart.subtotal > 10');
		expect(compileCondition('cart.subtotal > 10')).toBe(first);
		for (let i = 0; i < 510; i += 1) compileCondition(`cart.subtotal > ${i}`);
		expect(checkCondition('')).toMatchObject({ ok: true, paths: [] });
		expect(checkCondition('order.total > 1').warnings.length).toBeGreaterThan(0);
		expect(conditionMatches('', {}, { now: NOW, timeZone: 'UTC' })).toBe(true);
		expect(conditionMatches('cart.subtotal >', {}, { now: NOW, timeZone: 'UTC' })).toBe(false);
		expect(conditionMatches("between(now, '10:00', '15:00', 'Europe/Berlin')", {}, { now: NOW, timeZone: 'UTC' })).toBe(true);
	});
});

describe('deal validation', () => {
	it('accepts every kind with valid input', () => {
		expect(
			validateDeal(
				{
					kind: 'item',
					name: 'a',
					action: { type: 'buy_x_get_y', buy: 2, get: 1, percent: 50 },
					limits: { stockUnits: 5 },
					conditions: { minQuantity: 2, paymentMethods: ['card'], newCustomersOnly: true, when: 'cart.quantity > 1' },
				},
				rules,
			),
		).toEqual([]);
		expect(
			validateDeal(
				{
					kind: 'cart',
					name: 'a',
					action: {
						type: 'tiered',
						basis: 'subtotal',
						tiers: [
							{ min: 100, percent: 5 },
							{ min: 200, amount: 50 },
							{ min: 300, freeShipping: true },
						],
					},
				},
				rules,
			),
		).toEqual([]);
		expect(
			validateDeal(
				{
					kind: 'flash',
					name: 'f',
					scope: { items: ['a'] },
					action: { type: 'fixed_price', amount: 0 },
					schedule: { endsAt: '2026-10-03T00:00:00Z' },
				},
				rules,
			),
		).toEqual([]);
		expect(
			validateDeal(
				{
					kind: 'bundle',
					name: 'b',
					bundle: {
						type: 'buy_together',
						components: [
							{ scope: { items: ['a'] }, quantity: 1 },
							{ scope: { items: ['b'] }, quantity: 1 },
						],
						maxPerOrder: 2,
					},
					action: { type: 'amount_off', amount: 100 },
				},
				rules,
			),
		).toEqual([]);
		expect(
			validateDeal(
				{
					kind: 'bundle',
					name: 'b',
					bundle: { type: 'mix_and_match', scope: { collections: ['s'] }, quantity: 3, maxPerOrder: 1 },
					action: { type: 'percent', percent: 10 },
				},
				rules,
			),
		).toEqual([]);
	});

	it('reports every invalid field', () => {
		expect(codes(validateDeal(null, rules))).toEqual([':body_invalid']);
		expect(codes(validateDeal({ kind: 'nope', name: 'a', action: {} }, rules))).toEqual(['/kind:kind_invalid']);
		expect(
			codes(
				validateDeal(
					{
						kind: 'item',
						name: 'a',
						description: '',
						status: 'gone',
						priority: 5000,
						badge: { label: 'x'.repeat(41), tone: 'pink', x: 1 },
						scope: {
							items: 'x',
							attributes: [{ name: 'a.b', values: [] }, 'x'],
							minUnitAmount: -1,
							exclude: { items: [1], other: 1 },
							extra: 1,
						},
						conditions: {
							minSubtotal: -1,
							minQuantity: 0,
							paymentMethods: ['a b'],
							newCustomersOnly: 'yes',
							when: 5,
							x: 1,
						},
						action: { type: 'percent', percent: 10.123 },
						bundle: {},
						limits: { totalUses: 0, x: 1 },
						combinesWithCoupons: 'no',
						custom: [],
					},
					rules,
				),
			),
		).toEqual(
			expect.arrayContaining([
				'/description:text_invalid',
				'/status:status_invalid',
				'/priority:integer_invalid',
				'/badge/x:unknown_field',
				'/badge/label:text_invalid',
				'/badge/tone:tone_invalid',
				'/scope/extra:unknown_field',
				'/scope/items:list_invalid',
				'/scope/attributes/0/name:attribute_invalid',
				'/scope/attributes/0/values:list_invalid',
				'/scope/attributes/1:body_invalid',
				'/scope/minUnitAmount:amount_invalid',
				'/scope/exclude/other:unknown_field',
				'/scope/exclude/items:list_invalid',
				'/bundle:not_allowed',
				'/conditions/x:unknown_field',
				'/conditions/minSubtotal:amount_invalid',
				'/conditions/minQuantity:integer_invalid',
				'/conditions/paymentMethods:list_invalid',
				'/conditions/newCustomersOnly:boolean_invalid',
				'/conditions/when:condition_invalid',
				'/action/percent:percent_precision',
				'/limits/x:unknown_field',
				'/limits/totalUses:integer_invalid',
				'/combinesWithCoupons:boolean_invalid',
				'/custom:custom_invalid',
			]),
		);
		const action = (/** @type {string} */ kind, /** @type {any} */ a) =>
			codes(
				validateDeal(
					{
						kind,
						name: 'a',
						action: a,
						...(kind === 'bundle' ? { bundle: { type: 'mix_and_match', scope: {}, quantity: 2 } } : {}),
					},
					rules,
				),
			);
		expect(action('item', 'x')).toEqual(['/action:object_invalid']);
		expect(action('item', { type: 'free_shipping' })).toEqual(['/action/type:action_invalid']);
		expect(action('item', { type: 'amount_off', amount: 0 })).toEqual(['/action/amount:amount_invalid']);
		expect(action('item', { type: 'fixed_price', amount: -1 })).toEqual(['/action/amount:amount_invalid']);
		expect(action('item', { type: 'buy_x_get_y', buy: 0, get: 1 })).toEqual(['/action/buy:integer_invalid']);
		expect(action('cart', { type: 'percent', percent: 10, maxDiscount: 0 })).toEqual(['/action/maxDiscount:amount_invalid']);
		expect(action('cart', { type: 'free_shipping', x: 1 })).toEqual(['/action/x:unknown_field']);
		expect(action('cart', { type: 'tiered', basis: 'weight', tiers: [] })).toEqual([
			'/action/basis:basis_invalid',
			'/action/tiers:tiers_invalid',
		]);
		expect(
			action('cart', {
				type: 'tiered',
				basis: 'subtotal',
				tiers: [{ min: 0, percent: 1, amount: 2 }, { min: 0 }, 'x', { min: 5, freeShipping: 'y' }],
			}),
		).toEqual(
			expect.arrayContaining([
				'/action/tiers/0/min:amount_invalid',
				'/action/tiers/0:tier_reward_invalid',
				'/action/tiers/1:tier_reward_required',
				'/action/tiers:tiers_not_ascending',
				'/action/tiers/3/freeShipping:boolean_invalid',
			]),
		);
		expect(codes(validateDeal({ kind: 'bundle', name: 'b', action: { type: 'percent', percent: 5 } }, rules))).toEqual([
			'/bundle:required',
		]);
		expect(
			codes(
				validateDeal({ kind: 'bundle', name: 'b', scope: {}, bundle: 'x', action: { type: 'percent', percent: 5 } }, rules),
			),
		).toEqual(['/bundle:object_invalid', '/scope:not_allowed']);
		expect(
			codes(
				validateDeal(
					{ kind: 'bundle', name: 'b', bundle: { type: 'other' }, action: { type: 'percent', percent: 5 } },
					rules,
				),
			),
		).toEqual(['/bundle/type:bundle_type_invalid']);
		expect(
			codes(
				validateDeal(
					{
						kind: 'bundle',
						name: 'b',
						bundle: { type: 'buy_together', components: [{ scope: {}, quantity: 0 }, 'x'], maxPerOrder: 0 },
						action: { type: 'percent', percent: 5 },
					},
					rules,
				),
			),
		).toEqual([
			'/bundle/components/0/quantity:integer_invalid',
			'/bundle/components/1:body_invalid',
			'/bundle/maxPerOrder:integer_invalid',
		]);
		expect(
			codes(
				validateDeal(
					{
						kind: 'bundle',
						name: 'b',
						bundle: { type: 'buy_together', components: [] },
						action: { type: 'percent', percent: 5 },
					},
					rules,
				),
			),
		).toEqual(['/bundle/components:components_invalid']);
		expect(
			codes(
				validateDeal(
					{
						kind: 'bundle',
						name: 'b',
						bundle: { type: 'mix_and_match', scope: {}, quantity: 1, maxPerOrder: 0 },
						action: { type: 'percent', percent: 5 },
					},
					rules,
				),
			),
		).toEqual(['/bundle/quantity:integer_invalid', '/bundle/maxPerOrder:integer_invalid']);
		// flash: an end is required, storewide refused by default, bounded duration
		expect(codes(validateDeal({ kind: 'flash', name: 'f', action: { type: 'percent', percent: 5 } }, rules))).toEqual([
			'/schedule/endsAt:required',
			'/scope:storewide_not_allowed',
		]);
		expect(
			codes(
				validateDeal(
					{
						kind: 'flash',
						name: 'f',
						scope: { items: ['a'] },
						action: { type: 'percent', percent: 5 },
						schedule: { startsAt: '2026-10-01T00:00:00Z', endsAt: '2026-12-01T00:00:00Z' },
					},
					rules,
				),
			),
		).toEqual(['/schedule/endsAt:duration_exceeded']);
	});

	it('normalises, patches and round-trips deals', () => {
		const deal = normaliseDeal(
			{
				kind: 'flash',
				name: ' Flash ',
				description: 'd',
				badge: { label: 'Now' },
				limits: { stockUnits: 3 },
				custom: { a: 1 },
				createdAt: 'c',
				updatedAt: 'u',
			},
			{ id: 'dl_1', rules, defaults: settings.defaults },
		);
		expect(deal).toMatchObject({
			name: 'Flash',
			class: 'item',
			priority: 100,
			badge: { label: 'Now', tone: 'urgent' },
			limits: { stockUnits: 3, perCustomer: null },
			combinesWithCoupons: true,
		});
		const input = dealInput(deal);
		expect(input).toMatchObject({
			kind: 'flash',
			description: 'd',
			badge: { label: 'Now', tone: 'urgent' },
			limits: { stockUnits: 3 },
			custom: { a: 1 },
		});
		const plain = dealInput(
			normaliseDeal(
				{ kind: 'bundle', name: 'b', bundle: { type: 'mix_and_match' } },
				{ id: 'dl_2', rules, defaults: settings.defaults },
			),
		);
		expect(plain).toMatchObject({ badge: { tone: 'accent' }, bundle: { type: 'mix_and_match' } });
		expect(plain.limits).toBeUndefined();
		expect(mergePatch({ a: { b: 1, c: 2 } }, { a: { b: null, d: 3 } })).toEqual({ a: { c: 2, d: 3 } });
		expect(mergePatch({ a: 1 }, 5)).toBe(5);
		expect(mergePatch(/** @type {any} */ (null), { a: { b: 1 } })).toEqual({ a: { b: 1 } });
	});
});

describe('locks (pure)', () => {
	const claims = lockClaims({
		websiteId: 'web_1',
		currency: 'EUR',
		itemId: 'i',
		variantId: null,
		unitAmount: 1000,
		unitPrice: 800,
		units: 2,
		dealIds: ['dl_1'],
		classes: ['item', 'item'],
		customerId: 'cus_1',
		ttlMinutes: 15,
		now: NOW,
	});
	const line = normaliseLine({ itemId: 'i', quantity: 1, unitAmount: 1000 }, 0);
	const policy = /** @type {const} */ ({ onExpired: 'reprice', onBasePriceChange: 'honor', graceSeconds: 30 });
	const apply = (/** @type {Record<string, any>} */ extra = {}) =>
		applyLock(claims, { websiteId: 'web_1', currency: 'EUR', line, customerId: 'cus_1', now: NOW, policy, ...extra });
	it('checks claims structurally and applies them to a line', () => {
		expect(isLockClaims(claims)).toBe(true);
		expect(claims.k).toEqual(['item']);
		expect(isLockClaims({ ...claims, d: [] })).toBe(false);
		expect(isLockClaims(null)).toBe(false);
		expect(apply()).toMatchObject({ status: 'honoured', candidate: { unitPrice: 800, maxUnits: 2 } });
		expect(apply({ websiteId: 'web_2' })).toEqual({ status: 'mismatch', reason: 'website' });
		expect(apply({ currency: 'USD' })).toEqual({ status: 'mismatch', reason: 'currency' });
		expect(apply({ line: { ...line, itemId: 'j' } })).toEqual({ status: 'mismatch', reason: 'item' });
		expect(apply({ customerId: null })).toEqual({ status: 'mismatch', reason: 'customer' });
		expect(apply({ now: NOW + 15 * 60_000 + 20_000 }).status).toBe('honoured');
		expect(apply({ now: NOW + 16 * 60_000 })).toEqual({ status: 'stale', reason: 'expired' });
		expect(apply({ line: { ...line, unitAmount: 700 } })).toMatchObject({ candidate: { unitPrice: 700 } });
		expect(apply({ line: { ...line, unitAmount: 700 }, policy: { ...policy, onBasePriceChange: 'reprice' } })).toEqual({
			status: 'stale',
			reason: 'base_price_changed',
		});
	});
});

describe('display views', () => {
	const deal = normaliseDeal(
		{
			kind: 'flash',
			name: 'Flash',
			scope: { items: ['i'] },
			action: { type: 'percent', percent: 20 },
			schedule: { endsAt: new Date(NOW + 3_600_000).toISOString() },
			limits: { stockUnits: 4 },
			conditions: {
				minSubtotal: 100,
				paymentMethods: ['card'],
				deliveryMethods: ['pickup'],
				minQuantity: 1,
				newCustomersOnly: false,
			},
		},
		{ id: 'dl_f', rules, defaults: settings.defaults },
	);
	it('builds deal cards and sorts them', () => {
		const card = dealCard(deal, { now: NOW, timeZone: 'UTC', usage: { dl_f: { uses: 1, units: 1 } } });
		expect(card).toMatchObject({
			stockLeft: 3,
			conditions: { minSubtotal: 100, paymentMethods: ['card'], deliveryMethods: ['pickup'], minQuantity: 1 },
			schedule: { active: true },
		});
		expect(stockLeft({ ...deal, limits: { ...deal.limits, stockUnits: null } }, {})).toBeNull();
		const a = { ...card, id: 'a', priority: 1, createdAt: '2026-01-02', schedule: { ...card.schedule, activeUntil: null } };
		const b = { ...card, id: 'b', priority: 2, createdAt: '2026-01-01' };
		expect(sortCards([a, b], 'priority').map((c) => c.id)).toEqual(['b', 'a']);
		expect(sortCards([a, b], 'ending_soon').map((c) => c.id)).toEqual(['b', 'a']);
		expect(sortCards([a, b], 'newest').map((c) => c.id)).toEqual(['a', 'b']);
		expect(
			sortCards(
				[
					{ ...a, id: 'c', createdAt: undefined },
					{ ...a, id: 'd', createdAt: undefined, priority: 1 },
				],
				'newest',
			).map((c) => c.id),
		).toEqual(['c', 'd']);
	});
	it('evaluates one item: conditional deals become pills, not prices', () => {
		const plain = normaliseDeal(
			{ kind: 'item', name: 'Plain', scope: { items: ['i'] }, action: { type: 'amount_off', amount: 100 } },
			{ id: 'dl_p', rules, defaults: settings.defaults },
		);
		const offer = evaluateItem({
			line: normaliseLine({ itemId: 'i', quantity: 1, unitAmount: 1000 }, 0),
			currency: 'EUR',
			deals: [deal, plain],
			usage: {},
			customerUsage: {},
			customer: { id: null, segments: [], orders: null, tags: [] },
			settings: settings.engine,
			display: { ...settings.display, maxPills: 5, countdownWithinMs: 0 },
			now: NOW,
		});
		expect(offer).toMatchObject({ price: 900, discount: 100, percentOff: 10, countdown: null, badge: { dealId: 'dl_p' } });
		expect(offer.pills.map((p) => [p.dealId, p.conditional])).toEqual([
			['dl_p', false],
			['dl_f', true],
		]);
	});
});

describe('request validation and config', () => {
	it('validates quotes, offers, items and commits', () => {
		expect(validateQuote({ currency: 'EUR', lines: [{ itemId: 'a', quantity: 1, unitAmount: 1 }] }, { maxLines: 10 })).toEqual(
			[],
		);
		expect(
			codes(
				validateQuote(
					{
						currency: 'EUR',
						lines: [
							{
								itemId: 'a b',
								quantity: 0,
								unitAmount: -1,
								lineId: 'x',
								attributes: { 'a.b': 1 },
								collections: 'x',
								brand: 5,
							},
							{ itemId: 'b', quantity: 1, unitAmount: 1, lineId: 'x' },
						],
						customer: { id: 5, segments: ['a b'], orders: -1, tags: 'x', other: 1 },
						paymentMethod: 'a b',
						shippingAmount: 1.5,
						cartId: 'a b',
						locks: [5],
					},
					{ maxLines: 10 },
				),
			),
		).toEqual(
			expect.arrayContaining([
				'/lines/0/itemId:id_invalid',
				'/lines/0/quantity:integer_invalid',
				'/lines/0/unitAmount:amount_invalid',
				'/lines/0/attributes:attribute_invalid',
				'/lines/0/collections:list_invalid',
				'/lines/0/brand:id_invalid',
				'/lines:line_ids_not_unique',
				'/customer/other:unknown_field',
				'/customer/id:id_invalid',
				'/customer/segments:list_invalid',
				'/customer/tags:list_invalid',
				'/customer/orders:integer_invalid',
				'/paymentMethod:key_invalid',
				'/shippingAmount:amount_invalid',
				'/cartId:id_invalid',
				'/locks:locks_invalid',
			]),
		);
		expect(
			codes(
				validateQuote(
					{ currency: 'EUR', lines: Array(11).fill({ itemId: 'a', quantity: 1, unitAmount: 1 }) },
					{ maxLines: 10 },
				),
			),
		).toEqual(['/lines:lines_invalid']);
		expect(codes(validateOffers({ items: [], currency: 'x', lock: 1 }, { maxItems: 5 }))).toEqual([
			'/currency:currency_invalid',
			'/items:items_invalid',
			'/lock:boolean_invalid',
		]);
		expect(codes(validateOffers({ items: [{ itemId: 'a' }], customer: { id: 'c' } }, { maxItems: 5 }))).toEqual([]);
		expect(
			codes(
				validateItem(
					{
						itemId: 'a',
						title: '',
						brand: 5,
						collections: [1],
						attributes: [],
						price: -1,
						currency: 'eur',
						url: 'javascript:x',
						variants: [{ variantId: 'v', title: '', price: -1, attributes: 'x', x: 1 }, 'x'],
					},
					{ maxVariants: 5 },
				),
			),
		).toEqual(
			expect.arrayContaining([
				'/title:text_invalid',
				'/brand:id_invalid',
				'/collections:list_invalid',
				'/attributes:object_invalid',
				'/price:amount_invalid',
				'/currency:currency_invalid',
				'/url:url_invalid',
				'/variants/0/x:unknown_field',
				'/variants/0/title:text_invalid',
				'/variants/0/price:amount_invalid',
				'/variants/0/attributes:object_invalid',
				'/variants/1:body_invalid',
			]),
		);
		expect(codes(validateItem({ itemId: 'a', variants: [{}, {}] }, { maxVariants: 1 }))).toEqual([
			'/variants:variants_invalid',
		]);
		expect(
			codes(
				validateItem(
					{ itemId: 'a', attributes: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`a${i}`, 'x'])) },
					{ maxVariants: 1 },
				),
			),
		).toEqual(['/attributes:too_many']);
		expect(catalogItem({ itemId: 'a' })).toMatchObject({ itemId: 'a', collections: [], variants: [], price: null });
		expect(codes(validateCommit({ orderId: 'a b', customerId: '', expectedTotal: -1 }))).toEqual([
			'/orderId:id_invalid',
			'/customerId:id_invalid',
			'/expectedTotal:amount_invalid',
		]);
		expect(codes(validateCommit('x'))).toEqual([':body_invalid']);
	});

	it('overlays configuration on schema defaults with type checks', () => {
		const schema = {
			properties: {
				a: { type: 'integer', default: 1 },
				b: { type: 'string', default: 'x' },
				c: { type: 'boolean', default: true },
				d: { type: 'array', default: [] },
				e: { type: 'object', default: {} },
				f: { type: 'number', default: 1.5 },
				g: { default: null },
			},
		};
		expect(effectiveConfig(schema, { a: 'no', b: 2, c: false, d: [1], e: { x: 1 }, f: 2.5, g: 'any', z: 1 })).toEqual({
			a: 1,
			b: 'x',
			c: false,
			d: [1],
			e: { x: 1 },
			f: 2.5,
			g: 'any',
		});
		const off = settingsFrom({
			can: (key) => key !== 'stacking',
			config: (key) => (key === 'stacking' ? { classes: [] } : key === 'quote_api' ? { time_zone: 'Bad/Zone' } : {}),
		});
		expect(off.timeZone).toBe('UTC');
		expect(off.engine).toMatchObject({ strategy: 'best_for_customer', maxDealsPerLine: 1 });
		expect(off.dealRules.kinds.item.defaultClass).toBe('item');
	});
});
