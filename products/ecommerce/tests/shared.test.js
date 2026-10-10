/**
 * The shared parts: the order flow's role rules, the dashboard's list settings, the joined data-rights answers and
 * widget settings, and the public script and docs routes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	DEFAULT_FLOW,
	canMove,
	cancelledStatus,
	checkOrderFlow,
	confirmedStatus,
	nextStatuses,
	statusOf,
	statusWithRole,
} from '../core/flow.js';
import { allocate, fromDecimal, isPrice, percentOf, toDecimal } from '../core/money.js';
import { readyShop } from './helpers.js';

describe('the order flow', () => {
	it('accepts the default flow and refuses flows that break the role rules', () => {
		expect(checkOrderFlow(DEFAULT_FLOW)).toEqual({ ok: true, value: DEFAULT_FLOW });
		expect(checkOrderFlow(null)).toEqual({ ok: false, errors: ['The flow needs statuses and moves.'] });
		const broken = checkOrderFlow({
			statuses: [
				...DEFAULT_FLOW.statuses,
				{ key: 'confirmed', label: '', role: 'open' },
				{ key: 'X', label: 'Bad', role: 'open' },
				{ key: 'odd', label: 'Odd', role: 'nope' },
				'junk',
			],
			moves: [{ from: 'delivered', to: 'cancelled' }, { from: 'ghost', to: 'confirmed' }, 'junk'],
		});
		expect(broken.ok).toBe(false);
		if (!broken.ok) expect(broken.errors.length).toBeGreaterThanOrEqual(5);
		const missing = checkOrderFlow({ statuses: [{ key: 'only', label: 'Only', role: 'open' }], moves: [] });
		expect(missing.ok).toBe(false);
		const many = checkOrderFlow({
			statuses: Array.from({ length: 31 }, (_, i) => ({ key: `s${i}`, label: 'S', role: 'open' })),
			moves: [],
		});
		expect(many.ok).toBe(false);
		const twice = checkOrderFlow({ ...DEFAULT_FLOW, moves: [...DEFAULT_FLOW.moves, DEFAULT_FLOW.moves[0]] });
		expect(twice.ok && twice.value.moves.length).toBe(DEFAULT_FLOW.moves.length);
	});

	it('answers moves and the statuses a waiting order goes to', () => {
		expect(statusOf(DEFAULT_FLOW, 'packed')?.role).toBe('packed');
		expect(statusOf(DEFAULT_FLOW, 'nope')).toBeNull();
		expect(statusWithRole(DEFAULT_FLOW, 'refunded')).toBe('refunded');
		expect(statusWithRole({ statuses: [], moves: [] }, 'refunded')).toBe('');
		expect(canMove(DEFAULT_FLOW, 'dispatched', 'returned')).toBe(true);
		expect(canMove(DEFAULT_FLOW, 'delivered', 'cancelled')).toBe(false);
		expect(canMove(DEFAULT_FLOW, 'ghost', 'cancelled')).toBe(false);
		expect(nextStatuses(DEFAULT_FLOW, 'pending_payment').map((s) => s.key)).toEqual(['confirmed', 'cancelled']);
		expect(confirmedStatus(DEFAULT_FLOW, 'awaiting_confirmation')).toBe('confirmed');
		expect(confirmedStatus(DEFAULT_FLOW, 'delivered')).toBeNull();
		expect(cancelledStatus(DEFAULT_FLOW, 'pending_payment')).toBe('cancelled');
		expect(cancelledStatus(DEFAULT_FLOW, 'delivered')).toBe('cancelled');
	});
});

describe('money', () => {
	it('converts, splits and checks amounts', () => {
		expect(toDecimal(5, 'USD')).toBe('0.05');
		expect(toDecimal(5, 'JPY')).toBe('5');
		expect(toDecimal(1234, 'KWD')).toBe('1.234');
		expect(fromDecimal('10.5', 'USD')).toBe(1050);
		expect(fromDecimal(3, 'JPY')).toBe(3);
		expect(fromDecimal('1.005', 'USD')).toBeNull();
		expect(fromDecimal('1.000', 'USD')).toBe(100);
		expect(fromDecimal(null, 'USD')).toBeNull();
		expect(isPrice(0)).toBe(true);
		expect(isPrice(-1)).toBe(false);
		expect(percentOf(1000, 12.5)).toBe(125);
		expect(percentOf(1000, 150)).toBe(1000);
		expect(allocate(10, [1, 1, 1])).toEqual([4, 3, 3]);
		expect(allocate(10, [0, 0])).toEqual([0, 0]);
		expect(allocate(0, [1])).toEqual([0]);
	});
});

describe('shared routes', () => {
	/** @type {Awaited<ReturnType<typeof readyShop>>} */
	let shop;
	beforeAll(async () => {
		shop = await readyShop();
	});
	afterAll(async () => shop.product.close());

	it('serve the widget script and the docs without tokens', async () => {
		const script = await shop.call('GET', '/widget.js');
		expect(script.status).toBe(200);
		expect(script.headers.get('content-type')).toContain('javascript');
		const docs = await shop.call('GET', '/docs');
		expect(docs.headers.get('content-type')).toContain('text/html');
	});

	it('edit list settings in the dashboard, checked, with Recent changes', async () => {
		const cookie = await shop.adminSession();
		const path = `/v1/dashboard/websites/${shop.websiteId}/lists`;
		expect((await shop.dashboard(cookie, 'GET', `${path}/order_flow`)).json.value).toEqual(DEFAULT_FLOW);
		expect((await shop.dashboard(cookie, 'GET', `${path}/nothing`)).status).toBe(404);
		const bad = await shop.dashboard(cookie, 'PUT', `${path}/order_flow`, { value: { statuses: [], moves: [] } });
		expect(bad.status).toBe(422);
		const saved = await shop.list('couriers', [
			{ key: 'fast', name: 'Fast', trackingUrl: 'https://fast.example/t/{tracking}' },
		]);
		expect(saved).toHaveLength(1);
		const overview = await shop.dashboard(cookie, 'GET', `/v1/dashboard/websites/${shop.websiteId}/overview`);
		expect(JSON.stringify(overview.json)).toContain('Couriers: changed');
		// a merchant edits only the lists of switched-on features
		await shop.switchOn(['catalog']);
		const launch = await shop.portal.issueLaunch({
			productId: 'ecommerce',
			kind: 'merchant',
			websiteId: shop.websiteId,
		});
		const merchant = (await shop.call('GET', `/sso?launch=${launch}`)).headers.get('set-cookie')?.split(';')[0] ?? '';
		const refused = await shop.dashboard(merchant, 'PUT', `${path}/tax_rules`, { value: [] });
		expect(refused.status).toBe(403);
	});

	it('join every part’s data-rights answers and widget settings', async () => {
		await shop.switchOn();
		const exported = await shop.api('POST', '/v1/data-rights/export', {
			user: { id: 'usr_nobody000000', email: 'x@example.com' },
		});
		expect(exported.status).toBe(200);
		expect(Object.keys(exported.json.records)).toEqual(expect.arrayContaining(['orders', 'loyalty']));
		const deleted = await shop.api('POST', '/v1/data-rights/delete', { user: { id: 'usr_nobody000000' } });
		expect(deleted.json).toMatchObject({ deleted: expect.any(Number), anonymised: expect.any(Number) });
		const config = await shop.visitor('GET', '/v1/widget/config');
		expect(config.json.settings).toMatchObject({
			currency: 'USD',
			catalog: { grades: [] },
			checkout: expect.any(Object),
			orders: { couriers: [{ key: 'fast', name: 'Fast' }] },
		});
		expect(config.json.settings.orders.statuses[0]).toEqual({ key: 'pending_payment', label: 'Awaiting payment' });
	});
});
