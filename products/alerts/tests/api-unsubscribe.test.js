/** Unsubscribe: signed links, the hosted confirm page (safe from link previews), one-click, Mode C. */
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, WEBSITE, WEBSITE_2 } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>> | null} */
let h = null;
afterEach(async () => {
	await h?.close();
	h = null;
});
/** @param {Parameters<typeof createHarness>[0]} [options] */
const harness = async (options) => (h = await createHarness(options));

/**
 * Subscribe twice, fire the first one and return the unsubscribe link of its message.
 * @param {Awaited<ReturnType<typeof createHarness>>} t
 */
const alerted = async (t) => {
	const first = await t.subscribe({ item: { name: 'Phone' } }, { key: t.pk });
	const second = await t.subscribe({ itemId: 'itm_2' }, { key: t.pk });
	await t.deliver('inventory.changed@1', { itemId: 'itm_1', quantity: 2, previousQuantity: 0 });
	const url = /Stop these alerts: https:\/\/alerts\.example\.com(\/u\/\S+)/.exec(t.provider.sent[0]?.text ?? '')?.[1] ?? '';
	return { first: first.json, second: second.json, path: url, token: decodeURIComponent(url.slice(3)) };
};

describe('hosted unsubscribe page', () => {
	it('shows a confirm button on GET (no change) and unsubscribes the contact on POST', async () => {
		const t = await harness();
		const { second, path } = await alerted(t);
		for (let index = 0; index < 3; index += 1) {
			const page = await t.call('GET', path, { key: null });
			expect(page.status).toBe(200);
			expect(page.headers.get('content-type')).toMatch(/text\/html/);
			expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
			expect(page.headers.get('cache-control')).toBe('no-store');
			expect(page.text).toContain('This stops every alert for j•••@example.com.');
			expect(page.text).toContain(`<form method="post" action="${path}">`);
		}
		expect((await t.collection('subscriptions').findOne({ websiteId: WEBSITE, id: second.id }))?.status).toBe('pending');
		const done = await t.call('POST', path, {
			key: null,
			raw: 'List-Unsubscribe=One-Click',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
		});
		expect(done.status).toBe(200);
		expect(done.text).toContain('Alerts stopped');
		expect((await t.collection('subscriptions').findOne({ websiteId: WEBSITE, id: second.id }))?.status).toBe('unsubscribed');
		expect(await t.collection('suppressions').countDocuments({ websiteId: WEBSITE })).toBe(1);
		expect(await t.collection('audit').countDocuments({ websiteId: WEBSITE, action: 'alerts.unsubscribed' })).toBe(1);
		// idempotent
		expect((await t.call('POST', path, { key: null, raw: '' })).status).toBe(200);
	});

	it('stops only the alert of the link with scope "subscription", and cancels nothing else', async () => {
		const t = await harness({ config: { unsubscribe: { scope: 'subscription' } } });
		const { first, second, path } = await alerted(t);
		const page = await t.call('GET', path, { key: null });
		expect(page.text).toContain('This stops the alert about Phone for j•••@example.com.');
		await t.call('POST', path, { key: null, raw: '' });
		expect((await t.collection('subscriptions').findOne({ websiteId: WEBSITE, id: second.id }))?.status).toBe('pending');
		expect((await t.collection('subscriptions').findOne({ websiteId: WEBSITE, id: first.id }))?.status).toBe('notified');
		expect(await t.collection('suppressions').countDocuments({ websiteId: WEBSITE })).toBe(0);
	});

	it('refuses invalid, tampered and expired links, and answers 503 when the website is unreachable', async () => {
		const t = await harness({ config: { unsubscribe: { token_ttl_days: 1 } } });
		const { path, token } = await alerted(t);
		expect((await t.call('GET', '/u/garbage', { key: null })).status).toBe(404);
		expect((await t.call('GET', `/u/${token.slice(0, -2)}xx`, { key: null })).status).toBe(404);
		expect((await t.call('POST', '/u/garbage', { key: null, raw: '' })).status).toBe(404);
		// another subscription's contact in a forged-but-signed token is refused
		const forged = t.app.tokens.issue('unsubscribe', {
			websiteId: WEBSITE,
			subscriptionId: 'als_unknown',
			contactKey: 'ck_x',
			ttlSeconds: 3600,
		});
		expect((await t.call('GET', `/u/${forged}`, { key: null })).status).toBe(404);
		// a website without a subscription (no entitlement document): the page says the service is unavailable
		const orphan = t.app.tokens.issue('unsubscribe', {
			websiteId: WEBSITE_2,
			subscriptionId: 'als_x',
			contactKey: 'ck_x',
			ttlSeconds: 3600,
		});
		expect((await t.call('GET', `/u/${orphan}`, { key: null })).status).toBe(503);
		expect((await t.call('POST', `/u/${orphan}`, { key: null, raw: '' })).status).toBe(503);
		expect(
			(
				await t.call(
					'GET',
					`/c/${t.app.tokens.issue('confirm', { websiteId: WEBSITE_2, subscriptionId: 'als_x', contactKey: 'ck_x', ttlSeconds: 3600 })}`,
					{ key: null },
				)
			).status,
		).toBe(503);
		await t.entitle();
		t.clock.advance(2 * 86_400_000);
		expect((await t.call('GET', path, { key: null })).status).toBe(404);
	});
});

