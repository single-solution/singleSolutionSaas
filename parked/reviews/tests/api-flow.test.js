/**
 * Request flow (messaging connector), photos (storage connector), Q&A, CSV import, analytics, order lifecycle events,
 * sending on order completion (no timers) and the dashboard API.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS, STALE_BACKSTOP_MS } from '../adapters/db.js';
import { resolveDashboard } from '../api/dashboard.js';
import { DAY, HOUR, MERCHANT, T0, WEBSITE, WEBSITE_2, createHarness } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
beforeAll(async () => {
	h = await createHarness({
		config: {
			// most tests drive the flow with POST /v1/request-flow:run; 'sends on completion' turns it on
			collection: { send_on_completion: false },
			request_flow: {
				review_url: 'https://shop.example.com/review?t={token}&o={orderId}',
				reminders: [3, 10],
				quiet_hours: { start: '22:00', end: '07:00' },
				channels: ['whatsapp', 'email'],
			},
		},
	});
});
afterAll(async () => h?.close());

const text = 'Arrived quickly and works perfectly. Would buy again.';

/** A merchant dashboard session of the main website (launch exchanged at /sso). */
const dashboardSession = async () => {
	const { token } = await h.portal.issueLaunch({
		kind: 'merchant',
		subject: 'usr_merchant',
		user: { id: 'usr_merchant' },
		scope: { merchantId: MERCHANT, websiteId: WEBSITE },
	});
	const exchanged = await h.reviews.product.launch.exchange(token);
	if (!exchanged.ok) throw new Error(exchanged.code);
	return exchanged.session.id;
};

