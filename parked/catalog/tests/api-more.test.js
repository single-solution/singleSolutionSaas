/** Mode C media, uploads, import/export, feeds, element views, stats, dashboard routes and outbox leftovers republished on read. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MERCHANT, WEBSITE, createHarness } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
/** @type {Record<string, any>} */
let shirt;

beforeAll(async () => {
	h = await createHarness({
		config: {
			media: { url_template: '{url}?w={width}', ladder: [640, 320], allowed_hosts: ['cdn.example.com'] },
			feeds: {
				feeds: [
					{ key: 'shopping', name: 'Shopping', format: 'google_xml', mapping: [] },
					{
						key: 'csv',
						name: 'CSV',
						format: 'csv',
						include_out_of_stock: false,
						mapping: [
							{ target: 'id', source: 'id' },
							{ target: 'label', source: '{title} ({brand})' },
							{ target: 'channel', source: '=web' },
							{ target: 'grade', source: 'attr.grade' },
							{ target: 'bad', source: 'cost' },
						],
					},
					{ key: 'tsv', name: 'TSV', format: 'tsv' },
					{ key: 'json', name: 'JSON', format: 'json' },
				],
				condition_source: 'attr.grade',
				condition_map: [{ from: 'b', to: 'used' }],
			},
		},
	});
	await h.call('POST', '/v1/attributes', { body: { key: 'grade', label: 'Grade', options: ['A', 'B'] } });
	await h.call('POST', '/v1/attributes', { body: { key: 'size', label: 'Size', options: ['S', 'M'], variantOption: true } });
	const brand = await h.call('POST', '/v1/brands', { body: { name: 'Acme' } });
	const collection = await h.call('POST', '/v1/collections', { body: { title: 'Phones' } });
	const created = await h.call('POST', '/v1/items', {
		body: {
			title: 'Phone X',
			status: 'active',
			brandId: brand.json.id,
			collectionIds: [collection.json.id],
			attributes: { grade: 'b' },
			options: ['size'],
			variants: [
				{
					sku: 'PX-S',
					barcode: '4006381333931',
					options: { size: 's' },
					price: 19900,
					compareAtPrice: 24900,
					cost: 12000,
					quantity: 3,
				},
				{ sku: 'PX-M', options: { size: 'm' }, price: 20900, quantity: 0 },
			],
			media: [{ url: 'https://cdn.example.com/x.jpg', width: 800, height: 800 }],
		},
	});
	expect(created.status, JSON.stringify(created.json)).toBe(201);
	shirt = created.json;
}, 60_000);

afterAll(async () => {
	await h?.close();
});

