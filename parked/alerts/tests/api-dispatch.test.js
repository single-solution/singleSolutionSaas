/** The outbox: timing, caps, batching, retries, claim-before-send and recovery on MongoDB. */
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, WEBSITE } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>> | null} */
let h = null;
afterEach(async () => {
	await h?.close();
	h = null;
});
/** @param {Parameters<typeof createHarness>[0]} [options] */
const harness = async (options) => (h = await createHarness(options));
/** @param {Awaited<ReturnType<typeof createHarness>>} t */
const messages = (t) => t.collection('messages').find({ websiteId: WEBSITE }).sort({ _id: 1 }).toArray();
/** @param {Awaited<ReturnType<typeof createHarness>>} t @param {string} itemId @param {number} [at] */
const restock = (t, itemId, at = t.clock.now()) =>
	t.deliver('inventory.changed@1', { itemId, quantity: 3, previousQuantity: 0 }, { occurredAt: at });
/** @param {Awaited<ReturnType<typeof createHarness>>} t */
const run = (t) => t.call('POST', '/v1/messages:dispatch', { idempotencyKey: null });

describe('timing', () => {
	it('holds alerts during quiet hours (website time zone) and sends when they end', async () => {
		const t = await harness({ config: { dispatch: { quiet_hours_enabled: true, time_zone: 'Asia/Karachi' } } });
		t.clock.set(Date.parse('2026-10-01T18:00:00Z')); // 23:00 in Karachi
		await t.subscribe({}, { key: t.pk });
		await restock(t, 'itm_1');
		expect(t.provider.sent).toHaveLength(0);
		const [queued] = await messages(t);
		expect(queued).toMatchObject({ status: 'queued', notBefore: Date.parse('2026-10-02T03:00:00Z') });
		t.clock.set(Date.parse('2026-10-02T03:01:00Z'));
		expect((await run(t)).json).toMatchObject({ sent: 1 });
		expect(t.provider.sent).toHaveLength(1);
		// a message due when quiet hours start is put back without spending an attempt
		t.clock.set(Date.parse('2026-10-02T17:00:00Z')); // 22:00 in Karachi
		await t.entitle({
			config: { dispatch: { quiet_hours_enabled: false, inline_dispatch: false, time_zone: 'Asia/Karachi' } },
		});
		await t.subscribe({ itemId: 'itm_2' }, { key: t.pk });
		await restock(t, 'itm_2');
		await t.entitle({ config: { dispatch: { quiet_hours_enabled: true, time_zone: 'Asia/Karachi' } } });
		expect(await t.alerts.dispatcher.run(await t.site())).toMatchObject({ deferred: 1, sent: 0 });
		const held = (await messages(t)).find((m) => m.status === 'queued');
		expect(held).toMatchObject({ attempts: 0, notBefore: Date.parse('2026-10-03T03:00:00Z') });
	});

	it('batches alerts of one contact into a digest', async () => {
		const t = await harness({ config: { dispatch: { batch_window_minutes: 10 } } });
		await t.subscribe({ itemId: 'a', item: { name: 'Alpha' } }, { key: t.pk });
		await t.subscribe({ itemId: 'b', item: { name: 'Beta' } }, { key: t.pk });
		await t.subscribe({ itemId: 'a', email: 'other@example.com' }, { key: t.pk });
		await restock(t, 'a');
		await restock(t, 'b');
		expect(t.provider.sent).toHaveLength(0);
		const open = await messages(t);
		expect(open.map((m) => m.items.length).sort()).toEqual([1, 2]);
		expect(open.every((m) => m.open === true)).toBe(true);
		t.clock.advance(11 * 60_000);
		expect((await run(t)).json.sent).toBe(2);
		const digest = t.provider.sent.find((m) => m.to.email === 'jane@example.com');
		expect(digest.subject).toBe('2 updates from shop.example.com');
		expect(digest.text).toContain('• Alpha — back in stock');
		expect(digest.text).toContain('• Beta — back in stock');
		expect(digest.metadata.subscriptionIds).toHaveLength(2);
		const statuses = await t.collection('subscriptions').distinct('status', { websiteId: WEBSITE });
		expect(statuses).toEqual(['notified']);
		// a new alert after the digest closed opens a new batch
		await t.subscribe({ itemId: 'c' }, { key: t.pk });
		await restock(t, 'c');
		expect((await messages(t)).filter((m) => m.open === true)).toHaveLength(1);
	});
});

