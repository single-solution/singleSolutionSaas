/**
 * codes element through app-kit's request handler with a real MongoDB: coupons (create with a shared code, a generated
 * shared code or bulk unique codes; list, get, merge-patch, archive), codes (list, generate, get, disable), plan
 * limits and validation problems, element gating and key kinds.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, ORIGIN, WEBSITE } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
beforeAll(async () => {
	h = await createHarness();
});
afterAll(async () => h?.close());

describe('coupons', () => {
	it('creates a coupon with a shared code (normalised, multi-use) and refuses a duplicate code', async () => {
		const created = await h.call('POST', '/v1/coupons', {
			body: { name: 'Autumn', code: ' autumn10 ', action: { type: 'percent', percent: 10 } },
		});
		expect(created.status).toBe(201);
		expect(created.headers.get('location')).toBe(`/v1/coupons/${created.json.id}`);
		expect(created.json).toMatchObject({
			name: 'Autumn',
			status: 'active',
			mode: 'shared',
			codes: 1,
			limits: { total: null, per_code: null },
			usage: { taken: 0, redeemed: 0 },
			generated: { count: 1, codes: ['AUTUMN10'] },
		});
		const code = await h.call('GET', '/v1/codes/autumn10');
		expect(code.json).toMatchObject({ code: 'AUTUMN10', couponId: created.json.id, maxUses: null, remaining: null });
		const duplicate = await h.call('POST', '/v1/coupons', {
			body: { name: 'Again', code: 'AUTUMN10', action: { type: 'percent', percent: 5 } },
		});
		expect(duplicate.status).toBe(409);
		expect(duplicate.json.type).toMatch(/\/code_taken$/);
		// a repeated Idempotency-Key on a coupon create is refused without running again
		const body = { name: 'Once', count: 2, action: { type: 'percent', percent: 5 } };
		expect((await h.call('POST', '/v1/coupons', { body, idempotencyKey: 'idk_once' })).status).toBe(201);
		const repeated = await h.call('POST', '/v1/coupons', { body, idempotencyKey: 'idk_once' });
		expect(repeated.status).toBe(409);
		expect(repeated.json.type).toMatch(/\/duplicate_request$/);
	});

	it('generates a shared code from a pattern, or bulk unique single-use codes', async () => {
		const generated = await h.coupon({ pattern: 'FALL-????-####', action: { type: 'fixed', amount: 500 }, currency: 'EUR' });
		const [code] = generated.generated.codes;
		expect(code).toMatch(/^FALL-[A-HJKMNP-Z2-9]{4}-\d{4}$/);
		const bulk = await h.coupon({ count: 25, pattern: 'VIP-????-????', action: { type: 'free_shipping' } });
		expect(bulk).toMatchObject({ mode: 'unique', codes: 25, limits: { per_code: 1 } });
		expect(new Set(bulk.generated.codes).size).toBe(25);
		const page1 = await h.call('GET', `/v1/coupons/${bulk.id}/codes?limit=10`);
		expect(page1.json.items).toHaveLength(10);
		expect(page1.json.items[0]).toMatchObject({ maxUses: 1, remaining: 1, status: 'active' });
		const page2 = await h.call(
			'GET',
			`/v1/coupons/${bulk.id}/codes?limit=10&cursor=${encodeURIComponent(page1.json.nextCursor)}`,
		);
		expect(page2.json.items.map((/** @type {any} */ c) => c.code)).not.toContain(page1.json.items[0].code);
		const more = await h.call('POST', `/v1/coupons/${bulk.id}/codes:generate`, { body: { count: 5 } });
		expect(more.status).toBe(201);
		expect(more.json).toMatchObject({ couponId: bulk.id, count: 5 });
		expect(more.json.codes[0]).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
		expect((await h.call('GET', `/v1/coupons/${bulk.id}`)).json.codes).toBe(30);
		const stored = await h.collection('codes').findOne({ code: more.json.codes[0] });
		expect(stored).toMatchObject({ websiteId: WEBSITE, batchId: more.json.batchId, taken: 0 });
	});

	it('refuses weak patterns, invalid bodies and missing currencies with field problems', async () => {
		const weak = await h.call('POST', '/v1/coupons', {
			body: { name: 'Weak', pattern: 'AB-??', action: { type: 'percent', percent: 5 } },
		});
		expect(weak.status).toBe(422);
		expect(weak.json.errors).toEqual([expect.objectContaining({ path: '/pattern', code: 'pattern_too_weak' })]);
		const invalid = await h.call('POST', '/v1/coupons', {
			body: { name: '', action: { type: 'percent', percent: 150 }, extra: true },
		});
		expect(invalid.status).toBe(422);
		expect(invalid.json.errors.map((/** @type {any} */ e) => `${e.path}:${e.code}`)).toEqual(
			expect.arrayContaining(['/extra:unknown_field', '/name:text_invalid', '/action/percent:percent_invalid']),
		);
		const money = await h.call('POST', '/v1/coupons', { body: { name: 'Money', action: { type: 'fixed', amount: 100 } } });
		expect(money.json.errors).toEqual([expect.objectContaining({ path: '/currency', code: 'required' })]);
		const both = await h.call('POST', '/v1/coupons', {
			body: { name: 'Both', code: 'BOTHCODE', count: 3, action: { type: 'percent', percent: 5 } },
		});
		expect(both.json.errors).toEqual([expect.objectContaining({ path: '/count', code: 'conflicts_with_code' })]);
		const rule = await h.call('POST', '/v1/coupons', {
			body: { name: 'Rule', action: { type: 'percent', percent: 5 }, eligibility: { when: 'cart.subtotal >=' } },
		});
		expect(rule.json.errors[0]).toMatchObject({ path: '/eligibility/when', code: 'rule_syntax' });
	});

	it('lists, merge-patches (validated) and archives coupons; archived codes stop working', async () => {
		const coupon = await h.coupon({ code: 'PATCHME', action: { type: 'percent', percent: 10 } });
		const patched = await h.call('PATCH', `/v1/coupons/${coupon.id}`, {
			body: { status: 'paused', limits: { total: 3 }, description: 'Paused for now' },
		});
		expect(patched.status).toBe(200);
		expect(patched.json).toMatchObject({ status: 'paused', limits: { total: 3 }, description: 'Paused for now' });
		const removed = await h.call('PATCH', `/v1/coupons/${coupon.id}`, { body: { limits: { total: null } } });
		expect(removed.json.limits.total).toBeNull();
		const bad = await h.call('PATCH', `/v1/coupons/${coupon.id}`, { body: { action: { type: 'percent', percent: 0 } } });
		expect(bad.status).toBe(422);
		expect((await h.call('PATCH', `/v1/coupons/${coupon.id}`, { body: [] })).status).toBe(422);
		expect((await h.call('PATCH', '/v1/coupons/cpn_missing', { body: { name: 'x' } })).status).toBe(404);
		const paused = await h.call('GET', '/v1/coupons?status=paused');
		expect(paused.json.items.map((/** @type {any} */ c) => c.id)).toContain(coupon.id);
		const archived = await h.call('DELETE', `/v1/coupons/${coupon.id}`);
		expect(archived.json).toMatchObject({ status: 'archived' });
		expect(archived.json.archivedAt).toBeTruthy();
		expect((await h.call('DELETE', `/v1/coupons/${coupon.id}`)).json.status).toBe('archived');
		expect((await h.call('DELETE', '/v1/coupons/cpn_missing')).status).toBe(404);
		expect((await h.call('GET', '/v1/coupons/cpn_missing')).status).toBe(404);
		expect((await h.call('GET', '/v1/coupons/cpn_missing/codes')).status).toBe(404);
		expect((await h.call('POST', `/v1/coupons/${coupon.id}/codes:generate`, { body: { count: 1 } })).json.type).toMatch(
			/coupon_inactive$/,
		);
		expect((await h.call('POST', '/v1/coupons/cpn_missing/codes:generate', { body: { count: 1 } })).status).toBe(404);
		const validation = await h.call('POST', '/v1/validations', {
			body: { code: 'PATCHME', cart: { currency: 'EUR', lines: [{ itemId: 'i', quantity: 1, unitAmount: 100 }] } },
		});
		expect(validation.json).toMatchObject({ valid: false, reason: 'coupon_inactive' });
	});

	it('disables and re-enables single codes', async () => {
		const coupon = await h.coupon({ code: 'TOGGLE', action: { type: 'percent', percent: 10 } });
		expect((await h.call('PATCH', '/v1/codes/toggle', { body: { status: 'disabled' } })).json.status).toBe('disabled');
		expect((await h.call('PATCH', '/v1/codes/TOGGLE', { body: { status: 'nope' } })).status).toBe(422);
		expect((await h.call('PATCH', '/v1/codes/MISSING', { body: { status: 'active' } })).status).toBe(404);
		expect((await h.call('GET', '/v1/codes/MISSING')).status).toBe(404);
		expect((await h.call('PATCH', '/v1/codes/TOGGLE', { body: { status: 'active' } })).json).toMatchObject({
			status: 'active',
			couponId: coupon.id,
		});
	});

	it('enforces plan limits and element switches', async () => {
		await h.entitle({ config: { codes: { max_active_coupons: 1 } } });
		const full = await h.call('POST', '/v1/coupons', { body: { name: 'Over', action: { type: 'percent', percent: 5 } } });
		expect(full.status).toBe(409);
		expect(full.json.type).toMatch(/limit_reached$/);
		await h.entitle({ elements: { eligibility: false, limits: false, stacking: false } });
		const noRules = await h.call('POST', '/v1/coupons', {
			body: {
				name: 'R',
				action: { type: 'percent', percent: 5 },
				eligibility: { conditions: [{ type: 'subtotal', operator: 'gte', value: 1 }] },
				currency: 'EUR',
			},
		});
		expect(noRules.status).toBe(422);
		expect(noRules.json.type).toMatch(/element_off$/);
		const noLimits = await h.call('POST', '/v1/coupons', {
			body: { name: 'L', action: { type: 'percent', percent: 5 }, limits: { per_customer: 1 } },
		});
		expect(noLimits.json.type).toMatch(/element_off$/);
		const noStacking = await h.call('POST', '/v1/coupons', {
			body: { name: 'S', action: { type: 'percent', percent: 5 }, stacking: { exclusive: true } },
		});
		expect(noStacking.json.type).toMatch(/element_off$/);
		await h.entitle({ elements: { codes: false } });
		expect((await h.call('GET', '/v1/coupons')).status).toBe(403);
		await h.entitle();
	});

	it('serves coupons to server keys only', async () => {
		const browser = await h.call('GET', '/v1/coupons', { key: h.pk, headers: ORIGIN });
		expect(browser.status).toBe(403);
		expect((await h.call('GET', '/v1/coupons', { key: null })).status).toBe(401);
	});
});
