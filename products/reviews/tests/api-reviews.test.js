/**
 * Collection, moderation, display and structured data through the real app-kit router, the fake Portal and the
 * merchant database: verified purchases from order.completed@1, the website's own identity, review links, guests,
 * auto-moderation, rollups, JSON-LD, usage and events.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, DAY, WEBSITE } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
beforeAll(async () => {
	h = await createHarness();
});
afterAll(async () => h?.close());

const text = 'Arrived quickly and works perfectly. Would buy again.';

describe('verified purchases', () => {
	it('opens a review request from order.completed@1 and lets the signed-in buyer review — auto-approved by the default rule', async () => {
		const { orderId, result } = await h.completeOrder({ customerId: 'cus_ava', items: ['itm_a', 'itm_b'] });
		expect(result.status).toBe(200);
		const [request] = await h.collection('requests').find({ websiteId: WEBSITE, orderId }).toArray();
		expect(request).toMatchObject({ status: 'open', customerId: 'cus_ava', merchantId: expect.any(String), env: 'live' });
		expect(request?.items.map((/** @type {any} */ item) => item.itemId)).toEqual(['itm_a', 'itm_b']);
		expect(request?.dueAt).toBe(new Date(h.clock.now() + 168 * 3_600_000).toISOString());

		const open = await h.call('GET', '/v1/review-requests', { as: 'cus_ava' });
		expect(open.status).toBe(200);
		expect(open.json.items[0]).toMatchObject({
			orderId,
			open: true,
			items: [{ itemId: 'itm_a', reviewed: false }, { itemId: 'itm_b' }],
		});
		expect(open.json.items[0]).not.toHaveProperty('delivery');

		const submitted = await h.call('POST', '/v1/reviews', {
			as: 'cus_ava',
			body: { itemId: 'itm_a', rating: 5, title: 'Great', body: text, author: { name: 'Ava Martin' } },
		});
		expect(submitted.status, JSON.stringify(submitted.json)).toBe(201);
		expect(submitted.json).toMatchObject({
			itemId: 'itm_a',
			rating: 5,
			status: 'approved',
			author: 'Ava M.',
			verifiedPurchase: true,
		});
		expect(submitted.json).not.toHaveProperty('customerId');

		const summary = await h.call('GET', '/v1/ratings/itm_a', { as: '' });
		expect(summary.json).toMatchObject({ count: 1, average: 5, scale: 5, verified: 1 });
		expect(summary.headers.get('cache-control')).toBe('public, max-age=60');
		const list = await h.call('GET', '/v1/reviews?filter[itemId]=itm_a&include=summary', { as: '' });
		expect(list.json.items).toHaveLength(1);
		expect(list.json.summary.count).toBe(1);

		const approved = h.published('reviews.approved@1');
		expect(approved.at(-1)?.data).toMatchObject({
			itemId: 'itm_a',
			decidedBy: 'rule',
			ruleId: 'verified_clean',
			summary: { count: 1, average: 5 },
		});
		expect(h.published('reviews.submitted@1').at(-1)?.data).toMatchObject({
			status: 'approved',
			source: 'storefront',
			orderId,
		});
		const usage = await h.app.product.usage.flush();
		expect(usage.sent).toBeGreaterThanOrEqual(1);
		expect([...h.portal.usage.values()].some((/** @type {any} */ record) => record.unit === 'review')).toBe(true);

		// the request remembers the reviewed item; a second review of it is refused (one per order item)
		const again = await h.call('POST', '/v1/reviews', { as: 'cus_ava', body: { itemId: 'itm_a', rating: 4, body: text } });
		expect(again.status).toBe(409);
		expect(again.json.type).toMatch(/already_reviewed$/);
		const second = await h.call('POST', '/v1/reviews', { as: 'cus_ava', body: { itemId: 'itm_b', rating: 4, body: text } });
		expect(second.status).toBe(201);
		const [done] = await h.collection('requests').find({ websiteId: WEBSITE, orderId }).toArray();
		expect(done?.status).toBe('completed');
	});

	it('refuses customers without a purchase (verified_buyers) and browsers without identity', async () => {
		const stranger = await h.call('POST', '/v1/reviews', {
			as: 'cus_nobody',
			body: { itemId: 'itm_a', rating: 1, body: text },
		});
		expect(stranger.status).toBe(403);
		expect(stranger.json.type).toMatch(/not_verified$/);
		const guest = await h.call('POST', '/v1/reviews', { as: '', body: { itemId: 'itm_a', rating: 1, body: text } });
		expect(guest.status).toBe(401);
		expect(guest.json.type).toMatch(/identity_required$/);
		const requests = await h.call('GET', '/v1/review-requests', { as: '' });
		expect(requests.status).toBe(401);
	});

	it('identifies the buyer by the identity subject carried on the order and by review links', async () => {
		const { orderId } = await h.completeOrder({
			customerId: 'cus_graph_1',
			subject: 'auth0|ben',
			items: ['itm_c'],
			placedFirst: true,
		});
		const viaSubject = await h.call('POST', '/v1/reviews', {
			as: 'auth0|ben',
			body: { itemId: 'itm_c', rating: 4, body: text },
		});
		expect(viaSubject.status, JSON.stringify(viaSubject.json)).toBe(201);
		expect(viaSubject.json.verifiedPurchase).toBe(true);

		const { orderId: second } = await h.completeOrder({ customerId: 'cus_link', items: ['itm_d', 'itm_e'] });
		const request = await h.collection('requests').findOne({ websiteId: WEBSITE, orderId: second });
		const link = await h.call('POST', `/v1/review-requests/${request?.id}/link`);
		expect(link.status).toBe(200);
		expect(link.json.url).toBeNull(); // no review_url configured
		const opened = await h.call('POST', '/v1/review-requests:open', { as: '', body: { token: link.json.token } });
		expect(opened.json).toMatchObject({ orderId: second, open: true });
		const viaLink = await h.call('POST', '/v1/reviews', {
			as: '',
			body: { token: link.json.token, itemId: 'itm_d', rating: 3, body: text },
		});
		expect(viaLink.status, JSON.stringify(viaLink.json)).toBe(201);
		expect(viaLink.json).toMatchObject({ verifiedPurchase: true, status: 'approved' });
		const stored = await h.collection('reviews').findOne({ websiteId: WEBSITE, id: viaLink.json.id });
		expect(stored).toMatchObject({ source: 'request_link', customerId: 'cus_link', orderId: second });
		const outside = await h.call('POST', '/v1/reviews', {
			as: '',
			body: { token: link.json.token, itemId: 'itm_zz', rating: 3, body: text },
		});
		expect(outside.status).toBe(403);
		const reused = await h.call('POST', '/v1/reviews', {
			as: '',
			body: { token: link.json.token, itemId: 'itm_d', rating: 3, body: text },
		});
		expect(reused.status).toBe(409);
		const forged = await h.call('POST', '/v1/reviews', {
			as: '',
			body: { token: `${link.json.token}x`, itemId: 'itm_e', rating: 3, body: text },
		});
		expect(forged.status).toBe(401);
		expect((await h.call('POST', '/v1/review-requests:open', { as: '', body: { token: 'rl1.x.y' } })).status).toBe(401);
		expect(orderId).toBeTruthy();
	});

	it('expires requests after the review window', async () => {
		const { orderId } = await h.completeOrder({ customerId: 'cus_late', items: ['itm_late'] });
		h.clock.advance(366 * DAY);
		const late = await h.call('POST', '/v1/reviews', { as: 'cus_late', body: { itemId: 'itm_late', rating: 5, body: text } });
		expect(late.status).toBe(403);
		const request = await h.collection('requests').findOne({ websiteId: WEBSITE, orderId });
		const link = await h.call('POST', `/v1/review-requests/${request?.id}/link`);
		const viaLink = await h.call('POST', '/v1/reviews', {
			as: '',
			body: { token: link.json.token, itemId: 'itm_late', rating: 5, body: text },
		});
		expect(viaLink.status).toBe(409);
		expect(viaLink.json.type).toMatch(/request_closed$/);
		h.clock.set(Date.parse('2026-10-01T10:00:00Z'));
	});
});

