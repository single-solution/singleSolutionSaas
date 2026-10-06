/** Free-tier scheduling: the background dispatch pass after requests, and expiry honoured at read time. */
import { afterEach, describe, expect, it } from 'vitest';
import { DISPATCH_BUDGET_MS, DISPATCH_INTERVAL_MS } from '../jobs/dispatch.js';
import { createHarness, WEBSITE, WEBSITE_2 } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>> | null} */
let h = null;
afterEach(async () => {
	await h?.close();
	h = null;
});
/** @param {Parameters<typeof createHarness>[0]} [options] */
const harness = async (options) => (h = await createHarness(options));
const DAY = 24 * 3_600_000;

/** @param {Awaited<ReturnType<typeof createHarness>>} t @param {string} itemId */
const restock = (t, itemId) =>
	t.deliver('inventory.changed@1', { itemId, quantity: 3, previousQuantity: 0 }, { occurredAt: t.clock.now() });

describe('background dispatch', () => {
	it('is registered per website and sends due messages when triggered (throttled per interval)', async () => {
		const t = await harness({ config: { dispatch: { inline_dispatch: false } } });
		expect(t.alerts.tasks.dispatch.name).toBe('dispatch');
		expect(DISPATCH_INTERVAL_MS).toBe(5 * 60_000);
		expect(DISPATCH_BUDGET_MS).toBeLessThan(DISPATCH_INTERVAL_MS);
		await t.subscribe({}, { key: t.pk });
		await restock(t, 'itm_1');
		expect(t.provider.sent).toHaveLength(0);
		expect(await t.alerts.tasks.dispatch.trigger({ websiteId: WEBSITE })).toBe(true);
		expect(t.provider.sent).toHaveLength(1);
		const [sub] = await t.collection('subscriptions').find({ websiteId: WEBSITE }).toArray();
		expect(sub?.status).toBe('notified');
		// throttled until the interval passed; per website, never without one
		expect(await t.alerts.tasks.dispatch.trigger({ websiteId: WEBSITE })).toBe(false);
		expect(await t.alerts.tasks.dispatch.trigger()).toBe(false);
		t.clock.advance(DISPATCH_INTERVAL_MS);
		expect(await t.alerts.tasks.dispatch.trigger({ websiteId: WEBSITE })).toBe(true);
		// a website without an entitlement is skipped quietly
		expect(await t.alerts.tasks.dispatch.trigger({ websiteId: WEBSITE_2 })).toBe(true);
		expect(t.provider.sent).toHaveLength(1);
	});

	it('claims no message once the time budget is spent', async () => {
		const t = await harness({ config: { dispatch: { inline_dispatch: false } } });
		await t.subscribe({}, { key: t.pk });
		await restock(t, 'itm_1');
		const site = await t.site();
		expect(await t.alerts.dispatcher.run(site, { deadline: t.clock.now() })).toMatchObject({ sent: 0 });
		expect(await t.alerts.dispatcher.run(site, { deadline: t.clock.now() + 1 })).toMatchObject({ sent: 1 });
	});
});

describe('expiry at read time', () => {
	it('never notifies a subscription past its expiry, even before the TTL monitor removed it', async () => {
		const t = await harness({ config: { types: { pending_max_days: 1 } } });
		await t.subscribe({}, { key: t.pk });
		t.clock.advance(DAY + 1);
		await restock(t, 'itm_1');
		expect(t.provider.sent).toHaveLength(0);
		expect(await t.collection('messages').countDocuments({ websiteId: WEBSITE })).toBe(0);
		expect(await t.collection('subscriptions').countDocuments({ websiteId: WEBSITE, status: 'claimed' })).toBe(0);
	});

	it('does not confirm an unconfirmed subscription past its confirmation window', async () => {
		const t = await harness({ config: { capture: { double_opt_in: true, confirm_ttl_hours: 1 } } });
		const created = await t.subscribe({}, { key: t.pk });
		expect(created.json.status).toBe('unconfirmed');
		const { repos } = await t.site();
		t.clock.advance(3_600_000 + 1);
		expect(await repos.subscriptions.confirm(created.json.id, new Date(t.clock.now() + DAY))).toBeNull();
	});
});
