import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PHONE } from './helpers.js';
import { WEBSITE, WEBSITE_2, createHarness } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;

beforeAll(async () => {
	h = await createHarness({ website: { currency: 'USD', timeZone: 'Europe/Berlin', language: 'en' } });
}, 60_000);

afterAll(async () => {
	await h?.close();
});

/** @param {Record<string, unknown>} [extra] */
const createPhone = async (extra = {}) => {
	const result = await h.call('POST', '/v1/configurators', { body: { ...PHONE, ...extra } });
	expect(result.status, JSON.stringify(result.json)).toBe(201);
	return result.json;
};

describe('configurators (schema element)', () => {
	it('creates, reads, lists, updates, publishes and archives — all in the merchant database', async () => {
		const created = await createPhone({ key: 'phone-crud' });
		expect(created).toMatchObject({ key: 'phone-crud', name: 'Phone X', status: 'draft', version: 1, publishedAt: null });
		expect(created.id).toMatch(/^cfg_/);
		const stored = await h.collection('configurators').findOne({ websiteId: WEBSITE, id: created.id });
		expect(stored).toMatchObject({
			merchantId: 'mer_0123456789abcdefghjkmnpq',
			env: 'live',
			schemaVersion: 1,
			status: 'draft',
		});
		expect((await h.call('GET', `/v1/configurators/${created.id}`)).json).toMatchObject({
			id: created.id,
			schema: { groups: [{ key: 'storage' }, { key: 'color' }, { key: 'addons' }] },
		});
		expect((await h.call('GET', '/v1/configurators/phone-crud')).json.id).toBe(created.id);
		// browsers never see drafts
		expect((await h.call('GET', '/v1/configurators/phone-crud', { key: h.pk })).status).toBe(404);
		const conflict = await h.call('PATCH', `/v1/configurators/${created.id}`, { body: { version: 9, status: 'published' } });
		expect(conflict.status).toBe(409);
		const published = await h.call('PATCH', `/v1/configurators/${created.id}`, {
			body: { version: 1, status: 'published', name: 'Phone X Pro' },
		});
		expect(published.json).toMatchObject({ status: 'published', version: 2, name: 'Phone X Pro' });
		expect(published.json.publishedAt).toBeTruthy();
		const events = h.published('configurator.published@1').filter((event) => event.data.configuratorId === created.id);
		expect(events.map((event) => event.data)).toEqual([
			{ configuratorId: created.id, key: 'phone-crud', version: 2, groups: ['storage', 'color', 'addons'] },
		]);
		const pub = await h.call('GET', '/v1/configurators/phone-crud', { key: h.pk });
		expect(pub.status).toBe(200);
		expect(pub.json).toMatchObject({
			id: created.id,
			itemId: null,
			schema: {
				combinations: [
					{ id: 'v1', stock: 1 },
					{ id: 'v2', stock: 0 },
					{ id: 'v3', stock: 1 },
					{ id: 'v4', stock: 1 },
				],
			},
		});
		expect((await h.call('GET', `/v1/configurators/${created.id}?view=public`)).json.schema.source).toEqual({
			type: 'standalone',
		});
		const invalid = await h.call('PATCH', `/v1/configurators/${created.id}`, { body: { version: 2, groups: [] } });
		expect(invalid.status).toBe(422);
		expect(invalid.json.errors[0]).toEqual({ path: '/groups', code: 'required', message: 'at least one group' });
		expect((await h.call('PATCH', `/v1/configurators/${created.id}`, { body: { status: 'nope' } })).status).toBe(422);
		const archived = await h.call('DELETE', `/v1/configurators/${created.id}`);
		expect(archived.json).toMatchObject({ status: 'archived', version: 3 });
		expect((await h.call('DELETE', `/v1/configurators/${created.id}`)).json.version).toBe(3);
		expect((await h.call('PATCH', `/v1/configurators/${created.id}`, { body: { version: 3 } })).status).toBe(410);
		expect((await h.call('GET', `/v1/configurators/${created.id}?view=public`)).status).toBe(404);
		expect((await h.call('PATCH', '/v1/configurators/cfg_missing', { body: { version: 1 } })).status).toBe(404);
		expect((await h.call('DELETE', '/v1/configurators/cfg_missing')).status).toBe(404);
		expect((await h.call('GET', '/v1/configurators/cfg_missing')).status).toBe(404);
	});

	it('enforces unique keys, validation, limits and server keys', async () => {
		await createPhone({ key: 'unique-key' });
		const taken = await h.call('POST', '/v1/configurators', { body: { ...PHONE, key: 'unique-key' } });
		expect(taken.status).toBe(409);
		expect(taken.json.type).toMatch(/\/problems\/key_taken$/);
		const other = await createPhone({ key: 'other-key' });
		expect((await h.call('PATCH', `/v1/configurators/${other.id}`, { body: { version: 1, key: 'unique-key' } })).status).toBe(
			409,
		);
		const bad = await h.call('POST', '/v1/configurators', {
			body: { name: 'x', groups: [{ key: 'a', options: [{ key: '1' }] }], rules: [{ id: 'r', when: 'selection.a ==' }] },
		});
		expect(bad.status).toBe(422);
		expect(bad.json.errors[0]).toMatchObject({ path: '/rules/0/when', code: 'rule_invalid' });
		expect((await h.call('POST', '/v1/configurators', { body: { ...PHONE, status: 'live' } })).status).toBe(422);
		expect((await h.call('POST', '/v1/configurators', { body: PHONE, key: h.pk })).status).toBe(403);
		expect((await h.call('GET', '/v1/configurators', { key: h.pk })).status).toBe(403);
		const check = await h.call('POST', '/v1/configurators:check', { body: PHONE });
		expect(check.json).toEqual({
			valid: true,
			problems: [],
			summary: { groups: 3, options: 8, rules: 1, combinations: 4, priced: true },
		});
		expect((await h.call('POST', '/v1/configurators:check', { body: { name: 'x' } })).json.valid).toBe(false);
		expect((await h.call('POST', '/v1/configurators:check', { body: /** @type {any} */ ('x') })).status).toBe(422);
		await h.entitle({ config: { schema: { max_configurators: 1 } } });
		const limited = await h.call('POST', '/v1/configurators', { body: PHONE });
		expect(limited.status).toBe(409);
		expect(limited.json.type).toMatch(/\/problems\/limit_reached$/);
		await h.entitle({ config: { schema: { max_groups: 2 } } });
		expect((await h.call('POST', '/v1/configurators', { body: PHONE })).json.errors[0]).toMatchObject({
			path: '/groups',
			code: 'too_many',
		});
		await h.entitle();
	});

	it('pages through configurators and filters by status', async () => {
		const first = await h.call('GET', '/v1/configurators?limit=1');
		expect(first.json.items).toHaveLength(1);
		expect(first.json.hasMore).toBe(true);
		const second = await h.call('GET', `/v1/configurators?limit=1&cursor=${encodeURIComponent(first.json.nextCursor)}`);
		expect(second.json.items[0].id > first.json.items[0].id).toBe(true);
		const archived = await h.call('GET', '/v1/configurators?status=archived');
		expect(archived.json.items.every((/** @type {any} */ item) => item.status === 'archived')).toBe(true);
		expect(first.json.items[0]).toHaveProperty('groups');
	});

	it('answers 403 element_disabled when the schema element is off', async () => {
		await h.entitle({ elements: { schema: false } });
		const blocked = await h.call('GET', '/v1/configurators');
		expect(blocked.status).toBe(403);
		expect(blocked.json.type).toMatch(/element_disabled$/);
		await h.entitle();
	});
});

