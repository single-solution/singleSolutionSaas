/** No timers: the outbox runs on triggers and on demand (API, dashboard button); expiry is judged when read. */
import { afterEach, describe, expect, it } from 'vitest';
import { INDEXES } from '../adapters/db.js';
import { resolveDashboard } from '../api/dashboard.js';
import { createHarness, MERCHANT, WEBSITE } from './harness.js';

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

/**
 * A dashboard session id (launch exchanged as `/sso` does).
 * @param {Awaited<ReturnType<typeof createHarness>>} t
 * @param {Record<string, any>} claims
 */
const sessionFor = async (t, claims) => {
	const { token } = await t.portal.issueLaunch(/** @type {any} */ ({ user: { id: String(claims.subject) }, ...claims }));
	const exchanged = await t.alerts.product.launch.exchange(token);
	if (!exchanged.ok) throw new Error(exchanged.code);
	return exchanged.session.id;
};
/** @param {Awaited<ReturnType<typeof createHarness>>} t */
const merchantSession = (t) =>
	sessionFor(t, { kind: 'merchant', subject: 'usr_1', scope: { merchantId: MERCHANT, websiteId: WEBSITE } });

describe('dispatch on triggers', () => {
	it('sends a deferred message with the website’s next trigger once it is due', async () => {
		const t = await harness({ config: { dispatch: { max_per_contact_per_day: 1 } } });
		await t.subscribe({ itemId: 'a' }, { key: t.pk });
		await t.subscribe({ itemId: 'b' }, { key: t.pk });
		await restock(t, 'a');
		await restock(t, 'b');
		expect(t.provider.sent).toHaveLength(1);
		// a trigger before the message is due sends nothing more
		await restock(t, 'z');
		expect(t.provider.sent).toHaveLength(1);
		t.clock.set(Date.parse('2026-10-02T00:00:01Z'));
		// any trigger of the website (here an item nobody waits for) sends what became due
		await restock(t, 'y');
		expect(t.provider.sent).toHaveLength(2);
	});

	it('continues a run that hit the fan-out limit in its own outbox run, then on the next triggers', async () => {
		const t = await harness({ config: { triggers: { fanout_limit: 1 } } });
		for (const email of ['one@example.com', 'two@example.com', 'three@example.com'])
			await t.subscribe({ email }, { key: t.pk });
		await restock(t, 'itm_1');
		expect(t.provider.sent).toHaveLength(2);
		expect(await t.collection('triggers').countDocuments({ websiteId: WEBSITE, open: true })).toBe(1);
		await restock(t, 'itm_other');
		expect(t.provider.sent).toHaveLength(3);
		await restock(t, 'itm_another');
		expect(await t.collection('triggers').countDocuments({ websiteId: WEBSITE, open: true })).toBe(0);
		expect(t.provider.sent).toHaveLength(3);
	});

	it('keeps messages queued when inline dispatch is off, until the API or the dashboard runs the outbox', async () => {
		const t = await harness({ config: { dispatch: { inline_dispatch: false } } });
		await t.subscribe({}, { key: t.pk });
		await restock(t, 'itm_1');
		await restock(t, 'itm_2');
		expect(t.provider.sent).toHaveLength(0);
		const merchant = await merchantSession(t);
		const run = await t.call('POST', '/v1/dashboard/messages:dispatch', { key: merchant, body: {} });
		expect(run.status).toBe(200);
		expect(run.json).toMatchObject({ sent: 1, recovered: { requeued: 0 }, resumed: { resumed: 0 } });
		expect(t.provider.sent).toHaveLength(1);
		expect((await t.collection('subscriptions').findOne({ websiteId: WEBSITE }))?.status).toBe('notified');
	});

	it('swallows a failing inline run (the messages stay queued)', async () => {
		const t = await harness();
		await t.subscribe({}, { key: t.pk });
		const site = await t.site();
		const messages = { ...site.repos.messages, claimDue: async () => Promise.reject(new Error('down')) };
		const failing = /** @type {any} */ ({ ...site, repos: { ...site.repos, messages } });
		expect(await t.alerts.engine.sendAfterTrigger(failing, 1)).toBeNull();
	});
});

