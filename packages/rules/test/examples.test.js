import { describe, expect, it } from 'vitest';
import { check, evaluateCondition, explain } from '../src/index.js';
import { prog, run } from './helpers.js';

/**
 * Realistic rules from the product specs (PLAN Part D). Each case: source, context, expected value, options.
 * @type {Array<{ name: string, src: string, ctx: Record<string, unknown>, expected: unknown, now?: string, timeZone?: string }>}
 */
const EXAMPLES = [
	// --- Offers & coupons (eligibility, L4) ---
	{
		name: 'coupon: first order over PKR 5,000, not wholesale',
		src: "order.subtotal >= 5000 and count(customer.orders) == 0 and not inSegment('wholesale')",
		ctx: { order: { subtotal: 6200 }, customer: { orders: [] }, segments: ['newsletter'] },
		expected: true,
	},
	{
		name: 'coupon: excluded when a sale item is in the cart',
		src: "not any(order.lines, 'sale' in it.tags) and order.subtotal >= 3000",
		ctx: {
			order: {
				subtotal: 4000,
				lines: [
					{ sku: 'P1', tags: ['new'] },
					{ sku: 'P2', tags: ['sale'] },
				],
			},
		},
		expected: false,
	},
	{
		name: 'coupon: brand + payment method + country',
		src: "any(order.lines, it.brand in ['Samsung', 'Apple']) and order.payment.method != 'cod' and order.shipping.country == 'PK'",
		ctx: { order: { lines: [{ brand: 'Apple' }], payment: { method: 'bank_transfer' }, shipping: { country: 'PK' } } },
		expected: true,
	},
	{
		name: 'coupon: referral source and device',
		src: "(like(session.referrer, '*instagram.com*') or session.utm.source == 'ig') and session.device == 'mobile'",
		ctx: { session: { referrer: 'https://l.instagram.com/?u=x', utm: {}, device: 'mobile' } },
		expected: true,
	},
	{
		name: 'offer: buy-3 bundle quantity threshold on a category',
		src: "sum(filter(order.lines, it.category == 'cases'), 'qty') >= 3",
		ctx: {
			order: {
				lines: [
					{ category: 'cases', qty: 2 },
					{ category: 'chargers', qty: 5 },
					{ category: 'cases', qty: 1 },
				],
			},
		},
		expected: true,
	},
	// --- Loyalty (formulas) ---
	{
		name: 'loyalty: 1 point per PKR 100, doubled for gold',
		src: "floor(order.total / 100) * (customer.tier == 'gold' ? 2 : 1)",
		ctx: { order: { total: 12345 }, customer: { tier: 'gold' } },
		expected: 246,
	},
	{
		name: 'loyalty: points capped per order with campaign multiplier',
		src: 'min(round(order.total * 0.05 * coalesce(campaign.multiplier, 1)), 500)',
		ctx: { order: { total: 25000 }, campaign: null },
		expected: 500,
	},
	{
		name: 'loyalty: tier upgrade on 12-month spend',
		src: "sum(filter(customer.orders, daysSince(it.placedAt) <= 365), 'total') >= 100000 ? 'gold' : 'silver'",
		ctx: {
			customer: {
				orders: [
					{ placedAt: '2026-09-01T00:00:00Z', total: 60000 },
					{ placedAt: '2026-03-01T00:00:00Z', total: 45000 },
					{ placedAt: '2024-01-01T00:00:00Z', total: 90000 },
				],
			},
		},
		expected: 'gold',
	},
	{
		name: 'loyalty: birthday bonus in the store time zone',
		src: "dateParts(now, 'Asia/Karachi').month == customer.birthMonth and dateParts(now, 'Asia/Karachi').day == customer.birthDay",
		ctx: { customer: { birthMonth: 10, birthDay: 2 } },
		now: '2026-10-01T20:00:00Z',
		expected: true,
	},
	// --- Deals (schedule) ---
	{
		name: 'deal: weekend evening flash sale (Karachi)',
		src: "dateParts(now, 'Asia/Karachi').weekday >= 6 and between(now, '18:00', '23:00', 'Asia/Karachi')",
		ctx: {},
		now: '2026-10-03T14:30:00Z', // Saturday 19:30 PKT
		expected: true,
	},
	{
		name: 'deal: late-night window crossing midnight',
		src: "between(now, '22:00', '02:00')",
		ctx: {},
		now: '2026-10-02T01:15:00+05:00',
		timeZone: 'Asia/Karachi',
		expected: true,
	},
	{
		name: 'deal: active between campaign dates',
		src: 'now >= deal.startsAt and now < deal.endsAt and deal.stock > 0',
		ctx: { deal: { startsAt: '2026-09-28T00:00:00Z', endsAt: '2026-10-05T00:00:00Z', stock: 12 } },
		expected: true,
	},
	// --- Chatbot (proactive trigger) ---
	{
		name: 'chat: proactive greeting on product pages after 3 views, never twice',
		src: "session.pageViews >= 3 and like(page.path, '/products/*') and not has(session.chatOpenedAt)",
		ctx: { session: { pageViews: 4 }, page: { path: '/products/galaxy-s25' } },
		expected: true,
	},
	{
		name: 'chat: exit intent on cart with high value, inside working hours',
		src: "event.type == 'exit_intent' and cart.total > 20000 and between(now, '09:00', '21:00', 'Asia/Karachi')",
		ctx: { event: { type: 'exit_intent' }, cart: { total: 45000 } },
		now: '2026-10-01T10:00:00Z',
		expected: true,
	},
	// --- Automations (conditions) ---
	{
		name: 'automation: win-back after 60 days inactive, opted in',
		src: 'daysSince(customer.lastOrderAt) > 60 and customer.consent.whatsapp == true',
		ctx: { customer: { lastOrderAt: '2026-07-01T00:00:00Z', consent: { whatsapp: true } } },
		expected: true,
	},
	{
		name: 'automation: order.placed with COD above cap needs confirmation',
		src: "event.type == 'order.placed' and event.data.payment.method == 'cod' and event.data.total > 50000",
		ctx: { event: { type: 'order.placed', data: { payment: { method: 'cod' }, total: 72000 } } },
		expected: true,
	},
	{
		name: 'automation: abandoned cart reminder after 2 hours',
		src: "hoursSince(cart.updatedAt) >= 2 and len(cart.items) > 0 and cart.status == 'open'",
		ctx: { cart: { updatedAt: '2026-10-01T09:30:00Z', items: [1], status: 'open' } },
		expected: true,
	},
	// --- Configurator (dependencies) ---
	{
		name: 'configurator: engraving only for metal cases',
		src: "selection.material in ['steel', 'titanium'] and len(trim(coalesce(selection.engraving, ''))) <= 20",
		ctx: { selection: { material: 'titanium', engraving: ' Ali ' } },
		expected: true,
	},
	{
		name: 'configurator: price delta formula',
		src: "base.price + (selection.storage == '256GB' ? 15000 : 0) + count(selection.addons) * 2500",
		ctx: { base: { price: 180000 }, selection: { storage: '256GB', addons: ['case', 'glass'] } },
		expected: 200000,
	},
	// --- Alerts (thresholds) ---
	{
		name: 'alerts: price drop of at least 10 %',
		src: 'item.previousPrice > 0 and (item.previousPrice - item.price) / item.previousPrice >= 0.1',
		ctx: { item: { previousPrice: 50000, price: 44900 } },
		expected: true,
	},
	{
		name: 'alerts: back in stock for watchers',
		src: 'item.stock > 0 and item.previousStock == 0',
		ctx: { item: { stock: 3, previousStock: 0 } },
		expected: true,
	},
	{
		name: 'alerts: low-stock threshold per variant',
		src: 'any(item.variants, it.stock <= coalesce(it.lowStockAt, 5))',
		ctx: { item: { variants: [{ stock: 10 }, { stock: 4 }] } },
		expected: true,
	},
	// --- Segments & analytics ---
	{
		name: 'segment: VIP by tags or lifetime value',
		src: "customer.tags contains 'vip' or sum(customer.orders, 'total') >= 250000",
		ctx: { customer: { tags: [], orders: [{ total: 200000 }, { total: 60000 }] } },
		expected: true,
	},
	{
		name: 'segment: email domain (case-insensitive glob)',
		src: "ilike(customer.email, '*@*.edu.pk')",
		ctx: { customer: { email: 'Student@LUMS.edu.pk' } },
		expected: true,
	},
	{
		name: 'kpi: average order value, rounded',
		src: "round(avg(orders, 'total'), 2)",
		ctx: { orders: [{ total: 1000 }, { total: 2000 }, { total: 2500.555 }] },
		expected: 1833.52,
	},
	{
		name: 'placement: missing data never matches (safe navigation)',
		src: 'customer.profile.age >= 18',
		ctx: {},
		expected: false,
	},
];