describe('media', () => {
	it('attaches media by URL with srcset and alt templates, reorders, patches and detaches', async () => {
		expect(shirt.media[0]).toMatchObject({
			url: 'https://cdn.example.com/x.jpg',
			srcset: 'https://cdn.example.com/x.jpg?w=320 320w, https://cdn.example.com/x.jpg?w=640 640w',
			alt: 'Phone X',
		});
		const foreign = await h.call('POST', '/v1/media', { body: { itemId: shirt.id, url: 'https://evil.example.net/x.jpg' } });
		expect(foreign.json.errors[0].code).toBe('url_invalid');
		const added = await h.call('POST', '/v1/media', {
			body: { itemId: shirt.id, url: 'https://cdn.example.com/y.jpg', alt: 'Back', variantIds: [shirt.variants[0].id] },
		});
		expect(added.status, JSON.stringify(added.json)).toBe(201);
		expect(added.json).toMatchObject({ alt: 'Back', position: 1 });
		expect(
			(
				await h.call('POST', '/v1/media', {
					body: { itemId: shirt.id, url: 'https://cdn.example.com/z.jpg', variantIds: ['var_nope'] },
				})
			).json.errors[0].code,
		).toBe('variant_unknown');
		const list = await h.call('GET', `/v1/media?filter[itemId]=${shirt.id}`, { key: h.pk });
		expect(list.json.items.map((/** @type {any} */ m) => m.alt)).toEqual(['Phone X', 'Back']);
		const all = await h.call('GET', '/v1/media', { key: h.pk });
		expect(all.json.items.length).toBe(2);
		expect((await h.call('GET', '/v1/media?filter[itemId]=itm_nope')).json.items).toEqual([]);
		const order = await h.call('POST', '/v1/media:reorder', {
			body: { itemId: shirt.id, ids: [added.json.id, shirt.media[0].id] },
		});
		expect(order.json.items.map((/** @type {any} */ m) => m.id)).toEqual([added.json.id, shirt.media[0].id]);
		expect(
			(await h.call('POST', '/v1/media:reorder', { body: { itemId: shirt.id, ids: [added.json.id] } })).json.errors[0].code,
		).toBe('ids_mismatch');
		const patched = await h.call('PATCH', `/v1/media/${added.json.id}`, { body: { alt: 'Back side' } });
		expect(patched.json.alt).toBe('Back side');
		expect((await h.call('PATCH', '/v1/media/med_nope', { body: { alt: 'x' } })).status).toBe(404);
		expect(
			(await h.call('PATCH', `/v1/media/${added.json.id}`, { body: { variantIds: ['var_nope'] } })).json.errors[0].code,
		).toBe('variant_unknown');
		expect((await h.call('DELETE', `/v1/media/${added.json.id}`)).json.deleted).toBe(true);
		const item = await h.call('GET', `/v1/items/${shirt.id}`);
		expect(item.json.media).toHaveLength(1);
		expect(item.json.variants[0].mediaIds).toEqual([]);
		await h.entitle({ config: { media: { max_media_per_item: 1, allowed_hosts: ['cdn.example.com'] } } });
		expect(
			(await h.call('POST', '/v1/media', { body: { itemId: shirt.id, url: 'https://cdn.example.com/w.jpg' } })).json.type,
		).toMatch(/limit_reached$/);
		await h.entitle();
	});

	it('presigns uploads to the merchant bucket, checks keys exist and signs view links', async () => {
		const upload = await h.call('POST', '/v1/media-uploads', {
			body: { contentType: 'image/png', contentLength: 2048, itemId: shirt.id },
		});
		expect(upload.status, JSON.stringify(upload.json)).toBe(201);
		expect(upload.json).toMatchObject({
			method: 'PUT',
			key: expect.stringMatching(new RegExp(`^catalog/${shirt.id}/upl_.+\\.png$`)),
		});
		expect(upload.json.url).toContain('s3.example.com');
		expect(
			(await h.call('POST', '/v1/media-uploads', { body: { contentType: 'text/html', contentLength: 1 } })).json.errors[0]
				.code,
		).toBe('type_not_allowed');
		const missing = await h.call('POST', '/v1/media', { body: { itemId: shirt.id, key: upload.json.key } });
		expect(missing.json.type).toMatch(/media_missing$/);
		const storage = await h.catalog.product.connectors.storage(WEBSITE);
		h.providers.upload(storage.fullKey(upload.json.key), 2048, 'image/png');
		const attached = await h.call('POST', '/v1/media', { body: { itemId: shirt.id, key: upload.json.key } });
		expect(attached.status, JSON.stringify(attached.json)).toBe(201);
		const view = await h.call('GET', `/v1/items/${shirt.id}`, { key: h.pk });
		const keyed = view.json.media.find((/** @type {any} */ m) => m.id === attached.json.id);
		expect(keyed.url).toContain('X-Amz-Signature');
		expect(view.headers.get('cache-control')).toBe('no-store');
		await h.entitle({ config: { media: { storage_base_url: 'https://media.example.com' } } });
		const based = await h.call('GET', `/v1/media?filter[itemId]=${shirt.id}`, { key: h.pk });
		expect(based.json.items.find((/** @type {any} */ m) => m.id === attached.json.id).url).toBe(
			`https://media.example.com/${upload.json.key}`,
		);
		// storage is optional for media (F.18): without it media stays on, uploads answer 409 and keys are not checked
		await h.entitle({ storage: false });
		const refused = await h.call('POST', '/v1/media-uploads', { body: { contentType: 'image/png', contentLength: 1 } });
		expect(refused.status).toBe(409);
		expect(String(refused.json.type)).toMatch(/storage_not_connected$/);
		expect((await h.call('GET', `/v1/media?filter[itemId]=${shirt.id}`, { key: h.pk })).status).toBe(200);
		await h.entitle({ elements: { media: false } });
		expect((await h.call('POST', '/v1/media-uploads', { body: { contentType: 'image/png', contentLength: 1 } })).status).toBe(
			403,
		);
		await h.entitle();
		await h.call('DELETE', `/v1/media/${attached.json.id}`);
	});
});