describe('dashboard "Send due now"', () => {
	it('is offered to merchants only and checks role, website and element', async () => {
		const t = await harness();
		const merchant = await merchantSession(t);
		const ready = await resolveDashboard({ alerts: t.alerts, sessionId: merchant });
		expect(ready.state === 'ready' && ready.data.canWrite).toBe(true);
		const staff = await sessionFor(t, {
			kind: 'admin',
			subject: 'stf_1',
			scope: { merchantId: MERCHANT, websiteId: WEBSITE },
		});
		const admin = await resolveDashboard({ alerts: t.alerts, sessionId: staff });
		expect(admin.state === 'ready' && admin.data.canWrite).toBe(true);
		const noWebsite = await sessionFor(t, { kind: 'merchant', subject: 'usr_2', scope: { merchantId: MERCHANT } });
		expect((await t.call('POST', '/v1/dashboard/messages:dispatch', { key: noWebsite, body: {} })).status).toBe(400);
		expect((await t.call('POST', '/v1/dashboard/messages:dispatch', { key: t.sk, body: {} })).status).toBe(401);
		await t.entitle({ elements: { dispatch: false } });
		const off = await resolveDashboard({ alerts: t.alerts, sessionId: merchant });
		expect(off.state === 'ready' && off.data.canWrite).toBe(false);
		expect((await t.call('POST', '/v1/dashboard/messages:dispatch', { key: merchant, body: {} })).status).toBe(403);
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

	it('reads an expired subscription as expired, leaves it out of counts and waitlists, and ends it when touched', async () => {
		const t = await harness({ config: { types: { pending_max_days: 1 } } });
		const first = await t.subscribe({}, { key: t.pk });
		expect(first.status).toBe(201);
		t.clock.advance(DAY + 1);
		expect((await t.call('GET', `/v1/subscriptions/${first.json.id}`)).json.status).toBe('expired');
		expect((await t.call('GET', '/v1/subscriptions')).json.items[0].status).toBe('expired');
		expect((await t.call('GET', '/v1/waitlist?type=back_in_stock&itemId=itm_1')).json.items).toHaveLength(0);
		const position = await t.call('GET', `/v1/waitlist/position?subscriptionId=${first.json.id}`);
		expect(position.json).toMatchObject({ status: 'expired', position: null });
		const { repos } = await t.site();
		expect(await repos.subscriptions.countActive()).toBe(0);
		// signing up again replaces it: the expired one is ended (no longer active) when touched
		const again = await t.subscribe({}, { key: t.pk });
		expect(again.status).toBe(201);
		expect(again.json.id).not.toBe(first.json.id);
		const old = await t.collection('subscriptions').findOne({ websiteId: WEBSITE, id: first.json.id });
		expect(old).toMatchObject({ status: 'expired' });
		expect(old?.active).toBeUndefined();
	});

	it('does not confirm an unconfirmed subscription past its confirmation window', async () => {
		const t = await harness({ config: { capture: { double_opt_in: true, confirm_ttl_hours: 1 } } });
		const created = await t.subscribe({}, { key: t.pk });
		expect(created.json.status).toBe('unconfirmed');
		const { repos } = await t.site();
		t.clock.advance(3_600_000 + 1);
		expect(await repos.subscriptions.confirm(created.json.id, new Date(t.clock.now() + DAY))).toBeNull();
	});

	it('lets MongoDB delete what expired (TTL indexes)', () => {
		const ttl = INDEXES.filter((/** @type {any} */ index) => index.expireAfterSeconds === 0);
		expect(ttl.map((/** @type {any} */ index) => index.collection).sort()).toEqual([
			'counters',
			'messages',
			'subscriptions',
			'triggers',
		]);
		expect(ttl.every((/** @type {any} */ index) => Object.keys(index.keys).join() === 'expiresAt')).toBe(true);
	});
});