describe('policies and moderation', () => {
	it('accepts guests when who = anyone, but keeps unverified reviews in the queue', async () => {
		await h.entitle({ config: { collection: { who: 'anyone' } } });
		const nameless = await h.call('POST', '/v1/reviews', { as: '', body: { itemId: 'itm_g', rating: 4, body: text } });
		expect(nameless.status).toBe(422);
		const guest = await h.call('POST', '/v1/reviews', {
			as: '',
			body: { itemId: 'itm_g', rating: 4, body: text, author: { name: 'Guest Person' } },
		});
		expect(guest.status).toBe(201);
		expect(guest.json).toMatchObject({ status: 'pending', verifiedPurchase: false });
		const queue = await h.call('GET', '/v1/moderation');
		expect(queue.json.counts.pending).toBeGreaterThanOrEqual(1);
		const queued = queue.json.items.find((/** @type {any} */ item) => item.id === guest.json.id);
		expect(queued.moderation).toMatchObject({ by: 'default', reason: null });
		// approve manually: rollup and event follow
		const approved = await h.call('POST', `/v1/moderation/${guest.json.id}/approve`, { body: { note: 'looks genuine' } });
		expect(approved.status).toBe(200);
		expect(approved.json).toMatchObject({ status: 'approved', moderation: { by: 'person', note: 'looks genuine' } });
		expect((await h.call('GET', '/v1/ratings/itm_g', { as: '' })).json.count).toBe(1);
		expect(h.published('reviews.approved@1').at(-1)?.data).toMatchObject({ reviewId: guest.json.id, decidedBy: 'person' });
		expect((await h.call('POST', `/v1/moderation/${guest.json.id}/approve`)).status).toBe(409);
		// reject a published review: it leaves the rollup
		const rejected = await h.call('POST', `/v1/moderation/${guest.json.id}/reject`, { body: { reason: 'spam' } });
		expect(rejected.json).toMatchObject({ status: 'rejected', moderation: { reason: 'spam' } });
		expect((await h.call('GET', '/v1/ratings/itm_g', { as: '' })).json.count).toBe(0);
		expect((await h.call('POST', `/v1/moderation/${guest.json.id}/reject`, { body: { reason: 'nope' } })).status).toBe(422);
		expect((await h.call('POST', '/v1/moderation/rev_missing/approve')).status).toBe(404);
		await h.entitle();
	});

	it('runs content checks and rules@1 rules: blocked words, links, explicit reject rules', async () => {
		await h.entitle({
			config: {
				collection: { who: 'identified' },
				moderation: {
					blocked_terms: ['awful scam'],
					blocked_term_action: 'reject',
					rules: [
						{ id: 'low', when: 'review.rating <= 1', action: 'reject', reason: 'not_genuine' },
						{ id: 'clean', when: 'len(flags) == 0 and review.length >= 10', action: 'approve' },
					],
					auto_approve_unverified: true,
				},
			},
		});
		const scam = await h.call('POST', '/v1/reviews', {
			as: 'cus_w1',
			body: { itemId: 'itm_m', rating: 3, body: 'This is an AWFUL scam, really.' },
		});
		expect(scam.json.status).toBe('rejected');
		const link = await h.call('POST', '/v1/reviews', {
			as: 'cus_w2',
			body: { itemId: 'itm_m', rating: 4, body: 'Good, see https://elsewhere.example now' },
		});
		expect(link.json.status).toBe('pending');
		const low = await h.call('POST', '/v1/reviews', {
			as: 'cus_w3',
			body: { itemId: 'itm_m', rating: 1, body: 'Did not like it at all.' },
		});
		expect(low.json.status).toBe('rejected');
		const fine = await h.call('POST', '/v1/reviews', {
			as: 'cus_w4',
			body: { itemId: 'itm_m', rating: 4, body: 'Pretty good overall.' },
		});
		expect(fine.json).toMatchObject({ status: 'approved', verifiedPurchase: false });
		const stored = await h.collection('reviews').findOne({ websiteId: WEBSITE, id: scam.json.id });
		expect(stored?.moderation).toMatchObject({ by: 'check', reason: 'blocked_terms', terms: ['awful scam'] });
		const check = await h.call('POST', '/v1/moderation:check', {
			body: { source: 'review.rating >= ', review: { rating: 5, body: 'nice, www.x.example', verified: true } },
		});
		expect(check.json.condition.ok).toBe(false);
		expect(check.json.decision).toMatchObject({ status: 'pending', flags: ['links'] });
		expect((await h.call('POST', '/v1/moderation:check', { body: {} })).status).toBe(422);
		await h.entitle();
	});

	it('publishes everything when the moderation element is off, and enforces the daily limit', async () => {
		await h.entitle({
			config: { collection: { who: 'identified', max_reviews_per_customer_per_day: 2 } },
			elements: { moderation: false },
		});
		const first = await h.call('POST', '/v1/reviews', { as: 'cus_many', body: { itemId: 'itm_x1', rating: 2, body: text } });
		expect(first.json.status).toBe('approved');
		await h.call('POST', '/v1/reviews', { as: 'cus_many', body: { itemId: 'itm_x2', rating: 2, body: text } });
		const third = await h.call('POST', '/v1/reviews', { as: 'cus_many', body: { itemId: 'itm_x3', rating: 2, body: text } });
		expect(third.status).toBe(429);
		expect((await h.call('GET', '/v1/moderation')).status).toBe(403);
		await h.entitle();
	});

	it('replies publicly, removes replies, and honours replies_enabled', async () => {
		const review = await h.call('POST', '/v1/reviews', {
			body: { itemId: 'itm_r', rating: 5, body: text, author: { name: 'Api Person' } },
		});
		expect(review.status).toBe(201);
		expect(review.json).toMatchObject({ source: 'api', status: 'pending', customerId: null });
		await h.call('POST', `/v1/moderation/${review.json.id}/approve`);
		const replied = await h.call('POST', `/v1/moderation/${review.json.id}/reply`, { body: { body: 'Thank you!' } });
		expect(replied.json.reply).toMatchObject({ body: 'Thank you!' });
		const pub = await h.call('GET', `/v1/reviews/${review.json.id}`, { as: '' });
		expect(pub.json.reply).toMatchObject({ body: 'Thank you!' });
		const removed = await h.call('DELETE', `/v1/moderation/${review.json.id}/reply`);
		expect(removed.json.reply).toBeNull();
		await h.entitle({ config: { moderation: { replies_enabled: false } } });
		expect((await h.call('POST', `/v1/moderation/${review.json.id}/reply`, { body: { body: 'x' } })).status).toBe(403);
		await h.entitle();
		expect((await h.call('POST', '/v1/moderation/rev_nope/reply', { body: { body: 'x' } })).status).toBe(404);
		expect((await h.call('POST', `/v1/moderation/${review.json.id}/reply`, { body: {} })).status).toBe(422);
		// soft delete leaves the rollup
		expect((await h.call('GET', '/v1/ratings/itm_r', { as: '' })).json.count).toBe(1);
		expect((await h.call('DELETE', `/v1/reviews/${review.json.id}`)).json).toEqual({ id: review.json.id, deleted: true });
		expect((await h.call('GET', '/v1/ratings/itm_r', { as: '' })).json.count).toBe(0);
		expect((await h.call('DELETE', `/v1/reviews/${review.json.id}`)).status).toBe(404);
		expect((await h.call('GET', `/v1/reviews/${review.json.id}`, { as: '' })).status).toBe(404);
	});
});