describe('realistic product rules', () => {
	it('has at least 20 examples', () => expect(EXAMPLES.length).toBeGreaterThanOrEqual(20));
	for (const ex of EXAMPLES) {
		it(ex.name, () => {
			const options = { ...(ex.now ? { now: ex.now } : {}), ...(ex.timeZone ? { timeZone: ex.timeZone } : {}) };
			expect(run(ex.src, ex.ctx, options)).toEqual(ex.expected);
			const c = check(ex.src);
			expect(c.ok).toBe(true);
		});
	}

	it('explains why a coupon did not apply', () => {
		const p = prog("order.subtotal >= 5000 and count(customer.orders) == 0 and not inSegment('wholesale')");
		const r = explain(p, { order: { subtotal: 6200 }, customer: { orders: [{ id: 1 }] }, segments: [] });
		expect(r.ok && r.value).toBe(false);
		const failed = r.trace?.children.find((f) => f.value === false);
		expect(failed?.expr).toBe('count(customer.orders) == 0');
		expect(r.trace?.children.at(-1)).toMatchObject({ expr: "not inSegment('wholesale')", skipped: true });
	});

	it('evaluateCondition turns errors into non-matches for callers', () => {
		const p = prog('any(xs, it > 0)');
		const r = evaluateCondition(p, { xs: Array.from({ length: 20000 }, () => 0) });
		expect(r.ok).toBe(false);
	});
});