describe('import and export', () => {
	it('exports CSV with major-unit prices (cost only when allowed) and a template', async () => {
		const csv = await h.call('GET', '/v1/exports');
		expect(csv.status).toBe(200);
		expect(csv.headers.get('content-type')).toContain('text/csv');
		const [header, first] = csv.text.split('\r\n');
		expect(header).toContain('cost');
		expect(first).toContain('199.00');
		expect(first).toContain('120.00');
		expect(first).toContain('size=s');
		expect((await h.call('GET', '/v1/exports', { key: h.pk })).status).toBe(403);
		await h.entitle({ config: { api: { expose_cost: false } } });
		expect((await h.call('GET', '/v1/exports')).text.split('\r\n')[0]).not.toContain('cost');
		await h.entitle();
		const template = await h.call('GET', '/v1/exports:template');
		expect(template.text.startsWith('item_slug,title')).toBe(true);
	});

	it('dry-runs a diff, applies with versions, creates items and reports conflicts by policy', async () => {
		const csv = [
			'item_slug,title,sku,price,quantity,options,image_urls,attr.grade,collections,brand,tags',
			`phone-x,,PX-S,189.00,5,,,a,phones,acme,refurb|deal`,
			'new-case,Case,CASE-1,9.99,10,,https://cdn.example.com/case.jpg,,,,',
			'broken,,BR-1,abc,1,,,,,,',
		].join('\r\n');
		const dry = await h.call('POST', '/v1/imports', { body: { csv } });
		expect(dry.status, JSON.stringify(dry.json)).toBe(200);
		expect(dry.json.dryRun).toBe(true);
		expect(dry.json.summary).toMatchObject({ items: 3, create: 1, update: 1, errors: 1 });
		const update = dry.json.items.find((/** @type {any} */ i) => i.slug === 'phone-x');
		expect(update.changes).toEqual(
			expect.arrayContaining([
				{ field: 'variant.price', from: 19900, to: 18900, variantId: shirt.variants[0].id },
				{ field: 'variant.quantity', from: 3, to: 5, variantId: shirt.variants[0].id },
				{ field: 'attributes.grade', from: 'b', to: 'a' },
			]),
		);
		expect(dry.json.items.find((/** @type {any} */ i) => i.slug === 'broken').errors[0].code).toBe('amount_invalid');
		await h.call('PATCH', `/v1/items/${shirt.id}`, { body: { summary: 'changed meanwhile' } });
		const skipped = await h.call('POST', '/v1/imports', { body: { csv, dryRun: false, expectedVersions: dry.json.versions } });
		expect(skipped.json.summary).toMatchObject({ applied: 1, conflict: 1, failed: 1 });
		const failing = await h.call('POST', '/v1/imports', {
			body: { csv, dryRun: false, conflictPolicy: 'fail', expectedVersions: dry.json.versions },
		});
		expect(failing.status).toBe(409);
		const forced = await h.call('POST', '/v1/imports', {
			body: { csv, dryRun: false, conflictPolicy: 'overwrite', expectedVersions: dry.json.versions },
		});
		expect(forced.json.summary).toMatchObject({ applied: 1, skipped: 1, failed: 1 });
		const item = await h.call('GET', `/v1/items/${shirt.id}`);
		expect(item.json.variants[0]).toMatchObject({ price: 18900, quantity: 5 });
		expect(item.json.attributes.grade).toBe('a');
		expect(item.json.tags).toEqual(['refurb', 'deal']);
		const created = await h.call('GET', '/v1/items/new-case');
		expect(created.json).toMatchObject({ title: 'Case', priceMin: 999 });
		expect(created.json.media[0].url).toBe('https://cdn.example.com/case.jpg');
		const audit = await h.db.collection('ss_catalog_audit').findOne({ websiteId: WEBSITE, action: 'catalog.imported' });
		expect(audit).toBeTruthy();
		const mapped = await h.call('POST', '/v1/imports', {
			body: { csv: 'Handle,Cost\r\nnew-case,1.00\r\n', mapping: { Handle: 'item_slug', Cost: 'cost' } },
		});
		expect(mapped.json.items[0].action).toBe('update');
		expect((await h.call('POST', '/v1/imports', { body: { csv: 'foo\r\nbar' } })).json.type).toMatch(/csv_invalid$/);
		expect((await h.call('POST', '/v1/imports', { body: { csv: '' } })).status).toBe(422);
		await h.entitle({ config: { import_export: { allow_create: false } } });
		const noCreate = await h.call('POST', '/v1/imports', {
			body: { csv: 'item_slug,title,price\r\nbrand-new,Brand new,1.00\r\n' },
		});
		expect(noCreate.json.items[0].errors[0].code).toBe('create_disabled');
		await h.entitle();
	});
});