describe('evaluations, quotes, URL parameters and widgets', () => {
	/** @type {any} */
	let phone;
	beforeAll(async () => {
		phone = await createPhone({ key: 'phone-live', status: 'published' });
	});

	it('resolves, prices and builds the URL in one evaluation (browser key, metered)', async () => {
		const before = (await h.app.product.usage.stats()).pending;
		const result = await h.call('POST', '/v1/evaluations', {
			key: h.pk,
			idempotencyKey: null,
			body: { configurator: 'phone-live', selection: { color: 'pink' }, changed: 'color', search: '?utm=mail&storage=512' },
		});
		expect(result.status, JSON.stringify(result.json)).toBe(200);
		expect(result.json).toMatchObject({
			configurator: { id: phone.id, key: 'phone-live', version: 1 },
			selection: { storage: '256', color: 'pink' },
			exact: false,
			adjusted: [{ group: 'storage', from: '512', to: '256', reason: 'conflict' }],
			combination: { id: 'v3', sku: 'PX-256-PK', inStock: true },
			price: { currency: 'EUR', base: 60000, unit: 70000, total: 70000 },
			url: {
				search: '?utm=mail&storage=256&color=pink',
				canonical: '',
				params: [
					['storage', '256'],
					['color', 'pink'],
				],
				history: 'replace',
			},
			notify: null,
		});
		expect(result.json.states).toHaveLength(3);
		expect((await h.app.product.usage.stats()).pending).toBe(before + 1);
	});

	it('includes the notify-me hook for out-of-stock results and follows the resolver settings', async () => {
		const sold = await h.call('POST', '/v1/evaluations', {
			key: h.pk,
			body: { configurator: phone.id, selection: { storage: '256', color: 'black' } },
		});
		expect(sold.json).toMatchObject({
			inStock: false,
			notify: { configuratorId: phone.id, itemId: null, variantId: null, combinationId: 'v2', sku: 'PX-256-BK' },
		});
		await h.entitle({
			config: {
				resolver: { in_stock: 'require', notify_when_out_of_stock: false },
				api: { option_states: false },
				price_deltas: { show_breakdown: false },
			},
		});
		const required = await h.call('POST', '/v1/evaluations', {
			body: { configurator: phone.id, selection: { storage: '256', color: 'black' }, changed: 'storage', quantity: 3 },
		});
		expect(required.json).toMatchObject({
			selection: { storage: '256', color: 'pink' },
			inStock: true,
			states: [],
			notify: null,
			quantity: 3,
			price: { deltas: [], total: 210000 },
		});
		await h.entitle({ config: { resolver: { fallback: 'reject' } } });
		const rejected = await h.call('POST', '/v1/evaluations', {
			body: { configurator: phone.id, selection: { storage: '512', color: 'pink' } },
		});
		expect(rejected.status).toBe(422);
		expect(rejected.json).toMatchObject({ exhaustive: true, suggestion: { storage: '512', color: 'black' } });
		expect(rejected.json.type).toMatch(/\/problems\/selection_invalid$/);
		await h.entitle();
	});

	it('answers clear problems: unknown configurator, no valid combination, invalid bodies, drafts for browsers', async () => {
		expect((await h.call('POST', '/v1/evaluations', { body: { configurator: 'nope' } })).status).toBe(404);
		const draft = await createPhone({ key: 'phone-draft' });
		expect((await h.call('POST', '/v1/evaluations', { key: h.pk, body: { configurator: 'phone-draft' } })).status).toBe(404);
		expect((await h.call('POST', '/v1/evaluations', { body: { configurator: 'phone-draft' } })).status).toBe(200);
		const impossible = await h.call('POST', '/v1/configurators', {
			body: {
				name: 'Never',
				status: 'published',
				groups: [{ key: 'a', options: [{ key: '1' }] }],
				rules: [{ id: 'all', when: 'true' }],
			},
		});
		const none = await h.call('POST', '/v1/evaluations', { body: { configurator: impossible.json.id } });
		expect(none.status).toBe(422);
		expect(none.json).toMatchObject({ exhaustive: true, detail: 'No combination of the options satisfies the rules.' });
		expect(none.json.type).toMatch(/\/problems\/no_valid_combination$/);
		const invalid = await h.call('POST', '/v1/evaluations', { body: { configurator: 'phone-live', quantity: 0 } });
		expect(invalid.status).toBe(422);
		expect(invalid.json.errors[0]).toMatchObject({ path: '/quantity', code: 'range' });
		expect(draft.status).toBe('draft');
	});

	it('quotes a selection exactly as given', async () => {
		const quote = await h.call('POST', '/v1/quotes', {
			key: h.pk,
			body: { configurator: 'phone-live', selection: { storage: '128', color: 'black', addons: ['case'] }, quantity: 2 },
		});
		expect(quote.status, JSON.stringify(quote.json)).toBe(200);
		expect(quote.json).toMatchObject({
			combination: { id: 'v1' },
			inStock: true,
			quantity: 2,
			price: { unit: 51500, total: 103000 },
		});
		const invalid = await h.call('POST', '/v1/quotes', {
			body: { configurator: 'phone-live', selection: { storage: '512', color: 'pink' } },
		});
		expect(invalid.status).toBe(422);
		expect(invalid.json.violations).toContainEqual({ rule: 'no-pink-512', message: 'Pink stops at 256.', reason: 'excluded' });
		const incomplete = await h.call('POST', '/v1/quotes', {
			body: { configurator: 'phone-live', selection: { color: 'black' } },
		});
		expect(incomplete.json).toMatchObject({ status: 422, missing: ['storage'] });
		expect((await h.call('POST', '/v1/quotes', { body: { configurator: 'nope', selection: {} } })).status).toBe(404);
		expect((await h.call('POST', '/v1/quotes', { body: { configurator: 'phone-live' } })).status).toBe(422);
		await h.entitle({ elements: { price_deltas: false } });
		expect((await h.call('POST', '/v1/quotes', { body: { configurator: 'phone-live', selection: {} } })).status).toBe(403);
		const unpriced = await h.call('POST', '/v1/evaluations', { body: { configurator: 'phone-live' } });
		expect(unpriced.json.price).toBeNull();
		await h.entitle();
	});

	it('builds and parses URL parameters with the merchant’s names', async () => {
		await h.entitle({ config: { url_sync: { param_prefix: 'c_', param_names: ['storage=gb'], canonical: 'selection' } } });
		const built = await h.call('POST', '/v1/url-params:build', {
			key: h.pk,
			body: { configurator: 'phone-live', selection: { storage: '256', color: 'pink' }, search: '?ref=1' },
		});
		expect(built.json).toEqual({
			search: '?ref=1&c_gb=256&c_color=pink',
			canonical: '?c_gb=256&c_color=pink',
			params: [
				['c_gb', '256'],
				['c_color', 'pink'],
			],
			history: 'replace',
		});
		const parsed = await h.call('POST', '/v1/url-params:parse', {
			body: { configurator: 'phone-live', search: '?c_gb=512&c_addons=case' },
		});
		expect(parsed.json).toEqual({ selection: { storage: '512', addons: ['case'] } });
		const evaluated = await h.call('POST', '/v1/evaluations', { body: { configurator: 'phone-live', search: '?c_gb=512' } });
		expect(evaluated.json.selection).toEqual({ storage: '512', color: 'black' });
		expect((await h.call('POST', '/v1/url-params:parse', { body: { configurator: 'phone-live' } })).status).toBe(422);
		expect((await h.call('POST', '/v1/url-params:build', { body: { configurator: 'nope' } })).status).toBe(404);
		await h.entitle({ elements: { url_sync: false } });
		const noUrl = await h.call('POST', '/v1/evaluations', { body: { configurator: 'phone-live', search: '?storage=512' } });
		expect(noUrl.json).toMatchObject({ url: null, selection: { storage: '128' } });
		await h.entitle();
	});

	it('bootstraps the widget and serves the element stub view', async () => {
		const widget = await h.call('GET', `/v1/widgets/phone-live?search=${encodeURIComponent('?color=pink')}`, { key: h.pk });
		expect(widget.status, JSON.stringify(widget.json)).toBe(200);
		expect(widget.json).toMatchObject({
			configurator: { id: phone.id, name: 'Phone X' },
			settings: {
				layout: 'pills',
				showPrice: true,
				showSummary: true,
				showOutOfStock: true,
				showAdjustments: true,
				urlSync: true,
				history: 'replace',
				inStock: 'prefer',
			},
			evaluation: { selection: { storage: '256', color: 'pink' } },
			problem: null,
		});
		expect((await h.call('GET', '/v1/widgets/nope', { key: h.pk })).status).toBe(404);
		const stub = await h.call('GET', '/v1/elements/widget/view?configurator=phone-live', { key: h.pk });
		expect(stub.json).toEqual({
			title: 'Phone X',
			body: '3 groups of options to choose from.',
			items: [{ text: 'Storage: 128, 256, 512' }, { text: 'Colour: Black, Pink, Gold' }, { text: 'Add-ons: Case, Charger' }],
			actions: [],
		});
		const missing = await h.call('GET', '/v1/elements/widget/view?ctx=%7Bbad', { key: h.pk });
		expect(missing.json).toMatchObject({ title: 'Configure', body: 'This configurator is not available.' });
		expect((await h.call('GET', '/v1/elements/widget/view?lang=xx', { key: h.pk })).json.items).toEqual([]);
		await h.entitle({ elements: { widget: false } });
		expect((await h.call('GET', '/v1/widgets/phone-live', { key: h.pk })).status).toBe(403);
		await h.entitle();
	});

	it('rate-limits evaluations per website (shared with widget loads)', async () => {
		await h.entitle({ config: { api: { evaluations_per_minute: 2 } } });
		const statuses = [];
		for (let i = 0; i < 3; i += 1)
			statuses.push((await h.call('POST', '/v1/evaluations', { body: { configurator: 'phone-live' } })).status);
		expect(statuses).toContain(429);
		h.clock.advance(61_000);
		await h.entitle();
	});
});

