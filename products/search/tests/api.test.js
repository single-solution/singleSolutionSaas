/** Mode C API through the real handler: documents, search, limits, suggestions, analytics, catalog events, views. */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DAY, WEBSITE, createHarness } from './harness.js';

const TYPES = [
	{
		key: 'item',
		label: 'Item',
		fields: [
			{ key: 'title', prefix: true, display: true },
			{ key: 'brand', prefix: true, display: true },
			{ key: 'skus', prefix: true },
			{ key: 'attributes' },
			{ key: 'supplier', private: true, display: true },
		],
	},
	{ key: 'page', label: 'Page', fields: [{ key: 'title', prefix: true, display: true }, { key: 'body' }] },
];

describe('documents and search', () => {
	/** @type {Awaited<ReturnType<typeof createHarness>>} */
	let h;
	beforeAll(async () => {
		h = await createHarness({
			config: { index: { document_types: TYPES, max_documents: 5, upserts_per_day: 50, search_rate_per_minute: 1000 } },
		});
	});
	afterAll(async () => h.close());

	it('creates, replaces, reads, lists and deletes documents (sk_ only)', async () => {
		const created = await h.call('POST', '/v1/documents', {
			body: { id: 'shirt', type: 'item', url: '/s', fields: { title: 'Linen shirt', supplier: 'Zebra', unknown: 1 } },
		});
		expect(created.status, created.text).toBe(201);
		expect(created.headers.get('location')).toBe('/v1/documents/shirt');
		expect(created.json).toMatchObject({
			id: 'shirt',
			source: 'api',
			ignoredFields: ['unknown'],
			fields: { supplier: 'Zebra' },
		});
		const replaced = await h.call('POST', '/v1/documents', {
			body: { id: 'shirt', type: 'item', url: '/s', fields: { title: 'Linen shirt', brand: 'Acme' } },
		});
		expect(replaced.status).toBe(200);
		const generated = await h.call('POST', '/v1/documents', { body: { type: 'page', fields: { title: 'Returns' } } });
		expect(generated.json.id).toMatch(/^doc_/);
		expect((await h.call('GET', '/v1/documents/shirt')).json).toMatchObject({
			id: 'shirt',
			status: 'active',
			fields: { brand: 'Acme' },
		});
		expect((await h.call('GET', '/v1/documents/nope')).status).toBe(404);
		expect((await h.call('GET', '/v1/documents/%20bad')).status).toBe(404);
		const page = await h.call('GET', '/v1/documents?limit=1');
		expect(page.json.items).toHaveLength(1);
		const next = await h.call('GET', `/v1/documents?limit=1&cursor=${encodeURIComponent(page.json.nextCursor)}`);
		expect(next.json.items[0].id).not.toBe(page.json.items[0].id);
		expect((await h.call('GET', '/v1/documents?type=page&source=api')).json.items).toHaveLength(1);
		expect((await h.call('GET', '/v1/documents', { key: h.pk })).status).toBe(403);
		expect((await h.call('DELETE', `/v1/documents/${generated.json.id}`)).status).toBe(204);
		expect((await h.call('DELETE', `/v1/documents/${generated.json.id}`)).status).toBe(404);
		const invalid = await h.call('POST', '/v1/documents', { body: { type: 'nope', price: -1 } });
		expect(invalid.status).toBe(422);
		expect(invalid.json.errors.map((/** @type {any} */ e) => e.code)).toEqual(['type_unknown', 'minor_units']);
		expect((await h.call('POST', '/v1/documents', { body: { type: 'page' }, idempotencyKey: null })).status).toBe(428);
	});

	it('keeps the vocabulary in step and searches with pk_ without private fields', async () => {
		const terms = await h.collection('terms').find({ websiteId: WEBSITE }).toArray();
		// a term no document uses any more leaves the vocabulary in the same write (no cleanup pass)
		expect(terms.find((/** @type {any} */ t) => t.term === 'zebra')).toBeUndefined();
		expect(terms.find((/** @type {any} */ t) => t.term === 'acme')).toMatchObject({ df: 1, pdf: 1 });
		const result = await h.call('GET', '/v1/search?q=linen&limit=5', { key: h.pk });
		expect(result.status).toBe(200);
		expect(result.headers.get('cache-control')).toBe('public, max-age=60');
		expect(result.json.items[0]).toMatchObject({
			id: 'shirt',
			title: 'Linen shirt',
			url: '/s',
			fields: { title: 'Linen shirt', brand: 'Acme' },
		});
		expect(result.text).not.toContain('supplier');
		expect((await h.call('GET', '/v1/search?q=lin', { key: h.pk })).json.items[0].id).toBe('shirt');
		expect((await h.call('GET', '/v1/search?q=linen')).headers.get('cache-control')).toBe('no-store');
		expect((await h.call('GET', '/v1/search?q=', { key: h.pk })).json).toMatchObject({ items: [], total: 0 });
		expect((await h.call('GET', '/v1/search', { key: h.pk })).json.items).toEqual([]);
		expect((await h.call('GET', '/v1/search?q=linen&types=page', { key: h.pk })).json.items).toEqual([]);
		const bad = await h.call('GET', '/v1/search?q=x&limit=0&types=nope&cursor=zz', { key: h.pk });
		expect(bad.json.errors.map((/** @type {any} */ e) => e.path)).toEqual(['/limit', '/types', '/cursor']);
		expect((await h.call('GET', `/v1/search?q=${'x'.repeat(500)}`)).status).toBe(422);
		expect(
			(await h.call('GET', '/v1/search?q=linen', { key: h.pk, headers: { origin: 'https://evil.example.com' } })).status,
		).toBe(403);
	});

	it('pages results with a cursor and explains scores', async () => {
		await h.index([
			{ id: 'p1', type: 'page', fields: { title: 'Linen care' } },
			{ id: 'p2', type: 'page', fields: { title: 'Linen history' } },
		]);
		const first = await h.call('GET', '/v1/search?q=linen&limit=2', { key: h.pk });
		expect(first.json).toMatchObject({ total: 3, hasMore: true });
		const second = await h.call('GET', `/v1/search?q=linen&limit=2&cursor=${first.json.nextCursor}`, { key: h.pk });
		expect(second.json.items).toHaveLength(1);
		expect(second.json.hasMore).toBe(false);
		const explain = await h.call('GET', '/v1/ranking:explain?q=linen');
		expect(typeof explain.json.items[0].score).toBe('number');
		expect((await h.call('GET', '/v1/ranking')).json).toMatchObject({ matchMode: 'all_then_any', maxEdits: 2 });
		expect((await h.call('GET', '/v1/ranking', { key: h.pk })).status).toBe(403);
	});

	it('enforces the document limit and the daily quota', async () => {
		await h.index([
			{ id: 'p3', type: 'page', fields: { title: 'x' } },
			{ id: 'p3b', type: 'page', fields: { title: 'x' } },
		]);
		const full = await h.call('POST', '/v1/documents', { body: { id: 'p4', type: 'page', fields: { title: 'y' } } });
		expect([full.status, full.json.type.endsWith('limit_reached')]).toEqual([409, true]);
		await h.entitle({ config: { index: { document_types: TYPES, max_documents: 100, upserts_per_day: 1 } } });
		const quota = await h.call('POST', '/v1/documents', { body: { id: 'p5', type: 'page', fields: { title: 'y' } } });
		expect(quota.status).toBe(429);
		h.clock.advance(DAY);
		expect((await h.call('POST', '/v1/documents', { body: { id: 'p5', type: 'page', fields: { title: 'y' } } })).status).toBe(
			201,
		);
		const batch = await h.call('POST', '/v1/documents:batch', { body: { documents: [{ type: 'page' }, { type: 'zzz' }] } });
		expect(batch.json.results.map((/** @type {any} */ r) => r.status)).toEqual(['failed', 'failed']);
		h.clock.advance(DAY);
		await h.entitle({ config: { index: { document_types: TYPES, max_documents: 100, upserts_per_day: 100 } } });
		const ok = await h.call('POST', '/v1/documents:batch', {
			body: {
				documents: [
					{ id: 'b1', type: 'page' },
					{ id: 'b1', type: 'page' },
				],
			},
		});
		expect(ok.json.results.map((/** @type {any} */ r) => r.status)).toEqual(['created', 'updated']);
		expect((await h.call('POST', '/v1/documents:batch', { body: { documents: [] } })).status).toBe(422);
	});

	it('refuses writes without the sources element or with api_upserts off', async () => {
		await h.entitle({ config: { index: { document_types: TYPES }, sources: { api_upserts: false } } });
		expect((await h.call('POST', '/v1/documents', { body: { type: 'page' } })).json.type).toMatch(/writes_disabled$/);
		expect((await h.call('DELETE', '/v1/documents/b1')).status).toBe(403);
		await h.entitle({ config: { index: { document_types: TYPES } }, elements: { sources: false } });
		expect((await h.call('POST', '/v1/documents:batch', { body: { documents: [{ type: 'page' }] } })).json.type).toMatch(
			/element_disabled$/,
		);
		await h.entitle({ config: { index: { document_types: TYPES } }, elements: { index: false } });
		expect((await h.call('GET', '/v1/search?q=x', { key: h.pk })).status).toBe(403);
		await h.entitle({ config: { index: { document_types: TYPES } } });
	});

	it('reports the index status (Atlas unavailable on this database)', async () => {
		const status = await h.call('GET', '/v1/index-status?refresh=true');
		expect(status.json).toMatchObject({ engine: { configured: 'auto', active: 'portable' }, documents: { limit: 10000 } });
		expect(['unavailable', 'failed']).toContain(status.json.engine.atlas.state);
		await h.entitle({ config: { index: { document_types: TYPES, engine: 'portable' } } });
		expect((await h.call('GET', '/v1/index-status')).json.engine.atlas.state).toBe('disabled');
	});
});