describe('request flow', () => {
	it('sends the request when run, then reminders, through the messaging connector, and stops once reviewed', async () => {
		const { orderId } = await h.completeOrder({ customerId: 'cus_flow', items: ['itm_f1', 'itm_f2'], phone: '+4915112345678' });
		// due at completion (no delay); 10:00 UTC is outside quiet hours
		const run = await h.call('POST', '/v1/request-flow:run', { idempotencyKey: null });
		expect(run.json).toMatchObject({ due: 1, sent: 1, failed: 0 });
		const message = h.providers.messages.at(-1);
		expect(message?.url).toBe('https://messaging.example.com/v1/messages');
		expect(message?.body).toMatchObject({
			channel: 'whatsapp',
			to: '+4915112345678',
			template: 'review_request',
			locale: 'en',
		});
		expect(message?.body.text).toContain('https://shop.example.com/review?t=rl1.');
		expect(message?.body.data).toMatchObject({ kind: 'request', orderId });
		const token = decodeURIComponent(/t=([^&]+)/.exec(message?.body.data.url)?.[1] ?? '');
		const status = await h.call('GET', '/v1/request-flow');
		expect(status.json).toMatchObject({ enabled: true, reviewUrlConfigured: true, requests: { open: expect.any(Number) } });

		// quiet hours: nothing is sent
		h.clock.set(T0 + 10 * DAY + 13 * HOUR); // 23:00 UTC
		const quiet = await h.call('POST', '/v1/request-flow:run', { idempotencyKey: null });
		expect(quiet.json).toMatchObject({ quiet: true, reminded: 0 });
		h.clock.set(T0 + 10 * DAY + 2 * HOUR); // 12:00 UTC, 3 days after the first send
		const reminder = await h.call('POST', '/v1/request-flow:run', { idempotencyKey: null });
		expect(reminder.json).toMatchObject({ reminded: 1 });
		expect(h.providers.messages.at(-1)?.body).toMatchObject({ template: 'review_reminder', data: { kind: 'reminder' } });

		// the customer reviews both items through the link: the request completes and no more reminders go out
		for (const itemId of ['itm_f1', 'itm_f2'])
			expect((await h.call('POST', '/v1/reviews', { as: '', body: { token, itemId, rating: 5, body: text } })).status).toBe(
				201,
			);
		h.clock.set(T0 + 20 * DAY);
		const after = await h.call('POST', '/v1/request-flow:run', { idempotencyKey: null });
		expect(after.json.reminded).toBe(0);
		const request = await h.collection('requests').findOne({ websiteId: WEBSITE, orderId });
		expect(request).toMatchObject({ status: 'completed', delivery: { state: 'done', sends: 2, channel: 'whatsapp' } });
		h.clock.set(T0);
	});

	it('retries failed sends with back-off, gives up on permanent errors, and skips customers without contact', async () => {
		const { orderId } = await h.completeOrder({ customerId: 'cus_retry', items: ['itm_r1'] });
		const { orderId: silent } = await h.completeOrder({ customerId: 'cus_silent', items: ['itm_r2'], email: null });
		h.clock.advance(7 * DAY + HOUR);
		h.providers.failMessaging({ status: 503 });
		const failed = await h.call('POST', '/v1/request-flow:run', { idempotencyKey: null });
		expect(failed.json.failed).toBe(1);
		expect(failed.json.skipped).toBe(1);
		let request = await h.collection('requests').findOne({ websiteId: WEBSITE, orderId });
		expect(request?.delivery).toMatchObject({ attempts: 1, state: 'scheduled' });
		expect(request?.delivery.lastError).toMatch(/503/);
		expect((await h.collection('requests').findOne({ websiteId: WEBSITE, orderId: silent }))?.delivery).toMatchObject({
			state: 'off',
			lastError: 'no_contact',
		});
		h.providers.failMessaging({ status: 400 });
		h.clock.advance(2 * HOUR);
		await h.call('POST', '/v1/request-flow:run', { idempotencyKey: null });
		request = await h.collection('requests').findOne({ websiteId: WEBSITE, orderId });
		expect(request?.delivery).toMatchObject({ state: 'failed', nextAt: null });
		h.providers.failMessaging(null);
		h.clock.set(T0);
	});

	it('expires requests and waits for a review URL', async () => {
		await h.entitle({ config: { collection: { send_on_completion: false }, request_flow: { review_url: '' } } });
		const { orderId } = await h.completeOrder({ customerId: 'cus_nourl', items: ['itm_n1'] });
		h.clock.advance(7 * DAY + HOUR);
		const run = await h.call('POST', '/v1/request-flow:run', { idempotencyKey: null });
		expect(run.json.skipped).toBeGreaterThanOrEqual(1);
		expect((await h.collection('requests').findOne({ websiteId: WEBSITE, orderId }))?.delivery.lastError).toBe(
			'review_url_missing',
		);
		await h.entitle({
			config: {
				collection: { send_on_completion: false },
				request_flow: { review_url: 'https://shop.example.com/r/{token}' },
			},
		});
		h.clock.advance(400 * DAY);
		const status = await h.call('GET', '/v1/request-flow');
		expect(status.json.requests.expired).toBeGreaterThanOrEqual(1);
		expect(status.json.nextDueAt).toBeNull();
		const expired = await h.call('POST', '/v1/request-flow:run', { idempotencyKey: null });
		expect(expired.json.expired).toBeGreaterThanOrEqual(1);
		expect((await h.collection('requests').findOne({ websiteId: WEBSITE, orderId }))?.status).toBe('expired');
		h.clock.set(T0);
		await h.entitle();
		// without the request flow element the routes are gated
		await h.entitle({ elements: { request_flow: false } });
		expect((await h.call('GET', '/v1/request-flow')).status).toBe(403);
		expect((await h.call('POST', '/v1/request-flow:run', { idempotencyKey: null })).status).toBe(403);
		await h.entitle();
	});

	it('sends on completion, catches up held requests with the next completion, and reads expiry when read', async () => {
		await h.entitle({ config: { collection: { send_on_completion: true } } });
		const before = h.providers.messages.length;
		const { orderId } = await h.completeOrder({ customerId: 'cus_bg', items: ['itm_bg1'] }); // 10:00 UTC
		expect(h.providers.messages.length).toBe(before + 1);
		const stored = await h.collection('requests').findOne({ websiteId: WEBSITE, orderId });
		expect(stored?.delivery).toMatchObject({ sends: 1, state: 'sent' });
		expect(stored?.dueAt).toBe(stored?.completedAt);
		// an order completed during quiet hours waits; the next completion outside them sends both
		h.clock.set(T0 + 13 * HOUR); // 23:00 UTC
		const { orderId: held } = await h.completeOrder({ customerId: 'cus_held', items: ['itm_bg2'] });
		expect(h.providers.messages.length).toBe(before + 1);
		h.clock.set(T0 + DAY);
		const { orderId: next } = await h.completeOrder({ customerId: 'cus_next', items: ['itm_bg3'] });
		expect(h.providers.messages.length).toBe(before + 3);
		for (const id of [held, next])
			expect((await h.collection('requests').findOne({ websiteId: WEBSITE, orderId: id }))?.delivery.sends).toBe(1);
		// an order completed "in the future" counts as completed now; a failing flow never fails the completion
		const future = await h.call('POST', '/v1/review-requests', {
			body: {
				orderId: 'ord_future',
				customerId: 'cus_future',
				contact: { email: 'future@example.com' },
				items: [{ itemId: 'itm_future' }],
				completedAt: new Date(T0 + 5 * DAY).toISOString(),
			},
		});
		expect(future.status).toBe(201);
		expect(future.json).toMatchObject({ completedAt: new Date(T0 + DAY).toISOString(), delivery: { sends: 1 } });
		h.providers.failMessaging({ status: 503 });
		await h.completeOrder({ customerId: 'cus_fail', items: ['itm_bg4'] });
		h.providers.failMessaging(null);
		h.clock.set(T0);
		await h.entitle();

		h.clock.advance(400 * DAY);
		const read = await h.call('GET', `/v1/review-requests/${stored?.id}`);
		expect(read.json).toMatchObject({ status: 'expired', open: false });
		expect((await h.collection('requests').findOne({ websiteId: WEBSITE, orderId }))?.status).toBe('open');
		/** @param {string} status */
		const ids = async (status) =>
			(await h.call('GET', `/v1/review-requests?filter[status]=${status}&limit=100`)).json.items.map(
				(/** @type {any} */ r) => r.id,
			);
		expect(await ids('expired')).toContain(stored?.id);
		expect(await ids('open')).not.toContain(stored?.id);
		expect(await ids('completed')).not.toContain(stored?.id);
		// opening its link settles it as expired
		const link = await h.call('POST', `/v1/review-requests/${stored?.id}/link`, { idempotencyKey: null });
		await h.call('POST', '/v1/review-requests:open', { body: { token: link.json.token }, idempotencyKey: null });
		expect((await h.collection('requests').findOne({ websiteId: WEBSITE, orderId }))?.status).toBe('expired');
		h.clock.set(T0);
	});

	it('lets the merchant open, read, link and cancel requests through the API, and order events close them', async () => {
		const created = await h.call('POST', '/v1/review-requests', {
			body: {
				orderId: 'ord_api_1',
				customerId: 'cus_api',
				number: 'A-1',
				contact: { name: 'Api Buyer', email: 'api@example.com' },
				items: [{ itemId: 'itm_api', title: 'Api item' }],
				completedAt: new Date(T0).toISOString(),
			},
		});
		expect(created.status, JSON.stringify(created.json)).toBe(201);
		expect(created.json).toMatchObject({
			source: 'api',
			status: 'open',
			customerId: 'cus_api',
			delivery: { state: 'scheduled' },
		});
		const same = await h.call('POST', '/v1/review-requests', {
			body: { orderId: 'ord_api_1', customerId: 'cus_api', items: [{ itemId: 'itm_api' }] },
		});
		expect(same.status).toBe(200);
		expect((await h.call('POST', '/v1/review-requests', { body: { orderId: 'ord_api_2' } })).status).toBe(422);
		const read = await h.call('GET', `/v1/review-requests/${created.json.id}`);
		expect(read.json.id).toBe(created.json.id);
		expect((await h.call('GET', `/v1/review-requests/${created.json.id}`, { as: '' })).status).toBe(403);
		const link = await h.call('POST', `/v1/review-requests/${created.json.id}/link`, { idempotencyKey: null });
		expect(link.json.url).toMatch(/^https:\/\/shop\.example\.com\/review\?t=rl1\./);
		const listed = await h.call('GET', '/v1/review-requests?filter[customerId]=cus_api');
		expect(listed.json.items[0]).toMatchObject({ id: created.json.id, delivery: expect.any(Object) });
		const page = await h.call('GET', '/v1/review-requests?limit=1&filter[status]=open');
		expect(page.json.hasMore).toBe(true);
		const next = await h.call(
			'GET',
			`/v1/review-requests?limit=1&filter[status]=open&cursor=${encodeURIComponent(page.json.nextCursor)}`,
		);
		expect(next.json.items[0].id).not.toBe(page.json.items[0].id);
		expect((await h.call('GET', '/v1/review-requests?filter[status]=bogus')).status).toBe(422);
		const cancelled = await h.call('POST', `/v1/review-requests/${created.json.id}/cancel`, { idempotencyKey: null });
		expect(cancelled.json.status).toBe('cancelled');
		expect((await h.call('POST', `/v1/review-requests/${created.json.id}/cancel`, { idempotencyKey: null })).json.status).toBe(
			'cancelled',
		);
		expect((await h.call('POST', '/v1/review-requests/rrq_none/cancel', { idempotencyKey: null })).status).toBe(404);
		expect((await h.call('POST', '/v1/review-requests/rrq_none/link', { idempotencyKey: null })).status).toBe(404);
		expect((await h.call('GET', '/v1/review-requests/rrq_none')).status).toBe(404);

		// order.cancelled closes a request; order.refunded removes the refunded items
		const { orderId: cancelledOrder } = await h.completeOrder({ customerId: 'cus_cancel', items: ['itm_c1'] });
		await h.deliver('order.cancelled@1', { orderId: cancelledOrder });
		expect((await h.collection('requests').findOne({ websiteId: WEBSITE, orderId: cancelledOrder }))?.status).toBe('cancelled');
		const { orderId: refundedOrder } = await h.completeOrder({ customerId: 'cus_refund', items: ['itm_k1', 'itm_k2'] });
		await h.deliver('order.refunded@1', {
			orderId: refundedOrder,
			amount: { amount: 1000, currency: 'USD' },
			lines: [{ itemId: 'itm_k1', quantity: 1 }],
		});
		const partial = await h.collection('requests').findOne({ websiteId: WEBSITE, orderId: refundedOrder });
		expect(partial?.items.map((/** @type {any} */ item) => item.itemId)).toEqual(['itm_k2']);
		expect(partial?.status).toBe('open');
		await h.deliver('order.refunded@1', { orderId: refundedOrder, amount: { amount: 1000, currency: 'USD' } });
		expect((await h.collection('requests').findOne({ websiteId: WEBSITE, orderId: refundedOrder }))?.status).toBe('cancelled');
		await h.deliver('order.cancelled@1', { orderId: 'ord_unknown' });
		// completion without a customer or without items opens nothing; events for other websites are ignored
		await h.deliver('order.completed@1', {
			orderId: 'ord_anon',
			currency: 'USD',
			lines: [{ itemId: 'itm_z', quantity: 1, unitAmount: 1 }],
		});
		await h.deliver('order.completed@1', { orderId: 'ord_empty', customerId: 'cus_empty' });
		expect(
			await h.collection('requests').countDocuments({ websiteId: WEBSITE, orderId: { $in: ['ord_anon', 'ord_empty'] } }),
		).toBe(0);
		const foreign = await h.deliver(
			'order.completed@1',
			{ orderId: 'ord_foreign', customerId: 'cus_f' },
			{ websiteId: 'web_9123456789abcdefghjkmnpq' },
		);
		expect(foreign.status).toBe(200);
	});
});