describe('Mode C unsubscribe', () => {
	it('previews and applies a token from the merchant’s own page', async () => {
		const t = await harness();
		const { token, second } = await alerted(t);
		const preview = await t.call('GET', `/v1/unsubscribe/${encodeURIComponent(token)}`, { key: t.pk });
		expect(preview.json).toMatchObject({
			scope: 'contact',
			contact: 'j•••@example.com',
			subscription: { type: 'back_in_stock' },
		});
		expect((await t.collection('subscriptions').findOne({ websiteId: WEBSITE, id: second.id }))?.status).toBe('pending');
		const done = await t.call('POST', '/v1/unsubscribe', { key: t.pk, body: { token } });
		expect(done.json).toMatchObject({ unsubscribed: true, scope: 'contact', ended: 1 });
		expect((await t.call('POST', '/v1/unsubscribe', { key: t.pk, body: { token: 'x' } })).json.type).toMatch(/token_invalid$/);
		expect((await t.call('GET', '/v1/unsubscribe/x', { key: t.pk })).status).toBe(404);
		// a token of another website is refused
		const other = t.app.tokens.issue('unsubscribe', {
			websiteId: WEBSITE_2,
			subscriptionId: second.id,
			contactKey: 'ck',
			ttlSeconds: 3600,
		});
		expect((await t.call('POST', '/v1/unsubscribe', { key: t.pk, body: { token: other } })).status).toBe(404);
		// a valid token whose contact does not match the subscription
		const mismatch = t.app.tokens.issue('unsubscribe', {
			websiteId: WEBSITE,
			subscriptionId: second.id,
			contactKey: 'ck_other',
			ttlSeconds: 3600,
		});
		expect((await t.call('POST', '/v1/unsubscribe', { key: t.pk, body: { token: mismatch } })).status).toBe(404);
		expect((await t.call('POST', `/u/${mismatch}`, { key: null, raw: '' })).status).toBe(404);
	});

	it('cancels queued messages of an unsubscribed contact', async () => {
		const t = await harness({ config: { dispatch: { inline_dispatch: false } } });
		const { token } = await (async () => {
			const sub = await t.subscribe({}, { key: t.pk });
			await t.deliver('inventory.changed@1', { itemId: 'itm_1', quantity: 2, previousQuantity: 0 });
			const site = await t.site();
			const stored = await site.repos.subscriptions.get(sub.json.id);
			return {
				token: t.app.tokens.issue('unsubscribe', {
					websiteId: WEBSITE,
					subscriptionId: sub.json.id,
					contactKey: stored.contactKey,
					ttlSeconds: 3600,
				}),
			};
		})();
		const done = await t.call('POST', '/v1/unsubscribe', { key: t.pk, body: { token } });
		expect(done.json).toMatchObject({ cancelledMessages: 1 });
		expect((await t.collection('messages').findOne({ websiteId: WEBSITE }))?.status).toBe('cancelled');
	});
});