describe('rate limits, suggestions, analytics and clicks', () => {
	/** @type {Awaited<ReturnType<typeof createHarness>>} */
	let h;
	beforeAll(async () => {
		h = await createHarness({
			config: { index: { document_types: TYPES, search_rate_per_minute: 3 }, suggestions: { popular_min_count: 2 } },
		});
		await h.index([
			{ id: 'a', type: 'item', fields: { title: 'Red shoes' } },
			{ id: 'b', type: 'item', fields: { title: 'Red shirt', supplier: 'Secretco' } },
		]);
	});
	afterAll(async () => h.close());
	afterEach(() => h.clock.advance(61_000));

	it('limits browser searches per website and meters every query', async () => {
		const statuses = [];
		for (let i = 0; i < 4; i += 1) statuses.push((await h.call('GET', '/v1/search?q=red', { key: h.pk })).status);
		expect(statuses).toEqual([200, 200, 200, 429]);
		expect((await h.call('GET', '/v1/search?q=red')).status).toBe(200);
		const flushed = await h.search.product.usage.flush();
		expect(flushed.sent).toBeGreaterThanOrEqual(1);
		expect([...h.portal.usage.values()].map((/** @type {any} */ r) => r.unit)).toContain('query');
	});

	it('counts searches without personal data and reports them', async () => {
		for (const q of ['red', 'Red ', 'me@example.com', 'blue']) await h.call('GET', `/v1/search?q=${encodeURIComponent(q)}`);
		await h.call('GET', '/v1/search?q=red&track=0');
		const rows = await h.collection('queries').find({ websiteId: WEBSITE }).toArray();
		expect(rows.map((/** @type {any} */ r) => r.q).sort()).toEqual(['blue', 'red']);
		expect(JSON.stringify(rows)).not.toMatch(/example\.com|ip|visitor/);
		expect(rows.find((/** @type {any} */ r) => r.q === 'blue')).toMatchObject({ zero: 1, searches: 1 });
		const clicked = await h.call('POST', '/v1/search-clicks', { key: h.pk, body: { q: 'red', id: 'a' }, idempotencyKey: null });
		expect(clicked.json).toEqual({ counted: true });
		expect((await h.call('POST', '/v1/search-clicks', { key: h.pk, body: { q: 'a@b.co' } })).json).toEqual({ counted: false });
		expect((await h.call('POST', '/v1/search-clicks', { key: h.pk, body: { q: 1 } })).status).toBe(422);
		const report = await h.call('GET', '/v1/search-analytics?days=7');
		expect(report.json).toMatchObject({ days: 7, totals: { searches: 7, zero: 1, clicks: 1 }, zeroResults: [{ q: 'blue' }] });
		expect(report.json.top[0]).toMatchObject({ q: 'red', searches: 6, clicks: 1 });
		expect((await h.call('GET', '/v1/search-analytics?days=9999')).status).toBe(422);
		expect((await h.call('GET', '/v1/search-analytics', { key: h.pk })).status).toBe(403);
	});

	it('suggests popular queries, completions and recent documents (public vocabulary only)', async () => {
		await h.entitle({ config: { index: { document_types: TYPES }, suggestions: { popular_min_count: 2 } } });
		const empty = await h.call('GET', '/v1/suggestions', { key: h.pk });
		expect(empty.json.popular).toEqual([{ text: 'red' }]);
		expect(empty.json.recent.map((/** @type {any} */ r) => r.id).sort()).toEqual(['a', 'b']);
		const partial = await h.call('GET', '/v1/suggestions?q=red%20sh', { key: h.pk });
		expect(partial.json.completions).toEqual([{ text: 'red shirt' }, { text: 'red shoes' }]);
		expect((await h.call('GET', '/v1/suggestions?q=sec', { key: h.pk })).json.completions).toEqual([]);
		expect((await h.call('GET', '/v1/suggestions?types=nope', { key: h.pk })).status).toBe(422);
		await h.entitle({ config: { index: { document_types: TYPES } }, elements: { analytics: false } });
		expect((await h.call('GET', '/v1/suggestions', { key: h.pk })).json.popular).toEqual([]);
		expect((await h.call('GET', '/v1/search?q=red')).status).toBe(200);
		expect((await h.collection('queries').findOne({ q: 'red' }))?.searches).toBe(6);
	});
});