describe('frequency caps', () => {
	it('defers to the next local day when a contact reached its daily cap', async () => {
		const t = await harness({ config: { dispatch: { max_per_contact_per_day: 1 } } });
		await t.subscribe({ itemId: 'a' }, { key: t.pk });
		await t.subscribe({ itemId: 'b' }, { key: t.pk });
		await restock(t, 'a');
		await restock(t, 'b');
		expect(t.provider.sent).toHaveLength(1);
		const deferred = (await messages(t)).find((m) => m.status === 'queued');
		expect(deferred).toMatchObject({ notBefore: Date.parse('2026-10-02T00:00:00Z'), error: 'frequency_cap', attempts: 0 });
		t.clock.set(Date.parse('2026-10-02T00:00:01Z'));
		await run(t);
		expect(t.provider.sent).toHaveLength(2);
	});

	it('drops capped alerts when configured (the subscription waits for the next change)', async () => {
		const t = await harness({
			config: { dispatch: { max_per_contact_per_day: 0, max_per_contact_per_week: 1, cap_action: 'drop' } },
		});
		await t.subscribe({ itemId: 'a' }, { key: t.pk });
		const b = await t.subscribe({ itemId: 'b' }, { key: t.pk });
		await restock(t, 'a');
		await restock(t, 'b');
		expect(t.provider.sent).toHaveLength(1);
		expect((await messages(t)).map((m) => m.status)).toEqual(['sent', 'capped']);
		expect((await t.collection('subscriptions').findOne({ websiteId: WEBSITE, id: b.json.id }))?.status).toBe('pending');
	});
});