describe('catalog link (item.* and inventory.changed@1 events)', () => {
	const ITEM = {
		itemId: 'itm_tee',
		title: 'Tee',
		status: 'active',
		currency: 'GBP',
		variants: [
			{ variantId: 'tee-s', sku: 'TEE-S', attributes: { size: 'S', colour: 'Red' }, price: 1500, inventory: 2 },
			{ variantId: 'tee-m', sku: 'TEE-M', attributes: { size: 'M', colour: 'Red' }, price: 1500, inventory: 0 },
			{ variantId: 'tee-l', sku: 'TEE-L', attributes: { size: 'L', colour: 'Blue' }, price: 1700 },
		],
	};

	it('stores items from trusted events and resolves linked configurators against current stock', async () => {
		expect((await h.deliver('item.created@1', ITEM)).status).toBe(200);
		// a browser-sourced event is ignored
		await h.deliver(
			'inventory.changed@1',
			{ itemId: 'itm_tee', variantId: 'tee-l', quantity: 0 },
			{ actor: { type: 'anonymous' } },
		);
		await h.deliver('inventory.changed@1', { itemId: 'itm_tee', variantId: 'tee-m', quantity: 5 });
		const item = await h.call('GET', '/v1/catalog-items/itm_tee');
		expect(item.json.variants.map((/** @type {any} */ variant) => [variant.variantId, variant.stock])).toEqual([
			['tee-s', 2],
			['tee-m', 5],
			['tee-l', null],
		]);
		expect((await h.call('GET', '/v1/catalog-items')).json.items.map((/** @type {any} */ entry) => entry.itemId)).toContain(
			'itm_tee',
		);
		expect((await h.call('GET', '/v1/catalog-items/nope')).status).toBe(404);
		const linked = await h.call('POST', '/v1/configurators', {
			body: {
				key: 'tee',
				name: 'Tee',
				status: 'published',
				source: { type: 'catalog', itemId: 'itm_tee' },
				groups: [{ key: 'colour', display: 'swatches' }, { key: 'size' }],
			},
		});
		expect(linked.status, JSON.stringify(linked.json)).toBe(201);
		expect(h.published('configurator.published@1').some((event) => event.data.itemId === 'itm_tee')).toBe(true);
		const result = await h.call('POST', '/v1/evaluations', {
			key: h.pk,
			body: { configurator: 'tee', selection: { size: 'M' }, changed: 'size' },
		});
		expect(result.json).toMatchObject({
			selection: { colour: 'Red', size: 'M' },
			combination: { id: 'tee-m', sku: 'TEE-M', inStock: true },
			price: { currency: 'GBP', unit: 1500 },
		});
		await h.deliver('inventory.changed@1', { itemId: 'itm_tee', variantId: 'tee-m', quantity: 0 });
		const sold = await h.call('POST', '/v1/evaluations', {
			key: h.pk,
			body: { configurator: 'tee', selection: { size: 'M' }, changed: 'size' },
		});
		expect(sold.json).toMatchObject({ inStock: false, notify: { itemId: 'itm_tee', variantId: 'tee-m', sku: 'TEE-M' } });
		const stub = await h.call(
			'GET',
			`/v1/elements/widget/view?ctx=${encodeURIComponent(JSON.stringify({ itemId: 'itm_tee' }))}`,
			{ key: h.pk },
		);
		expect(stub.json.title).toBe('Tee');
		await h.deliver('item.updated@1', { itemId: 'itm_tee', title: 'Tee 2', changed: ['title'] });
		expect((await h.call('GET', '/v1/catalog-items/itm_tee')).json.title).toBe('Tee 2');
		await h.deliver('item.deleted@1', { itemId: 'itm_tee', reason: 'discontinued' });
		const gone = await h.call('POST', '/v1/evaluations', { body: { configurator: 'tee' } });
		expect(gone.status).toBe(409);
		expect(gone.json.type).toMatch(/\/problems\/catalog_item_unavailable$/);
	});

	it('is idempotent and ignores websites without the catalog link', async () => {
		const event = await h.deliver('item.created@1', { ...ITEM, itemId: 'itm_dup' });
		h.clock.advance(1000);
		const again = await h.handle(
			new Request('https://configurator.example.com/.well-known/ss-events', {
				method: 'POST',
				...(await h.portal.signEvent(event.envelope)),
			}),
		);
		expect(again.status).toBe(200);
		await h.configurator.product.events.dispatch(event.envelope, { source: 'portal' });
		expect(await h.collection('items').countDocuments({ websiteId: WEBSITE, itemId: 'itm_dup' })).toBe(1);
		await h.entitle({ config: { schema: { catalog_link: false } } });
		await h.deliver('item.created@1', { ...ITEM, itemId: 'itm_off' });
		expect(await h.collection('items').countDocuments({ websiteId: WEBSITE, itemId: 'itm_off' })).toBe(0);
		const off = await h.call('POST', '/v1/configurators', {
			body: { name: 'x', source: { type: 'catalog', itemId: 'itm_dup' }, groups: [{ key: 'size' }] },
		});
		expect(off.json.errors[0]).toMatchObject({ path: '/source/type', code: 'disabled' });
		expect((await h.call('POST', '/v1/evaluations', { body: { configurator: 'tee' } })).json.type).toMatch(
			/catalog_link_disabled$/,
		);
		await h.entitle();
		// no subscription for the second website: ignored
		await h.deliver('item.created@1', { ...ITEM, itemId: 'itm_other' }, { websiteId: WEBSITE_2 });
		expect(await h.collection('items').countDocuments({ itemId: 'itm_other' })).toBe(0);
		await h.deliver('item.created@1', { title: 'no id' });
		await h.configurator.product.events.dispatch(
			{ ...event.envelope, id: 'evt_site_pk', data: { ...ITEM, itemId: 'itm_pk' } },
			{ source: 'site', website: { kind: 'pk' } },
		);
		expect(await h.collection('items').countDocuments({ itemId: 'itm_pk' })).toBe(0);
		const stale = await h.deliver(
			'inventory.changed@1',
			{ itemId: 'itm_dup', variantId: 'tee-s', quantity: 1 },
			{ occurredAt: Date.parse('2020-01-01T00:00:00Z') },
		);
		expect(stale.status).toBe(200);
		await h.deliver(
			'inventory.changed@1',
			{ itemId: 'itm_dup', variantId: 'tee-s', quantity: 1 },
			{ occurredAt: Date.parse('2020-01-01T00:00:00Z') },
		);
	});
});