describe('catalog events, overlay views and dashboard routes', () => {
	/** @type {Awaited<ReturnType<typeof createHarness>>} */
	let h;
	beforeAll(async () => {
		h = await createHarness({
			config: { index: { document_types: TYPES }, sources: { catalog_url_template: '/items/{itemId}' } },
		});
	});
	afterAll(async () => h.close());

	it('indexes catalog items from item events and removes them again', async () => {
		const snapshot = {
			itemId: 'itm_1',
			title: 'Desk lamp',
			status: 'active',
			brand: 'Lumo',
			currency: 'EUR',
			variants: [{ variantId: 'v1', sku: 'LAMP-1', price: 4500, cost: 2000 }],
		};
		expect((await h.deliver('item.created@1', snapshot)).status).toBe(200);
		const doc = await h.collection('documents').findOne({ websiteId: WEBSITE, id: 'itm_1' });
		expect(doc).toMatchObject({ source: 'catalog', url: '/items/itm_1', price: 4500, merchantId: expect.any(String) });
		expect(JSON.stringify(doc)).not.toContain('2000');
		expect((await h.call('GET', '/v1/search?q=lamp-1', { key: h.pk })).json.items[0].id).toBe('itm_1');
		await h.deliver('item.updated@1', { ...snapshot, status: 'archived', changed: ['status'] });
		expect(await h.collection('documents').countDocuments({ id: 'itm_1' })).toBe(0);
		await h.deliver('item.created@1', snapshot);
		await h.deliver('item.deleted@1', { itemId: 'itm_1' });
		expect(await h.collection('documents').countDocuments({ id: 'itm_1' })).toBe(0);
		await h.deliver('item.deleted@1', { itemId: 'itm_1' });
		await h.deliver('item.created@1', { itemId: 'itm_2', title: 'x' }, { websiteId: 'web_unknown00000000000000000' });
		await h.entitle({ config: { index: { document_types: TYPES }, sources: { catalog_events: false } } });
		await h.deliver('item.created@1', snapshot);
		expect(await h.collection('documents').countDocuments({ id: 'itm_1' })).toBe(0);
		await h.entitle({ config: { index: { document_types: TYPES }, sources: { catalog_url_template: '/items/{itemId}' } } });
	});

	it('serves the overlay element views for the Loader stub', async () => {
		await h.index([{ id: 'lamp', type: 'item', url: '/lamp', fields: { title: 'Desk lamp' } }]);
		const view = await h.call('GET', '/v1/elements/overlay/view', { key: h.pk });
		expect(view.json).toMatchObject({ fields: [{ name: 'q', type: 'text' }], actions: [{ action: 'search' }] });
		const found = await h.call('POST', '/v1/elements/overlay/actions/search', { key: h.pk, body: { fields: { q: 'lamp' } } });
		expect(found.json.items).toEqual([{ text: 'Desk lamp', href: '/lamp' }]);
		const none = await h.call('POST', '/v1/elements/overlay/actions/search', { key: h.pk, body: { q: 'zzzz' } });
		expect(none.json.body).toBeTruthy();
		expect((await h.call('POST', '/v1/elements/overlay/actions/search', { key: h.pk, body: { q: 5 } })).status).toBe(200);
	});

	it('runs dashboard actions for merchants only, audited', async () => {
		const merchant = await h.session('merchant');
		const check = await h.call('POST', '/v1/dashboard/engine/check', { key: merchant });
		expect(check.status, check.text).toBe(200);
		expect(check.json.engine.configured).toBe('auto');
		expect((await h.call('POST', '/v1/dashboard/sources/nope/crawl', { key: merchant })).status).toBe(404);
		const demo = await h.session('demo');
		expect((await h.call('POST', '/v1/dashboard/engine/check', { key: demo })).status).toBe(403);
		expect((await h.call('GET', '/v1/session', { key: merchant })).json).toMatchObject({ kind: 'merchant' });
	});
});