describe('delivery failures', () => {
	it('retries transient failures with backoff, then sends', async () => {
		const t = await harness();
		await t.subscribe({}, { key: t.pk });
		t.provider.fail(1, 503);
		await restock(t, 'itm_1');
		const [failed] = await messages(t);
		expect(failed).toMatchObject({
			status: 'queued',
			error: 'provider_refused',
			lastStatus: 503,
			attempts: 1,
			notBefore: t.clock.now() + 120_000,
		});
		t.provider.throwNext(1);
		t.clock.advance(121_000);
		await run(t);
		expect((await messages(t))[0]).toMatchObject({ status: 'queued', attempts: 2, error: 'upstream_error' });
		t.clock.advance(5 * 60_000);
		await run(t);
		expect((await messages(t))[0]).toMatchObject({ status: 'sent', attempts: 3 });
		expect(t.provider.sent).toHaveLength(1);
	});

	it('fails permanently on refusals and re-arms (or ends) the subscriptions', async () => {
		const t = await harness();
		const sub = await t.subscribe({}, { key: t.pk });
		t.provider.fail(1, 400);
		await restock(t, 'itm_1');
		expect((await messages(t))[0]).toMatchObject({ status: 'failed', lastStatus: 400 });
		expect((await t.collection('subscriptions').findOne({ websiteId: WEBSITE, id: sub.json.id }))?.status).toBe('pending');
		await t.entitle({ config: { dispatch: { release_on_failure: false, max_attempts: 1 } } });
		t.provider.fail(1, 503);
		await t.deliver('inventory.changed@1', { itemId: 'itm_1', quantity: 0 }, { occurredAt: t.clock.now() + 1 });
		await t.deliver('inventory.changed@1', { itemId: 'itm_1', quantity: 2 }, { occurredAt: t.clock.now() + 2 });
		expect((await t.collection('subscriptions').findOne({ websiteId: WEBSITE, id: sub.json.id }))?.status).toBe('failed');
	});

	it('retries when the messaging connector is not available', async () => {
		const t = await harness({ messaging: false });
		await t.subscribe({}, { key: t.pk });
		await restock(t, 'itm_1');
		expect((await messages(t))[0]).toMatchObject({ status: 'queued', error: expect.any(String) });
	});

	it('fails messages without a template and cancels suppressed or orphaned ones', async () => {
		const t = await harness({ config: { capture: { default_lang: 'en' } } });
		const sub = await t.subscribe({}, { key: t.pk });
		const repos = (await t.site()).repos;
		await t.entitle({ config: { dispatch: { inline_dispatch: false } } });
		await restock(t, 'itm_1');
		await t.collection('messages').updateOne({ websiteId: WEBSITE }, { $set: { 'items.0.type': 'mystery' } });
		await t.collection('subscriptions').updateOne({ websiteId: WEBSITE, id: sub.json.id }, { $set: { type: 'mystery' } });
		await run(t);
		expect((await messages(t))[0]).toMatchObject({ status: 'failed', error: 'template_missing' });
		const second = await t.subscribe({ itemId: 'itm_2' }, { key: t.pk });
		await restock(t, 'itm_2');
		await repos.suppressions.add((await repos.subscriptions.get(second.json.id)).contactKey, 'test');
		await run(t);
		expect((await messages(t))[1]).toMatchObject({ status: 'cancelled', error: 'suppressed' });
		const third = await t.subscribe({ itemId: 'itm_3', email: 'z@example.com' }, { key: t.pk });
		await restock(t, 'itm_3');
		await t
			.collection('subscriptions')
			.updateOne({ websiteId: WEBSITE, id: third.json.id }, { $set: { status: 'unsubscribed' } });
		await run(t);
		expect((await messages(t))[2]).toMatchObject({ status: 'cancelled', error: 'no_live_alerts' });
	});
});

describe('claim before send', () => {
	it('sends a message once when two instances run the outbox concurrently', async () => {
		const t = await harness({ config: { dispatch: { inline_dispatch: false } } });
		await t.subscribe({}, { key: t.pk });
		await restock(t, 'itm_1');
		const site = await t.site();
		const release = t.provider.hold();
		const a = t.alerts.dispatcher.run(site, { owner: 'instance-a' });
		const b = t.alerts.dispatcher.run(site, { owner: 'instance-b' });
		await new Promise((resolve) => setTimeout(resolve, 50));
		release();
		const [ra, rb] = /** @type {any[]} */ (await Promise.all([a, b]));
		expect(ra.sent + rb.sent).toBe(1);
		expect(t.provider.requests).toHaveLength(1);
	});

	it('takes over a message whose lease expired (crashed instance), keeping the idempotency key', async () => {
		const t = await harness({ config: { dispatch: { inline_dispatch: false, lease_seconds: 30 } } });
		await t.subscribe({}, { key: t.pk });
		await restock(t, 'itm_1');
		const site = await t.site();
		const claimed = await site.repos.messages.claimDue({ owner: 'crashed', leaseMs: 30_000 });
		expect(claimed?.status).toBe('sending');
		expect(/** @type {any} */ (await t.alerts.dispatcher.run(site)).sent).toBe(0);
		t.clock.advance(31_000);
		expect(/** @type {any} */ (await t.alerts.dispatcher.run(site)).sent).toBe(1);
		expect(t.provider.requests[0]?.headers['idempotency-key']).toBe(claimed?.id);
		expect(await site.repos.messages.settle(claimed?.id ?? '', 'crashed', { status: 'sent' })).toBe(false);
	});

	it('recovers claimed subscriptions after a crash between claim and queue, or between send and close', async () => {
		const t = await harness({ config: { dispatch: { inline_dispatch: false } } });
		const lost = await t.subscribe({ itemId: 'a' }, { key: t.pk });
		const sentButOpen = await t.subscribe({ itemId: 'b' }, { key: t.pk });
		const site = await t.site();
		// crash after the claim, before the queue
		expect(await site.repos.subscriptions.claim(lost.json.id, 0, 'trg_crash')).not.toBeNull();
		// crash after the send, before closing the subscription
		await restock(t, 'b');
		await t.alerts.dispatcher.run(site);
		await t
			.collection('subscriptions')
			.updateOne({ websiteId: WEBSITE, id: sentButOpen.json.id }, { $set: { status: 'claimed' } });
		t.clock.advance(11 * 60_000);
		const recovered = await t.alerts.dispatcher.recover(site);
		expect(recovered).toEqual({ requeued: 1, closed: 1 });
		await t.alerts.dispatcher.run(site);
		expect(t.provider.sent.map((m) => m.metadata.subscriptionIds[0]).sort()).toEqual(
			[lost.json.id, sentButOpen.json.id].sort(),
		);
		const statuses = await t.collection('subscriptions').find({ websiteId: WEBSITE }).toArray();
		expect(statuses.map((s) => s.status)).toEqual(['notified', 'notified']);
	});
});