describe('photos', () => {
	it('presigns uploads to the merchant bucket and attaches verified photos to a review', async () => {
		await h.entitle({ config: { collection: { who: 'identified' } } });
		const slot = await h.call('POST', '/v1/review-photos', {
			as: 'cus_photo',
			body: { contentType: 'image/jpeg', size: 1200 },
		});
		expect(slot.status, JSON.stringify(slot.json)).toBe(201);
		expect(slot.json.upload).toMatchObject({
			method: 'PUT',
			headers: { 'content-type': 'image/jpeg', 'content-length': '1200' },
		});
		expect(slot.json.upload.url).toMatch(/^https:\/\/s3\.example\.com\/shop-media\/reviews\/web_/);
		// type and declared size are signed headers: the bucket refuses any other body
		expect(new URL(slot.json.upload.url).searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
		const stored = await h.collection('photos').findOne({ websiteId: WEBSITE, id: slot.json.id });
		expect(stored).toMatchObject({ status: 'pending', customerId: 'cus_photo', key: `photos/${slot.json.id}`, size: 1200 });
		// keys stay relative; the full object key is kept for public base URLs
		expect(stored?.objectKey).toBe(`reviews/${WEBSITE}/photos/${slot.json.id}`);
		expect(new URL(slot.json.upload.url).pathname).toBe(`/shop-media/reviews/${WEBSITE}/photos/${slot.json.id}`);
		// not uploaded yet → refused
		const early = await h.call('POST', '/v1/reviews', {
			as: 'cus_photo',
			body: { itemId: 'itm_p', rating: 5, body: text, photoIds: [slot.json.id] },
		});
		expect(early.status).toBe(422);
		// a store that ignores the signed length: the HEAD check still refuses another size than declared
		h.providers.upload(String(stored?.objectKey), 1100, 'image/jpeg');
		expect(
			(
				await h.call('POST', '/v1/reviews', {
					as: 'cus_photo',
					body: { itemId: 'itm_p', rating: 5, body: text, photoIds: [slot.json.id] },
				})
			).status,
		).toBe(422);
		h.providers.upload(String(stored?.objectKey), 1200, 'image/jpeg');
		const review = await h.call('POST', '/v1/reviews', {
			as: 'cus_photo',
			body: { itemId: 'itm_p', rating: 5, body: text, photoIds: [slot.json.id] },
		});
		expect(review.status, JSON.stringify(review.json)).toBe(201);
		expect(review.json.photos[0]).toMatchObject({ id: slot.json.id, contentType: 'image/jpeg' });
		expect(review.json.photos[0].url).toMatch(/X-Amz-Signature=/);
		expect((await h.call('GET', `/v1/review-photos/${slot.json.id}`)).json).toMatchObject({
			status: 'attached',
			reviewId: review.json.id,
		});
		expect((await h.call('GET', '/v1/review-photos/rph_none')).status).toBe(404);
		// someone else's photo, a wrong type, too many photos, types not allowed
		const other = await h.call('POST', '/v1/review-photos', { as: 'cus_other', body: { contentType: 'image/png', size: 10 } });
		const otherDoc = await h.collection('photos').findOne({ websiteId: WEBSITE, id: other.json.id });
		h.providers.upload(String(otherDoc?.objectKey), 10, 'image/gif');
		expect(
			(
				await h.call('POST', '/v1/reviews', {
					as: 'cus_photo',
					body: { itemId: 'itm_p2', rating: 5, body: text, photoIds: [other.json.id] },
				})
			).status,
		).toBe(422);
		expect(
			(
				await h.call('POST', '/v1/reviews', {
					as: 'cus_other',
					body: { itemId: 'itm_p2', rating: 5, body: text, photoIds: [other.json.id] },
				})
			).status,
		).toBe(422);
		expect(
			(await h.call('POST', '/v1/review-photos', { as: 'cus_photo', body: { contentType: 'image/gif', size: 10 } })).status,
		).toBe(422);
		expect(
			(await h.call('POST', '/v1/review-photos', { as: 'cus_photo', body: { contentType: 'image/png', size: 99_999_999 } }))
				.status,
		).toBe(422);
		expect((await h.call('POST', '/v1/review-photos', { as: '', body: { contentType: 'image/png', size: 10 } })).status).toBe(
			401,
		);
		const server = await h.call('POST', '/v1/review-photos', {
			body: { contentType: 'image/webp', size: 10, customerId: 'cus_srv' },
		});
		expect(server.status).toBe(201);
		expect(
			(
				await h.call('POST', '/v1/reviews', {
					body: { itemId: 'itm_p3', rating: 5, body: text, photoIds: ['a', 'b', 'c', 'd'] },
				})
			).status,
		).toBe(422);
		// public base URL instead of presigned links
		await h.entitle({
			config: { collection: { who: 'identified' }, photos: { public_base_url: 'https://cdn.example.com/media/' } },
		});
		const pub = await h.call('GET', `/v1/reviews/${review.json.id}`);
		expect(pub.json.photos[0].url).toMatch(/^https:\/\/cdn\.example\.com\/media\/reviews\/web_/);
		// photos off: photoIds refused, uploads gated
		await h.entitle({ elements: { photos: false } });
		expect(
			(await h.call('POST', '/v1/reviews', { body: { itemId: 'itm_p4', rating: 5, body: text, photoIds: ['x'] } })).json
				.errors[0].code,
		).toBe('photos_disabled');
		expect((await h.call('POST', '/v1/review-photos', { body: { contentType: 'image/png', size: 10 } })).status).toBe(403);
		await h.entitle();
	});

	it('accepts uploads with a review link token, and reports an unavailable bucket', async () => {
		const { orderId } = await h.completeOrder({ customerId: 'cus_tokphoto', items: ['itm_tp'] });
		const request = await h.collection('requests').findOne({ websiteId: WEBSITE, orderId });
		const link = await h.call('POST', `/v1/review-requests/${request?.id}/link`, { idempotencyKey: null });
		const slot = await h.call('POST', '/v1/review-photos', {
			as: '',
			body: { contentType: 'image/png', size: 10, token: link.json.token },
		});
		expect(slot.status).toBe(201);
		expect((await h.collection('photos').findOne({ websiteId: WEBSITE, id: slot.json.id }))?.customerId).toBe('cus_tokphoto');
		expect(
			(
				await h.call('POST', '/v1/review-photos', {
					as: '',
					body: { contentType: 'image/png', size: 10, token: 'rl1.bad.token' },
				})
			).status,
		).toBe(401);
		h.portal.setResource(WEBSITE_2, 'storage', { bucket: 'x' }, DAY);
		await h.entitle({ websiteId: WEBSITE_2 });
		const sk2 = await h.key('sk', WEBSITE_2);
		const broken = await h.call('POST', '/v1/review-photos', { key: sk2, body: { contentType: 'image/png', size: 10 } });
		expect(broken.status).toBe(503);
		expect(broken.json.type).toMatch(/storage_unavailable$/);
	});
});

describe('stale photo slots', () => {
	it('sweeps slots never attached on the next upload and from the dashboard: objects deleted, records removed', async () => {
		await h.entitle({ config: { collection: { who: 'identified', send_on_completion: false } } });
		const uploaded = await h.call('POST', '/v1/review-photos', {
			as: 'cus_stale',
			body: { contentType: 'image/png', size: 10 },
		});
		const never = await h.call('POST', '/v1/review-photos', { as: 'cus_stale', body: { contentType: 'image/png', size: 20 } });
		const doc = await h.collection('photos').findOne({ websiteId: WEBSITE, id: uploaded.json.id });
		expect(doc?.staleAt).toBeInstanceOf(Date);
		expect(doc?.purgeAt.getTime() - doc?.staleAt.getTime()).toBe(STALE_BACKSTOP_MS);
		h.providers.upload(String(doc?.objectKey), 10, 'image/png');
		const session = await dashboardSession();
		// before the stale date nothing is swept
		const early = await h.call('POST', '/v1/dashboard/photos:sweep', { key: session, idempotencyKey: null, body: {} });
		expect(early.json.scanned).toBe(0);
		h.clock.advance(30 * DAY + 1_000);
		// past the stale date the slot cannot be attached any more
		const late = await h.call('POST', '/v1/reviews', {
			as: 'cus_stale',
			body: { itemId: 'itm_stale', rating: 5, body: text, photoIds: [uploaded.json.id] },
		});
		expect(late.status).toBe(422);
		h.clock.advance(HOUR);
		// the website's next upload sweeps the stale slots: the uploaded object and both records are gone
		const fresh = await h.call('POST', '/v1/review-photos', { as: 'cus_stale', body: { contentType: 'image/png', size: 30 } });
		expect(fresh.status).toBe(201);
		expect(h.providers.objects.has(String(doc?.objectKey))).toBe(false);
		expect(
			await h.collection('photos').countDocuments({ websiteId: WEBSITE, id: { $in: [uploaded.json.id, never.json.id] } }),
		).toBe(0);
		expect(await h.collection('photos').countDocuments({ websiteId: WEBSITE, id: fresh.json.id })).toBe(1);
		// the dashboard button sweeps too (nothing left that is stale)
		const again = await h.call('POST', '/v1/dashboard/photos:sweep', {
			key: await dashboardSession(),
			idempotencyKey: null,
			body: {},
		});
		expect(again.status).toBe(200);
		expect(again.json).toMatchObject({ scanned: 0, failed: 0 });
		h.clock.set(T0);
		await h.entitle();
	});

	it('cleans up from the dashboard; an unreachable bucket or a failing sweep never fails a request', async () => {
		const session = await dashboardSession();
		await h.collection('photos').insertOne({
			websiteId: WEBSITE,
			id: 'rph_old_slot',
			key: 'photos/rph_old_slot',
			status: 'pending',
			staleAt: new Date(T0 - DAY),
			purgeAt: new Date(T0 + DAY),
		});
		const swept = await h.call('POST', '/v1/dashboard/photos:sweep', { key: session, idempotencyKey: null, body: {} });
		expect(swept.json).toMatchObject({ scanned: 1, missing: 1, failed: 0 });
		expect(await h.collection('photos').countDocuments({ websiteId: WEBSITE, id: 'rph_old_slot' })).toBe(0);
		// a failing sweep on upload never fails the upload
		const site = await h.reviews.siteFor(WEBSITE);
		if (!site) throw new Error('no site');
		const failing = /** @type {any} */ ({
			...site,
			repos: { ...site.repos, photos: { ...site.repos.photos, sweepStale: async () => Promise.reject(new Error('down')) } },
		});
		const upload = await h.reviews.service.createUpload(failing, {
			contentType: 'image/png',
			size: 5,
			customerId: null,
			key: 'k_sweep_fail',
		});
		expect(upload.ok).toBe(true);
		// a storage connector that cannot be resolved is counted as failed (the slot stays for the next run)
		h.portal.setResource(WEBSITE_2, 'storage', { bucket: 'x' }, DAY);
		await h.entitle({ websiteId: WEBSITE_2 });
		await h.collection('photos').insertOne({
			websiteId: WEBSITE_2,
			id: 'rph_old_slot_2',
			key: 'photos/rph_old_slot_2',
			status: 'pending',
			staleAt: new Date(T0 - DAY),
			purgeAt: new Date(T0 + DAY),
		});
		const { token } = await h.portal.issueLaunch({
			kind: 'merchant',
			subject: 'usr_merchant',
			user: { id: 'usr_merchant' },
			scope: { merchantId: MERCHANT, websiteId: WEBSITE_2 },
		});
		const exchanged = await h.reviews.product.launch.exchange(token);
		if (!exchanged.ok) throw new Error(exchanged.code);
		const broken = await h.call('POST', '/v1/dashboard/photos:sweep', {
			key: exchanged.session.id,
			idempotencyKey: null,
			body: {},
		});
		expect(broken.status).toBe(200);
		expect(broken.json).toMatchObject({ deleted: 0, failed: 1 });
		await h.collection('photos').deleteOne({ websiteId: WEBSITE_2, id: 'rph_old_slot_2' });
	});

	it('migrates pending slots written before the sweep (purgeAt → staleAt, TTL moved back)', async () => {
		const purgeAt = new Date(T0 + DAY);
		await h.collection('photos').insertOne({ websiteId: WEBSITE, id: 'rph_legacy', status: 'pending', purgeAt });
		const migration = MIGRATIONS.find((step) => step.name === 'photo_stale_dates');
		await migration?.up({ websiteId: WEBSITE, collection: (/** @type {string} */ name) => h.collection(name) });
		const legacy = await h.collection('photos').findOne({ websiteId: WEBSITE, id: 'rph_legacy' });
		expect(legacy?.staleAt).toEqual(purgeAt);
		expect(legacy?.purgeAt).toEqual(new Date(purgeAt.getTime() + STALE_BACKSTOP_MS));
		await h.collection('photos').deleteOne({ websiteId: WEBSITE, id: 'rph_legacy' });
	});
});

describe('questions & answers', () => {
	it('takes questions from signed-in shoppers, moderates them, and publishes merchant and customer answers', async () => {
		await h.entitle({ config: { qna: { who_can_answer: 'verified_buyers' } } });
		const asked = await h.call('POST', '/v1/questions', {
			as: 'cus_q',
			body: { itemId: 'itm_q', body: 'Does it fit the 2025 model?' },
		});
		expect(asked.status).toBe(201);
		expect(asked.json).toMatchObject({ status: 'pending', answers: [] });
		expect((await h.call('GET', '/v1/questions?filter[itemId]=itm_q', { as: '' })).json.items).toHaveLength(0);
		expect((await h.call('GET', `/v1/questions/${asked.json.id}`, { as: '' })).status).toBe(404);
		expect((await h.call('POST', `/v1/questions/${asked.json.id}/publish`, { idempotencyKey: null })).json.status).toBe(
			'published',
		);
		expect((await h.call('POST', `/v1/questions/${asked.json.id}/publish`, { idempotencyKey: null })).status).toBe(409);
		const merchant = await h.call('POST', `/v1/questions/${asked.json.id}/answers`, {
			body: { body: 'Yes, every 2025 model.' },
		});
		expect(merchant.status).toBe(201);
		expect(merchant.json.answers[0]).toMatchObject({ by: 'merchant', status: 'published' });
		// customers: only verified buyers of the item, moderated
		expect(
			(await h.call('POST', `/v1/questions/${asked.json.id}/answers`, { as: 'cus_stranger', body: { body: 'No idea' } }))
				.status,
		).toBe(403);
		await h.completeOrder({ customerId: 'cus_owner', items: ['itm_q'] });
		const community = await h.call('POST', `/v1/questions/${asked.json.id}/answers`, {
			as: 'cus_owner',
			body: { body: 'Mine fits well.', author: { name: 'Owner One' } },
		});
		expect(community.status).toBe(201);
		const pendingAnswer = community.json.answers.find((/** @type {any} */ a) => a.by === 'customer');
		expect(pendingAnswer).toBeUndefined(); // not visible to the asker until approved
		const full = await h.call('GET', `/v1/questions/${asked.json.id}`);
		const answer = full.json.answers.find((/** @type {any} */ a) => a.by === 'customer');
		expect(answer).toMatchObject({ status: 'pending', verifiedBuyer: true });
		expect(
			(await h.call('POST', `/v1/questions/${asked.json.id}/answers/${answer.id}/publish`, { idempotencyKey: null })).status,
		).toBe(200);
		const pub = await h.call('GET', '/v1/questions?filter[itemId]=itm_q', { as: '' });
		expect(pub.json.items[0].answers.map((/** @type {any} */ a) => a.author)).toEqual([null, 'Owner O.']);
		expect(
			(await h.call('POST', `/v1/questions/${asked.json.id}/answers/${answer.id}/reject`, { idempotencyKey: null })).status,
		).toBe(409);
		expect((await h.call('POST', '/v1/questions/rqn_none/reject', { idempotencyKey: null })).status).toBe(404);
		expect((await h.call('POST', '/v1/questions/rqn_none/answers', { body: { body: 'x' } })).status).toBe(404);
		const admin = await h.call('GET', '/v1/questions?filter[status]=published');
		expect(admin.json.items[0].status).toBe('published');
		expect((await h.call('GET', '/v1/questions?filter[status]=x')).status).toBe(422);
		await h.entitle();
	});

	it('enforces who may ask and answer, limits and validation', async () => {
		expect(
			(await h.call('POST', '/v1/questions', { as: '', body: { itemId: 'itm_q2', body: 'Is it waterproof?' } })).status,
		).toBe(401);
		await h.entitle({
			config: { qna: { who_can_ask: 'anyone', moderate_questions: false, max_questions_per_customer_per_day: 1 } },
		});
		expect(
			(await h.call('POST', '/v1/questions', { as: '', body: { itemId: 'itm_q2', body: 'Is it waterproof?' } })).status,
		).toBe(422);
		const guest = await h.call('POST', '/v1/questions', {
			as: '',
			body: { itemId: 'itm_q2', body: 'Is it waterproof?', author: { name: 'Guest' } },
		});
		expect(guest.json.status).toBe('published');
		await h.call('POST', '/v1/questions', { as: 'cus_lim', body: { itemId: 'itm_q2', body: 'First question here?' } });
		expect(
			(await h.call('POST', '/v1/questions', { as: 'cus_lim', body: { itemId: 'itm_q2', body: 'Second question here?' } }))
				.status,
		).toBe(429);
		expect(
			(await h.call('POST', `/v1/questions/${guest.json.id}/answers`, { as: 'cus_lim', body: { body: 'Sure' } })).status,
		).toBe(403);
		expect((await h.call('POST', '/v1/questions', { body: { itemId: 'itm_q2', body: 'x' } })).status).toBe(422);
		const server = await h.call('POST', '/v1/questions', {
			body: { itemId: 'itm_q2', body: 'Asked by the store?', customerId: 'cus_s' },
		});
		expect(server.json).toMatchObject({ status: 'published', customerId: 'cus_s' });
		const rejected = await h.call('POST', `/v1/questions/${server.json.id}/reject`, { idempotencyKey: null });
		expect(rejected.json.status).toBe('rejected');
		expect((await h.call('POST', `/v1/questions/${server.json.id}/answers`, { body: { body: 'late' } })).status).toBe(404);
		expect((await h.call('POST', `/v1/questions/${guest.json.id}/answers`, { body: {} })).status).toBe(422);
		await h.entitle();
	});
});

describe('import and analytics', () => {
	it('imports CSV with validation, a dry run and duplicate protection, then rolls the ratings up', async () => {
		const csv = [
			'item_id,rating,title,body,author,submitted_at,verified,external_id,reply',
			'itm_imp,5,Great,"Works, really ""well""",Ayesha Khan,2025-06-01T10:00:00Z,true,old-1,Thanks!',
			'itm_imp,4,,Good,Ben,2025-07-01,false,old-2,',
			'itm_imp,9,Bad rating,,X,,yes,old-3,',
			'bad id,3,,,,,,,',
		].join('\r\n');
		const dry = await h.call('POST', '/v1/imports', { body: { csv, dryRun: true } });
		expect(dry.json).toMatchObject({ dryRun: true, rows: 4, valid: 2, invalid: 2, imported: 0 });
		expect(dry.json.errors.map((/** @type {any} */ e) => `${e.row}${e.path}:${e.code}`)).toEqual([
			'4/rating:rating_invalid',
			'5/item_id:id_invalid',
		]);
		const run = await h.call('POST', '/v1/imports', { body: { csv } });
		expect(run.json).toMatchObject({ dryRun: false, imported: 2, duplicates: 0 });
		const again = await h.call('POST', '/v1/imports', { body: { csv } });
		expect(again.json).toMatchObject({ imported: 0, duplicates: 2 });
		const summary = await h.call('GET', '/v1/ratings/itm_imp', { as: '' });
		expect(summary.json).toMatchObject({ count: 2, average: 4.5 });
		const imported = await h.collection('reviews').findOne({ websiteId: WEBSITE, externalId: 'old-1' });
		expect(imported).toMatchObject({
			source: 'import',
			status: 'approved',
			verifiedPurchase: false,
			body: 'Works, really "well"',
			reply: { body: 'Thanks!' },
		});
		expect((await h.call('POST', '/v1/imports', { body: { csv: '"unterminated' } })).status).toBe(422);
		expect((await h.call('POST', '/v1/imports', { body: { csv: 'title\nx' } })).json.errors[0]).toMatchObject({
			code: 'column_missing',
		});
		expect((await h.call('POST', '/v1/imports', { body: {} })).status).toBe(422);
		// moderated imports and trusted verified columns
		await h.entitle({ config: { import: { imported_status: 'moderate', trust_verified_column: true, delimiter: ';' } } });
		const moderated = await h.call('POST', '/v1/imports', {
			body: { csv: 'item_id;rating;body;verified;external_id\nitm_imp2;5;Lovely thing;yes;old-9' },
		});
		expect(moderated.json.imported).toBe(1);
		expect(await h.collection('reviews').findOne({ websiteId: WEBSITE, externalId: 'old-9' })).toMatchObject({
			status: 'approved',
			verifiedPurchase: true,
		});
		await h.entitle({ config: { import: { max_rows: 1 } } });
		expect((await h.call('POST', '/v1/imports', { body: { csv: 'item_id,rating\na,1\nb,2' } })).json.errors[0].code).toBe(
			'too_many_rows',
		);
		await h.entitle();
	});

	it('reports volume, ratings, conversion and timing per bucket in the website time zone', async () => {
		const analytics = await h.call(
			'GET',
			`/v1/analytics?from=${encodeURIComponent(new Date(T0 - DAY).toISOString())}&to=${encodeURIComponent(new Date(T0 + 30 * DAY).toISOString())}&bucket=week`,
		);
		expect(analytics.status, JSON.stringify(analytics.json)).toBe(200);
		expect(analytics.json.totals.submitted).toBeGreaterThan(0);
		expect(analytics.json.series.length).toBeGreaterThan(1);
		expect(analytics.json.requests.created).toBeGreaterThan(0);
		expect(analytics.json.topItems.length).toBeGreaterThan(0);
		expect((await h.call('GET', '/v1/analytics')).status).toBe(200);
		expect((await h.call('GET', '/v1/analytics?bucket=year')).status).toBe(422);
		expect((await h.call('GET', '/v1/analytics?from=2020-01-01T00:00:00Z')).status).toBe(422);
		expect((await h.call('GET', '/v1/analytics', { as: '' })).status).toBe(403);
	});
});

describe('dashboard', () => {
	/** @param {'merchant' | 'admin'} kind @param {Record<string, unknown>} [extra] */
	const launch = async (kind, extra = {}) => {
		const { token } = await h.portal.issueLaunch({
			kind,
			subject: 'usr_merchant',
			user: { id: 'usr_merchant' },
			scope: { merchantId: MERCHANT, websiteId: WEBSITE },
			...extra,
		});
		const sso = await h.handle(new Request(`https://reviews.example.com/sso?launch=${encodeURIComponent(token)}`));
		const session = /ss_session=(ses_[^;]+)/.exec(sso.headers.get('set-cookie') ?? '')?.[1];
		if (!session) throw new Error(`no session (${sso.status})`);
		return session;
	};

	it('moderates and answers from merchant sessions (audited)', async () => {
		const session = await launch('merchant');
		const bearer = { key: session };
		const overview = await h.call('GET', '/v1/dashboard/overview', bearer);
		expect(overview.json.reviews).toMatchObject({ pending: expect.any(Number), approved: expect.any(Number) });
		const pending = await h.call('POST', '/v1/reviews', {
			body: { itemId: 'itm_dash', rating: 4, body: text, author: { name: 'Dash' } },
		});
		const approved = await h.call('POST', `/v1/dashboard/moderation/${pending.json.id}/approve`, {
			...bearer,
			idempotencyKey: null,
			body: {},
		});
		expect(approved.status).toBe(200);
		const replied = await h.call('POST', `/v1/dashboard/moderation/${pending.json.id}/reply`, {
			...bearer,
			idempotencyKey: null,
			body: { body: 'Thanks' },
		});
		expect(replied.json.reply.body).toBe('Thanks');
		const audit = await h.db
			.collection('ss_reviews_audit')
			.findOne({ websiteId: WEBSITE, action: 'review.approved', 'target.reviewId': pending.json.id });
		expect(audit?.actor).toMatchObject({ type: 'merchant', id: 'usr_merchant' });
		const rejected = await h.call('POST', `/v1/dashboard/moderation/${pending.json.id}/reject`, {
			...bearer,
			idempotencyKey: null,
			body: { reason: 'other' },
		});
		expect(rejected.json.status).toBe('rejected');
		const question = await h.call('POST', '/v1/questions', { body: { itemId: 'itm_dash', body: 'Dashboard question?' } });
		expect(
			(await h.call('POST', `/v1/dashboard/questions/${question.json.id}/answers`, { ...bearer, body: { body: 'Answer' } }))
				.status,
		).toBe(201);
		expect(
			(await h.call('POST', `/v1/dashboard/questions/${question.json.id}/reject`, { ...bearer, idempotencyKey: null })).json
				.status,
		).toBe('rejected');
		expect(
			(await h.call('POST', `/v1/dashboard/questions/${question.json.id}/publish`, { ...bearer, idempotencyKey: null }))
				.status,
		).toBe(409);
		expect(
			(
				await h.call('POST', '/v1/dashboard/moderation:check', {
					...bearer,
					body: { source: 'review.rating >' },
					idempotencyKey: null,
				})
			).json.ok,
		).toBe(false);
		expect((await h.call('POST', '/v1/dashboard/moderation:check', { ...bearer, body: {}, idempotencyKey: null })).status).toBe(
			422,
		);
		expect((await h.call('GET', '/v1/session', bearer)).json).toMatchObject({ kind: 'merchant', role: 'merchant' });
		const admin = await launch('admin', { scope: { merchantId: MERCHANT } });
		expect((await h.call('GET', '/v1/dashboard/overview', { key: admin })).status).toBe(400);
	});

	it('runs the request flow on demand from merchant sessions ("Send due requests now")', async () => {
		const { orderId } = await h.completeOrder({ customerId: 'cus_dash_run', items: ['itm_dash_run'] });
		const session = await launch('merchant');
		const run = await h.call('POST', '/v1/dashboard/request-flow:run', { key: session, idempotencyKey: null, body: {} });
		expect(run.status).toBe(200);
		expect(run.json.sent).toBeGreaterThanOrEqual(1);
		expect((await h.collection('requests').findOne({ websiteId: WEBSITE, orderId }))?.delivery.sends).toBe(1);
		const admin = await launch('admin', { scope: { merchantId: MERCHANT } });
		expect(
			(await h.call('POST', '/v1/dashboard/request-flow:run', { key: admin, idempotencyKey: null, body: {} })).status,
		).toBe(400);
		expect((await h.call('POST', '/v1/dashboard/photos:sweep', { key: admin, idempotencyKey: null, body: {} })).status).toBe(
			400,
		);
		await h.entitle({ elements: { request_flow: false } });
		expect(
			(await h.call('POST', '/v1/dashboard/request-flow:run', { key: session, idempotencyKey: null, body: {} })).status,
		).toBe(403);
		await h.entitle();
	});

	it('resolves what the pages show for every session state', async () => {
		const reviews = h.reviews;
		expect(await resolveDashboard({ reviews, sessionId: null })).toEqual({ state: 'signin' });
		expect(await resolveDashboard({ reviews, sessionId: 'ses_unknown' })).toEqual({ state: 'signin' });
		const live = await resolveDashboard({ reviews, sessionId: await launch('merchant') });
		if (live.state !== 'ready') throw new Error('not ready');
		expect(live.portalLink).toContain(`/websites/${WEBSITE}/subscriptions/`);
		expect(live.data).toMatchObject({ canWrite: true, websiteId: WEBSITE });
		expect((await live.data.overview()).reviews.approved).toBeGreaterThan(0);
		expect((await live.data.reviews('approved')).length).toBeGreaterThan(0);
		expect(Array.isArray(await live.data.questions('pending'))).toBe(true);
		const admin = await launch('admin', { scope: { merchantId: MERCHANT } });
		expect((await resolveDashboard({ reviews, sessionId: admin })).state).toBe('pick_website');
		await h.entitle({ elements: { collection: false } });
		expect((await resolveDashboard({ reviews, sessionId: await launch('merchant') })).state).toBe('not_subscribed');
		await h.entitle();
	});
});