describe('feeds', () => {
	it('lists feeds with tokened URLs and serves cacheable public feeds with ETags', async () => {
		const feeds = await h.call('GET', '/v1/feeds');
		expect(feeds.json.items.map((/** @type {any} */ f) => f.key)).toEqual(['shopping', 'csv', 'tsv', 'json']);
		expect(feeds.json.items[1].invalidSources).toEqual(['cost']);
		expect((await h.call('GET', '/v1/feeds', { key: h.pk })).status).toBe(403);
		const path = (/** @type {string} */ url) => new URL(url).pathname;
		const xml = await h.call('GET', path(feeds.json.items[0].url), { key: null });
		expect(xml.status).toBe(200);
		expect(xml.headers.get('content-type')).toContain('application/xml');
		expect(xml.headers.get('cache-control')).toMatch(/^public, max-age=3600/);
		expect(xml.text).toContain('<g:id>PX-S</g:id>');
		expect(xml.text).toContain('<g:condition>new</g:condition>');
		expect(xml.text).toContain('<g:brand>Acme</g:brand>');
		expect(xml.text).toContain('<g:gtin>4006381333931</g:gtin>');
		expect(xml.text).not.toContain('120.00');
		const etag = /** @type {string} */ (xml.headers.get('etag'));
		const notModified = await h.call('GET', path(feeds.json.items[0].url), { key: null, headers: { 'if-none-match': etag } });
		expect(notModified.status).toBe(304);
		const csv = await h.call('GET', path(feeds.json.items[1].url), { key: null });
		expect(csv.text.split('\r\n')[0]).toBe('id,label,channel,grade');
		expect(csv.text).toContain('web');
		expect(csv.text).not.toContain('PX-M');
		const tsv = await h.call('GET', path(feeds.json.items[2].url), { key: null });
		expect(tsv.text.split('\n')[0]?.split('\t')[0]).toBe('id');
		const json = await h.call('GET', path(feeds.json.items[3].url), { key: null });
		expect(JSON.parse(json.text).feed.key).toBe('json');
		const preview = await h.call('GET', '/v1/feeds/shopping/preview');
		expect(preview.text).toContain('<rss');
		expect((await h.call('GET', '/v1/feeds/nope/preview')).status).toBe(404);
		expect((await h.call('GET', '/feeds/fd1.bad.token', { key: null })).status).toBe(404);
		await h.entitle({ config: { feeds: { token_version: 2 } } });
		expect((await h.call('GET', path(feeds.json.items[0].url), { key: null })).status).toBe(404);
		await h.entitle({ elements: { feeds: false } });
		expect((await h.call('GET', path(feeds.json.items[0].url), { key: null })).status).toBe(404);
		await h.entitle();
	});
});