describe('reads, display and structured data', () => {
	it('lists with sorting, filters and keyset pagination; sk_ sees every status', async () => {
		await h.entitle({
			config: {
				collection: { who: 'identified' },
				moderation: { auto_approve_unverified: true, rules: [], default_action: 'approve' },
			},
		});
		for (const [index, rating] of [5, 3, 4, 1, 2].entries()) {
			h.clock.advance(60_000);
			const r = await h.call('POST', '/v1/reviews', {
				as: `cus_list_${index}`,
				body: { itemId: 'itm_list', rating, body: `${text} #${index}` },
			});
			expect(r.json.status).toBe('approved');
		}
		const high = await h.call('GET', '/v1/reviews?filter[itemId]=itm_list&sort=rating_high&limit=2', { as: '' });
		expect(high.json.items.map((/** @type {any} */ r) => r.rating)).toEqual([5, 4]);
		expect(high.headers.get('link')).toContain('rel="next"');
		const next = await h.call(
			'GET',
			`/v1/reviews?filter[itemId]=itm_list&sort=rating_high&limit=2&cursor=${encodeURIComponent(high.json.nextCursor)}`,
			{ as: '' },
		);
		expect(next.status, JSON.stringify(next.json)).toBe(200);
		expect(next.json.items.map((/** @type {any} */ r) => r.rating)).toEqual([3, 2]);
		const mismatch = await h.call(
			'GET',
			`/v1/reviews?filter[itemId]=itm_list&sort=newest&cursor=${encodeURIComponent(high.json.nextCursor)}`,
			{ as: '' },
		);
		expect(mismatch.status).toBe(400);
		const oldest = await h.call('GET', '/v1/reviews?filter[itemId]=itm_list&sort=oldest', { as: '' });
		expect(oldest.json.items[0].rating).toBe(5);
		const fours = await h.call(
			'GET',
			'/v1/reviews?filter[itemId]=itm_list&filter[rating]=4&filter[verified]=false&filter[photos]=false',
			{ as: '' },
		);
		expect(fours.json.items).toHaveLength(1);
		expect((await h.call('GET', '/v1/reviews?filter[rating]=x', { as: '' })).status).toBe(422);
		expect((await h.call('GET', '/v1/reviews?filter[itemId]=bad%20id', { as: '' })).status).toBe(422);
		const all = await h.call('GET', '/v1/reviews?filter[status]=pending,rejected');
		expect(all.status).toBe(200);
		expect(all.json.items.every((/** @type {any} */ r) => r.status !== 'approved')).toBe(true);
		expect((await h.call('GET', '/v1/reviews?filter[status]=bogus')).status).toBe(422);
		expect((await h.call('GET', '/v1/reviews?filter[customerId]=cus_list_0')).json.items).toHaveLength(1);
		const summary = await h.call('GET', '/v1/ratings/itm_list', { as: '' });
		expect(summary.json).toMatchObject({ count: 5, average: 3, display: { showSummary: true, pageSize: 10 } });
		expect(summary.json.distribution.map((/** @type {any} */ row) => row.count)).toEqual([1, 1, 1, 1, 1]);
		const stars = await h.call('GET', '/v1/ratings?itemIds=itm_list,itm_unknown', { as: '' });
		expect(stars.json.items).toEqual([
			{ itemId: 'itm_list', count: 5, average: 3, scale: 5 },
			{ itemId: 'itm_unknown', count: 0, average: 0, scale: 5 },
		]);
		expect((await h.call('GET', '/v1/ratings?itemIds=', { as: '' })).status).toBe(422);
		const rated = await h.call('GET', '/v1/ratings?limit=1', { as: '' });
		expect(rated.json.items).toHaveLength(1);
		expect(rated.json.hasMore).toBe(true);
		expect((await h.call('GET', '/v1/ratings/bad%20id', { as: '' })).status).toBe(422);
		const view = await h.call('GET', '/v1/elements/display/view?itemId=itm_list', { as: '' });
		expect(view.json.title).toBe('3 / 5 · 5 reviews');
		expect(view.json.items[0].text).toMatch(/^★★☆☆☆/);
		expect((await h.call('GET', '/v1/elements/display/view?itemId=itm_none', { as: '' })).json).toMatchObject({
			title: 'Reviews',
			body: 'No reviews yet.',
		});
		await h.entitle({ elements: { display: false } });
		expect((await h.call('GET', '/v1/reviews', { as: '' })).status).toBe(403);
		expect((await h.call('GET', '/v1/reviews')).status).toBe(200);
		await h.entitle();
	});

	it('serves Product JSON-LD from approved reviews only', async () => {
		const jsonLd = await h.call('GET', '/v1/structured-data/itm_list?name=List&url=https://shop.example.com/p/list&sku=L-1', {
			as: '',
		});
		expect(jsonLd.status).toBe(200);
		expect(jsonLd.headers.get('content-type')).toBe('application/ld+json');
		expect(jsonLd.headers.get('cache-control')).toBe('public, max-age=300');
		expect(jsonLd.json).toMatchObject({
			'@context': 'https://schema.org',
			'@type': 'Product',
			name: 'List',
			sku: 'L-1',
			'@id': 'https://shop.example.com/p/list#product',
			aggregateRating: { ratingValue: 3, reviewCount: 5, bestRating: 5, worstRating: 1 },
		});
		expect(jsonLd.json.review).toHaveLength(5);
		// no stored title and no ?name= → a problem; with a name it works; no approved reviews → no rating nodes
		const unnamed = await h.call('GET', '/v1/structured-data/itm_unrated', { as: '' });
		expect(unnamed.status).toBe(422);
		const named = await h.call('GET', '/v1/structured-data/itm_unrated?name=Thing', { as: '' });
		expect(named.json).toEqual({ '@context': 'https://schema.org', '@type': 'Product', name: 'Thing', sku: 'itm_unrated' });
		expect((await h.call('GET', '/v1/structured-data/itm_list?url=http://insecure', { as: '' })).status).toBe(422);
		expect((await h.call('GET', '/v1/structured-data/bad%20id', { as: '' })).status).toBe(422);
		await h.entitle({ config: { structured_data: { min_reviews: 10, brand: 'Acme' } } });
		const few = await h.call('GET', '/v1/structured-data/itm_a', { as: '' });
		expect(few.json).not.toHaveProperty('aggregateRating');
		expect(few.json.brand).toEqual({ '@type': 'Brand', name: 'Acme' });
		expect(few.json.name).toBe('Item itm_a');
		await h.entitle({ config: { structured_data: { review_selection: 'most_detailed', include_reviews: 2 } } });
		expect((await h.call('GET', '/v1/structured-data/itm_list?name=List', { as: '' })).json.review).toHaveLength(2);
		await h.entitle();
	});

	it('serves the review form definition and validates submissions against it', async () => {
		await h.entitle({
			config: {
				content: {
					rating_scale: 10,
					title_required: true,
					attributes: [
						{ key: 'fit', label: 'Fit', min: -2, max: 2, low_label: 'Small', high_label: 'Large', required: true },
					],
				},
			},
		});
		const form = await h.call('GET', '/v1/review-form', { as: '' });
		expect(form.json).toMatchObject({
			ratingScale: 10,
			title: { required: true },
			attributes: [{ key: 'fit', lowLabel: 'Small', required: true }],
		});
		const bad = await h.call('POST', '/v1/reviews', {
			body: { itemId: 'itm_f', rating: 11, body: 'short', attributes: { fit: 3, size: 1 }, photoIds: ['x'] },
		});
		expect(bad.status).toBe(422);
		const paths = bad.json.errors.map((/** @type {any} */ e) => `${e.path}:${e.code}`);
		expect(paths).toEqual(
			expect.arrayContaining([
				'/rating:rating_invalid',
				'/body:too_short',
				'/attributes/fit:attribute_invalid',
				'/attributes/size:unknown_attribute',
				'/title:required',
			]),
		);
		const good = await h.call('POST', '/v1/reviews', {
			body: { itemId: 'itm_f', rating: 9, title: 'Fits', body: text, attributes: { fit: 0 } },
		});
		expect(good.status).toBe(201);
		expect(good.json).toMatchObject({ scale: 10, attributes: { fit: 0 } });
		await h.call('POST', `/v1/moderation/${good.json.id}/approve`);
		const summary = await h.call('GET', '/v1/ratings/itm_f', { as: '' });
		expect(summary.json.attributes).toEqual([expect.objectContaining({ key: 'fit', average: 0, count: 1 })]);
		await h.entitle();
		// the scale changed back to 5: a 9/10 shows as 4.5/5
		expect((await h.call('GET', '/v1/ratings/itm_f', { as: '' })).json.average).toBe(4.5);
	});

	it('replays a submission with the same Idempotency-Key', async () => {
		const body = { itemId: 'itm_idem', rating: 4, body: text, author: { name: 'Same Key' } };
		const first = await h.call('POST', '/v1/reviews', { body, idempotencyKey: 'idem-review-1' });
		const second = await h.call('POST', '/v1/reviews', { body, idempotencyKey: 'idem-review-1' });
		expect(second.status).toBe(first.status);
		expect(second.json.id).toBe(first.json.id);
		expect(await h.collection('reviews').countDocuments({ websiteId: WEBSITE, itemId: 'itm_idem' })).toBe(1);
	});
});