describe('messages', () => {
	it('renders overrides, sms bodies, the store name and item links; lists messages', async () => {
		const t = await harness({
			config: {
				capture: { channels: ['email', 'sms'] },
				dispatch: {
					site_name: 'Bazaar',
					item_url_template: 'https://shop.example.com/items/{itemId}?v={variantId}',
					templates: [
						{
							type: 'back_in_stock',
							channel: 'email',
							lang: '*',
							subject: 'Back: {item}',
							body: '{item} at {site}: {url} — {unsubscribe_url}',
						},
					],
				},
			},
		});
		await t.subscribe({ itemId: 'itm_1', variantId: 'red' }, { key: t.pk });
		await t.subscribe(
			{ itemId: 'itm_1', variantId: 'red', channel: 'sms', phone: '+447700900123', email: undefined },
			{ key: t.pk },
		);
		await t.deliver('inventory.changed@1', { itemId: 'itm_1', variantId: 'red', quantity: 1, previousQuantity: 0 });
		const email = t.provider.sent.find((m) => m.channel === 'email');
		expect(email.subject).toBe('Back: this item');
		expect(email.text).toMatch(
			/^this item at Bazaar: https:\/\/shop\.example\.com\/items\/itm_1\?v=red — https:\/\/alerts\.example\.com\/u\//,
		);
		const sms = t.provider.sent.find((m) => m.channel === 'sms');
		expect(sms.subject).toBeUndefined();
		expect(sms.text).toMatch(/^Bazaar: this item is back in stock\. https:\/\/shop\.example\.com\/items\/itm_1\?v=red Stop: /);
		expect(sms.headers).toBeUndefined();
		const list = await t.call('GET', '/v1/messages?status=sent');
		expect(list.json.items).toHaveLength(2);
		expect(list.json.items[0].to).toMatch(/•/);
		expect((await t.call('GET', `/v1/messages/${list.json.items[0].id}`)).json.id).toBe(list.json.items[0].id);
		expect((await t.call('GET', '/v1/messages/alm_missing')).status).toBe(404);
		expect((await t.call('GET', '/v1/messages', { key: t.pk })).status).toBe(403);
	});

	it('uses the merchant’s own unsubscribe page when configured', async () => {
		const t = await harness({ config: { unsubscribe: { page_url: 'https://shop.example.com/alerts/stop?t={token}' } } });
		await t.subscribe({}, { key: t.pk });
		await restock(t, 'itm_1');
		expect(t.provider.sent[0].text).toMatch(/https:\/\/shop\.example\.com\/alerts\/stop\?t=us1\./);
	});
});