describe('stats, dashboard and outbox leftovers republished on read', () => {
	it('reports stats and runs the dashboard routes with the session (audited)', async () => {
		const stats = await h.call('GET', '/v1/catalog-stats');
		expect(stats.json.items).toMatchObject({
			total: expect.any(Number),
			byStatus: { active: expect.any(Number) },
			outOfStock: expect.any(Number),
		});
		expect((await h.call('GET', '/v1/catalog-stats', { key: h.pk })).status).toBe(403);
		const session = await h.session('merchant');
		expect((await h.call('GET', '/v1/dashboard/overview', { key: session })).json.currency).toBe('EUR');
		const stock = await h.call('POST', `/v1/dashboard/variants/${shirt.variants[0].id}/stock`, {
			key: session,
			body: { delta: 1 },
		});
		expect(stock.json.quantity).toBeGreaterThan(0);
		expect((await h.call('POST', '/v1/dashboard/variants/var_nope/stock', { key: session, body: { delta: 1 } })).status).toBe(
			404,
		);
		const status = await h.call('POST', `/v1/dashboard/items/${shirt.id}/status`, {
			key: session,
			body: { status: 'archived' },
			idempotencyKey: null,
		});
		expect(status.json.status).toBe('archived');
		expect(
			(
				await h.call('POST', `/v1/dashboard/items/${shirt.id}/status`, {
					key: session,
					body: { status: 'nope' },
					idempotencyKey: null,
				})
			).status,
		).toBe(422);
		const imported = await h.call('POST', '/v1/dashboard/imports', {
			key: session,
			body: { csv: 'item_slug,price\r\nnew-case,8.00\r\n' },
		});
		expect(imported.json.dryRun).toBe(true);
		expect((await h.call('POST', '/v1/dashboard/imports', { key: session, body: { csv: '' } })).status).toBe(422);
		const exported = await h.call('GET', '/v1/dashboard/exports', { key: session });
		expect(exported.text).toContain('new-case');

		// signed, short-lived download link: no session or website header on the download
		const link = await h.call('POST', '/v1/dashboard/exports:link', { key: session, body: { params: {} } });
		expect(link.status).toBe(201);
		expect(link.headers.get('cache-control')).toBe('no-store');
		expect(Date.parse(link.json.expiresAt) - h.clock.now()).toBeLessThanOrEqual(5 * 60_000);
		const url = new URL(link.json.url);
		expect(url.pathname).toMatch(/^\/v1\/dashboard\/exports\/ex1\./);
		const download = await h.call('GET', url.pathname, { key: null });
		expect(download.status).toBe(200);
		expect(download.headers.get('content-type')).toBe('text/csv; charset=utf-8');
		expect(download.headers.get('content-disposition')).toBe('attachment; filename="catalog.csv"');
		expect(download.headers.get('cache-control')).toBe('no-store');
		expect(download.text).toBe(exported.text);
		const filtered = await h.call('POST', '/v1/dashboard/exports:link', {
			key: session,
			body: { params: { 'filter[status]': 'nope' } },
		});
		expect((await h.call('GET', new URL(filtered.json.url).pathname, { key: null })).status).toBe(422);
		const token = url.pathname.split('/').at(-1) ?? '';
		const [prefix, payload, signature] = token.split('.');
		const forged = Buffer.from(
			JSON.stringify({ ...JSON.parse(Buffer.from(String(payload), 'base64url').toString()), w: 'web_other' }),
		).toString('base64url');
		for (const bad of [`${prefix}.${forged}.${signature}`, `${token}x`, 'ex1.e30.AAAA', 'nope'])
			expect((await h.call('GET', `/v1/dashboard/exports/${bad}`, { key: null })).status).toBe(401);
		expect(
			(await h.call('POST', '/v1/dashboard/exports:link', { key: session, body: { params: { $where: 'x' } } })).status,
		).toBe(422);
		expect((await h.call('POST', '/v1/dashboard/exports:link', { key: session, body: { params: 'x' } })).status).toBe(422);
		expect((await h.call('POST', '/v1/dashboard/exports:link', { key: null, body: {} })).status).toBe(401);
		await h.entitle({ elements: { import_export: false } });
		expect((await h.call('GET', url.pathname, { key: null })).status).toBe(403);
		await h.entitle();
		h.clock.advance(5 * 60_000 + 1);
		const expired = await h.call('GET', url.pathname, { key: null });
		expect(expired.status).toBe(401);
		expect(expired.json.detail).toBe('This download link has expired.');
		const audit = await h.db.collection('ss_catalog_audit').findOne({ websiteId: WEBSITE, action: 'stock.adjusted' });
		expect(audit?.actor).toMatchObject({ type: 'merchant', id: 'usr_merchant' });
		const unscoped = await h.session('merchant', { scope: { merchantId: MERCHANT } });
		expect((await h.call('GET', '/v1/dashboard/overview', { key: unscoped })).status).toBe(400);
		expect((await h.call('GET', '/v1/session', { key: session })).json).toMatchObject({ kind: 'merchant' });
	});

	it('republishes outbox entries a crashed request left behind when the item is read (same idempotency key)', async () => {
		await h.collection('items').updateOne(
			{ websiteId: WEBSITE, id: shirt.id },
			{
				$push: { outbox: { type: 'item.updated@1', key: `item.updated:${shirt.id}:manual`, changed: ['title'] } },
				$set: { outboxAt: new Date(h.clock.now() - 120_000) },
			},
		);
		await h
			.collection('items')
			.updateOne(
				{ websiteId: WEBSITE, id: shirt.id },
				{ $push: { outbox: { type: 'inventory.changed@1', key: `inventory:bad`, data: { nope: true } } } },
			);
		const before = h.published('item.updated@1').length;
		// reading the item republishes its leftovers (no timer)
		expect((await h.call('GET', `/v1/items/${shirt.id}`)).status).toBe(200);
		expect(h.published('item.updated@1').length).toBe(before + 1);
		const stored = await h.collection('items').findOne({ websiteId: WEBSITE, id: shirt.id });
		expect(stored?.outbox).toEqual([]);
		expect(stored?.outboxAt).toBeUndefined();
	});
});
