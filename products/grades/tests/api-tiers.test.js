/** Mode C: tiers, items, assignments, units, catalog events, filters, warranty, showcase and mapping. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WEBSITE, WEBSITE_2, createHarness } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;

beforeAll(async () => {
	h = await createHarness();
}, 60_000);

afterAll(async () => {
	await h?.close();
});

const item = (overrides = {}) => ({
	itemId: 'itm_phone',
	title: 'Phone X',
	status: 'active',
	brand: 'Acme',
	collections: ['phones'],
	attributes: { material: 'glass' },
	currency: 'EUR',
	variants: [
		{ variantId: 'var_a', sku: 'X-A', title: 'A', attributes: { tier: 'Excellent' }, price: 50000 },
		{ variantId: 'var_b', sku: 'X-B', title: 'B', attributes: { tier: 'good' }, price: 42000 },
		{ variantId: 'var_c', price: 39000 },
	],
	...overrides,
});

describe('tiers', () => {
	it('lists the default ladder for browsers (cacheable) and servers (with hidden tiers)', async () => {
		const browser = await h.call('GET', '/v1/tiers', { key: h.pk });
		expect(browser.status).toBe(200);
		expect(browser.headers.get('cache-control')).toBe('public, max-age=300');
		expect(browser.json.items.map((/** @type {any} */ tier) => tier.key)).toEqual(['new', 'excellent', 'good', 'fair']);
		expect(browser.json.items[0]).toMatchObject({
			label: 'New',
			rank: 0,
			badge: 'soft',
			color: { token: '--ss-color-success', css: 'var(--ss-color-success)', hex: null },
		});
		expect(browser.json.items[0].active).toBeUndefined();
		const server = await h.call('GET', '/v1/tiers');
		expect(server.headers.get('cache-control')).toBe('no-store');
		expect(server.json.items[0].active).toBe(true);
		expect((await h.call('GET', '/v1/tiers/good', { key: h.pk })).json.label).toBe('Good');
		expect((await h.call('GET', '/v1/tiers/nope', { key: h.pk })).status).toBe(404);
	});

	it('takes the merchant ladder from settings: colours, order, hidden tiers, default tier', async () => {
		await h.entitle({
			config: {
				tiers: {
					tiers: [
						{ key: 'class_ii', label: 'Class II', color: '#AA3300', order: 2 },
						{ key: 'extra', label: 'Extra', short_label: 'EX', token: '--ss-color-success', color: '#00ff00', order: 0 },
						{ key: 'class_i', label: 'Class I', order: 1, active: false },
						{ key: 'class_i', label: 'Duplicate' },
						{ key: 'Bad Key', label: 'x' },
					],
					default_tier: 'class_ii',
					badge_style: 'solid',
				},
			},
		});
		const tiers = await h.call('GET', '/v1/tiers', { key: h.pk });
		expect(tiers.json.items.map((/** @type {any} */ tier) => tier.key)).toEqual(['extra', 'class_ii']);
		expect(tiers.json.items[0]).toMatchObject({ shortLabel: 'EX', badge: 'solid', color: { css: 'var(--ss-color-success)' } });
		expect(tiers.json.items[1].color).toEqual({ hex: '#aa3300', token: null, css: '#aa3300' });
		expect(tiers.json.defaultTier).toBe('class_ii');
		expect((await h.call('GET', '/v1/tiers/class_i', { key: h.pk })).status).toBe(404);
		expect((await h.call('GET', '/v1/tiers/class_i')).status).toBe(200);
		const standalone = await h.call('GET', '/v1/items/sku-123', { key: h.pk });
		expect(standalone.json).toMatchObject({ itemId: 'sku-123', tier: { key: 'class_ii' }, variants: [] });
		await h.entitle();
	});

	it('assigns tiers to standalone external ids and variants; publishes changes; validates input', async () => {
		const created = await h.call('POST', '/v1/tier-assignments', {
			body: { itemId: 'ext:1001', tier: 'good', note: 'checked' },
		});
		expect(created.status).toBe(201);
		expect(created.headers.get('location')).toBe(`/v1/tier-assignments/${created.json.id}`);
		expect(created.json).toMatchObject({ itemId: 'ext:1001', variantId: null, tier: 'good', source: 'api', note: 'checked' });
		const again = await h.call('POST', '/v1/tier-assignments', { body: { itemId: 'ext:1001', tier: 'good' } });
		expect(again.status).toBe(200);
		const changed = await h.call('POST', '/v1/tier-assignments', { body: { itemId: 'ext:1001', tier: 'fair' } });
		expect(changed.json.tier).toBe('fair');
		const variant = await h.call('POST', '/v1/tier-assignments', {
			body: { itemId: 'ext:1001', variantId: 'v-2', tier: 'new' },
		});
		expect(variant.status).toBe(201);
		await h.grades.product.flush();
		const events = h.published('grades.tier_assigned@1').filter((event) => event.data.itemId === 'ext:1001');
		expect(events.map((event) => [event.data.tier, event.data.previousTier ?? null])).toEqual([
			['good', null],
			['fair', 'good'],
			['new', null],
		]);
		const view = await h.call('GET', '/v1/items/ext:1001', { key: h.pk });
		expect(view.json.tier.key).toBe('fair');
		expect(view.json.variants).toEqual([{ variantId: 'v-2', tier: expect.objectContaining({ key: 'new' }) }]);
		expect(view.json.tiers.map((/** @type {any} */ tier) => tier.key)).toEqual(['new', 'fair']);
		expect(
			(await h.call('POST', '/v1/tier-assignments', { body: { itemId: 'ext:1001', tier: 'mint' } })).json.errors[0].code,
		).toBe('tier_unknown');
		const bad = await h.call('POST', '/v1/tier-assignments', {
			body: { itemId: '', tier: 'X', extra: 1, note: 5, variantId: 7 },
		});
		expect(bad.status).toBe(422);
		expect(bad.json.errors.map((/** @type {any} */ e) => e.code).sort()).toEqual(
			['field_unknown', 'id_invalid', 'id_invalid', 'note_invalid', 'tier_invalid'].sort(),
		);
		expect((await h.call('POST', '/v1/tier-assignments', { body: [] })).status).toBe(422);
		expect((await h.call('POST', '/v1/tier-assignments', { body: { itemId: 'x', tier: 'good' }, key: h.pk })).status).toBe(403);
		const one = await h.call('GET', `/v1/tier-assignments/${created.json.id}`);
		expect(one.json.tier).toBe('fair');
		expect((await h.call('GET', '/v1/tier-assignments/gas_missing')).status).toBe(404);
	});

	it('pages assignments, filters them, batches and removes them', async () => {
		const batch = await h.call('POST', '/v1/tier-assignments:batch', {
			body: {
				assignments: [
					{ itemId: 'b-1', tier: 'new' },
					{ itemId: 'b-2', tier: 'good' },
					{ itemId: 'b-3', tier: 'nope' },
				],
			},
		});
		expect(batch.json.results.map((/** @type {any} */ r) => r.status)).toEqual(['created', 'created', 'failed']);
		expect(batch.json.results[2].code).toBe('tier_unknown');
		expect((await h.call('POST', '/v1/tier-assignments:batch', { body: { assignments: [] } })).status).toBe(422);
		expect((await h.call('POST', '/v1/tier-assignments:batch', { body: 'x' })).status).toBe(422);
		const first = await h.call('GET', '/v1/tier-assignments?limit=1');
		expect(first.json.items).toHaveLength(1);
		expect(first.json.hasMore).toBe(true);
		expect(first.headers.get('link')).toContain('rel="next"');
		const second = await h.call('GET', `/v1/tier-assignments?limit=1&cursor=${encodeURIComponent(first.json.nextCursor)}`);
		expect(second.json.items[0].id).not.toBe(first.json.items[0].id);
		const filtered = await h.call('GET', '/v1/tier-assignments?filter[tier]=good&filter[itemId]=b-2');
		expect(filtered.json.items.map((/** @type {any} */ r) => r.itemId)).toEqual(['b-2']);
		expect((await h.call('GET', '/v1/tier-assignments?filter[itemId]=%20')).status).toBe(422);
		expect((await h.call('GET', '/v1/tier-assignments?filter[tier]=BAD')).status).toBe(422);
		expect((await h.call('GET', '/v1/tier-assignments', { key: h.pk })).status).toBe(403);
		const id = batch.json.results[0].assignment.id;
		expect((await h.call('DELETE', `/v1/tier-assignments/${id}`)).status).toBe(204);
		expect((await h.call('DELETE', `/v1/tier-assignments/${id}`)).status).toBe(404);
		expect((await h.call('GET', '/v1/items/b-1', { key: h.pk })).json.tiers).toEqual([]);
		await h.grades.product.flush();
		expect(h.published('grades.tier_assigned@1').some((event) => event.data.itemId === 'b-1' && event.data.tier === null)).toBe(
			true,
		);
	});

	it('registers graded units with serials, limits and tiers; pages, patches and deletes them', async () => {
		const unit = await h.call('POST', '/v1/units', {
			body: { itemId: 'itm_unit', serial: 'SN-1', tier: 'excellent', note: 'boxed' },
			idempotencyKey: 'unit-1',
		});
		expect(unit.status).toBe(201);
		expect(unit.json).toMatchObject({ itemId: 'itm_unit', serial: 'SN-1', tier: 'excellent', available: true, report: null });
		const replay = await h.call('POST', '/v1/units', {
			body: { itemId: 'itm_unit', serial: 'SN-1', tier: 'excellent', note: 'boxed' },
			idempotencyKey: 'unit-1',
		});
		expect(replay.json.id).toBe(unit.json.id);
		// another caller reusing the key never sees or changes the first unit; the same caller naming another item is refused
		const other = await h.call('POST', '/v1/units', {
			body: { itemId: 'itm_unit_other', note: 'mine' },
			key: await h.key('sk'),
			idempotencyKey: 'unit-1',
		});
		expect(other.status).toBe(201);
		expect(other.json.id).not.toBe(unit.json.id);
		expect(other.json).toMatchObject({ itemId: 'itm_unit_other', note: 'mine' });
		const misused = await h.call('POST', '/v1/units', { body: { itemId: 'itm_unit_other' }, idempotencyKey: 'unit-1' });
		expect(misused.status).toBe(409);
		expect(misused.json.type).toMatch(/duplicate_request$/);
		expect((await h.call('GET', `/v1/units/${unit.json.id}`)).json).toMatchObject({ itemId: 'itm_unit', note: 'boxed' });
		await h.call('DELETE', `/v1/units/${other.json.id}`);
		const taken = await h.call('POST', '/v1/units', { body: { itemId: 'itm_unit', serial: 'SN-1' }, idempotencyKey: null });
		expect(taken.status).toBe(409);
		expect(taken.json.errors[0].code).toBe('serial_taken');
		expect((await h.call('POST', '/v1/units', { body: { itemId: 'itm_unit', tier: 'zzz' } })).status).toBe(422);
		expect((await h.call('POST', '/v1/units', { body: { itemId: 'itm unit' } })).status).toBe(422);
		h.clock.advance(1_000); // units page newest first by addedAt; ids are random, so keep the two apart in time
		const second = await h.call('POST', '/v1/units', { body: { itemId: 'itm_unit', tier: 'fair', available: false } });
		expect((await h.call('GET', '/v1/items/itm_unit', { key: h.pk })).json.tiers.map((/** @type {any} */ t) => t.key)).toEqual([
			'excellent',
		]);
		const page = await h.call('GET', '/v1/units?filter[itemId]=itm_unit&limit=1');
		expect(page.json.items[0].id).toBe(second.json.id);
		const next = await h.call(
			'GET',
			`/v1/units?filter[itemId]=itm_unit&limit=1&cursor=${encodeURIComponent(page.json.nextCursor)}`,
		);
		expect(next.json.items[0].id).toBe(unit.json.id);
		expect((await h.call('GET', '/v1/units?filter[tier]=fair')).json.items.map((/** @type {any} */ u) => u.id)).toEqual([
			second.json.id,
		]);
		expect((await h.call('GET', '/v1/units?filter[tier]=X')).status).toBe(422);
		expect((await h.call('GET', '/v1/units?filter[itemId]=a%20b')).status).toBe(422);
		const patched = await h.call('PATCH', `/v1/units/${second.json.id}`, {
			body: { available: true, tier: 'good', note: null },
		});
		expect(patched.json).toMatchObject({ available: true, tier: 'good' });
		expect((await h.call('GET', '/v1/items/itm_unit', { key: h.pk })).json.tiers.map((/** @type {any} */ t) => t.key)).toEqual([
			'excellent',
			'good',
		]);
		expect((await h.call('PATCH', `/v1/units/${second.json.id}`, { body: { serial: 'SN-1' } })).status).toBe(409);
		expect((await h.call('PATCH', `/v1/units/${second.json.id}`, { body: { tier: 'nope' } })).status).toBe(422);
		expect((await h.call('PATCH', `/v1/units/${second.json.id}`, { body: {} })).status).toBe(422);
		expect((await h.call('PATCH', '/v1/units/unt_missing', { body: { note: 'x' } })).status).toBe(404);
		expect((await h.call('GET', `/v1/units/${unit.json.id}`)).json.serial).toBe('SN-1');
		expect((await h.call('DELETE', `/v1/units/${unit.json.id}`)).status).toBe(204);
		expect((await h.call('DELETE', `/v1/units/${unit.json.id}`)).status).toBe(404);
		expect((await h.call('GET', `/v1/units/${unit.json.id}`)).status).toBe(404);
		// the serial is free again after the delete
		expect((await h.call('POST', '/v1/units', { body: { itemId: 'itm_unit', serial: 'SN-1' } })).status).toBe(201);
		await h.entitle({ config: { tiers: { max_units_per_item: 1 } } });
		const limited = await h.call('POST', '/v1/units', { body: { itemId: 'itm_unit' } });
		expect(limited.status).toBe(409);
		expect(limited.json.type).toContain('unit_limit');
		await h.entitle();
	});

	it('lists graded items for browsers and badges for many ids', async () => {
		const page = await h.call('GET', '/v1/items?limit=2', { key: h.pk });
		expect(page.status).toBe(200);
		expect(page.json.items.length).toBe(2);
		expect(page.json.items.every((/** @type {any} */ row) => row.tiers.length > 0)).toBe(true);
		const next = await h.call('GET', `/v1/items?limit=2&cursor=${encodeURIComponent(page.json.nextCursor)}`, { key: h.pk });
		expect(next.json.items[0].itemId > page.json.items[1].itemId).toBe(true);
		const batch = await h.call('GET', '/v1/items?ids=ext:1001,itm_unit,unknown', { key: h.pk });
		expect(batch.json.items.map((/** @type {any} */ row) => row.itemId)).toEqual(['ext:1001', 'itm_unit', 'unknown']);
		expect(batch.json.items[2]).toMatchObject({ tier: null, tiers: [] });
		expect((await h.call('GET', '/v1/items?ids=a%20b', { key: h.pk })).status).toBe(422);
		expect((await h.call('GET', '/v1/items/a%20b', { key: h.pk })).status).toBe(422);
	});
});

describe('catalog events', () => {
	it('stores item snapshots and assigns tiers named by the catalog attribute (idempotent, manual wins)', async () => {
		expect((await h.deliver('item.created@1', item())).status).toBe(200);
		const view = await h.call('GET', '/v1/items/itm_phone', { key: h.pk });
		expect(view.json.variants).toEqual([
			{ variantId: 'var_a', tier: expect.objectContaining({ key: 'excellent' }) },
			{ variantId: 'var_b', tier: expect.objectContaining({ key: 'good' }) },
		]);
		const stored = await h.collection('items').findOne({ websiteId: WEBSITE, itemId: 'itm_phone' });
		expect(stored).toMatchObject({ known: true, title: 'Phone X', collections: ['phones'], tiers: ['excellent', 'good'] });
		expect(stored?.variants[0]).toEqual({ variantId: 'var_a', sku: 'X-A', title: 'A', attributes: { tier: 'Excellent' } });
		const same = { ...item() };
		const id = 'evt_same_delivery';
		await h.deliver('item.updated@1', same, { id });
		await h.deliver('item.updated@1', same, { id });
		// a manual assignment is never overwritten by the catalog
		await h.call('POST', '/v1/tier-assignments', { body: { itemId: 'itm_phone', variantId: 'var_b', tier: 'fair' } });
		await h.deliver('item.updated@1', {
			itemId: 'itm_phone',
			changed: ['variants'],
			currency: 'EUR',
			variants: [
				{ variantId: 'var_a', attributes: { tier: 'new' }, price: 1 },
				{ variantId: 'var_b', attributes: { tier: 'excellent' }, price: 1 },
			],
		});
		const after = await h.call('GET', '/v1/items/itm_phone', { key: h.pk });
		expect(after.json.variants.map((/** @type {any} */ v) => [v.variantId, v.tier.key])).toEqual([
			['var_a', 'new'],
			['var_b', 'fair'],
		]);
		// variants that no longer name a tier lose their catalog assignment
		await h.deliver('item.updated@1', {
			itemId: 'itm_phone',
			changed: ['variants'],
			currency: 'EUR',
			variants: [{ variantId: 'var_b', attributes: {}, price: 1 }],
		});
		expect(
			(await h.call('GET', '/v1/items/itm_phone', { key: h.pk })).json.variants.map((/** @type {any} */ v) => v.variantId),
		).toEqual(['var_b']);
		// a title-only update keeps the tiers
		await h.deliver('item.updated@1', { itemId: 'itm_phone', title: 'Phone X2', changed: ['title'] });
		expect((await h.collection('items').findOne({ websiteId: WEBSITE, itemId: 'itm_phone' }))?.title).toBe('Phone X2');
		await h.grades.product.flush();
		expect(h.published('grades.tier_assigned@1').some((e) => e.data.source === 'catalog')).toBe(true);
	});

	it('checks applicability rules against catalog items and leaves deleted items out', async () => {
		await h.entitle({
			config: {
				tiers: {
					tiers: [
						{ key: 'new', label: 'New', order: 1 },
						{ key: 'refurb', label: 'Refurbished', order: 2, applies_when: "'phones' in item.collections" },
					],
					catalog_attribute: 'grade',
				},
			},
		});
		await h.deliver('item.created@1', {
			itemId: 'itm_shirt',
			title: 'Shirt',
			collections: ['fashion'],
			attributes: { grade: 'refurb' },
		});
		expect((await h.call('GET', '/v1/items/itm_shirt', { key: h.pk })).json.tier).toBeNull();
		const refused = await h.call('POST', '/v1/tier-assignments', { body: { itemId: 'itm_shirt', tier: 'refurb' } });
		expect(refused.status).toBe(422);
		expect(refused.json.type).toContain('tier_not_applicable');
		expect((await h.call('POST', '/v1/tier-assignments', { body: { itemId: 'itm_phone', tier: 'refurb' } })).status).toBe(201);
		expect((await h.call('POST', '/v1/tier-assignments', { body: { itemId: 'standalone-9', tier: 'refurb' } })).status).toBe(
			201,
		);
		await h.deliver('item.created@1', {
			itemId: 'itm_case',
			title: 'Case',
			collections: ['phones'],
			attributes: { grade: 'Refurbished' },
		});
		expect((await h.call('GET', '/v1/items/itm_case', { key: h.pk })).json.tier.key).toBe('refurb');
		await h.deliver('item.deleted@1', { itemId: 'itm_case', reason: 'discontinued' });
		const gone = await h.call('GET', '/v1/items/itm_case', { key: h.pk });
		expect(gone.json).toMatchObject({ tier: null, tiers: [], variants: [] });
		await h.deliver('item.deleted@1', { itemId: 'never_seen' });
		await h.entitle();
	});

	it('ignores events of websites without the tiers element', async () => {
		await h.entitle({ websiteId: WEBSITE_2, elements: { tiers: false } });
		expect((await h.deliver('item.created@1', item({ itemId: 'itm_other' }), { websiteId: WEBSITE_2 })).status).toBe(200);
		expect(await h.collection('items').findOne({ websiteId: WEBSITE_2, itemId: 'itm_other' })).toBeNull();
	});
});

describe('filters', () => {
	it('lists options with counts per collection, applies visibility rules, pages matching items and sorts', async () => {
		await h.deliver('item.created@1', item({ itemId: 'itm_f1', collections: ['phones'], variants: [] }));
		await h.call('POST', '/v1/tier-assignments', { body: { itemId: 'itm_f1', tier: 'new' } });
		const options = await h.call('GET', '/v1/tier-filters?collection=phones', { key: h.pk });
		expect(options.status).toBe(200);
		expect(options.headers.get('cache-control')).toBe('public, max-age=120');
		expect(options.json).toMatchObject({ param: 'tier', multiSelect: true, defaultSort: 'tier_order', collection: 'phones' });
		expect(options.json.options.find((/** @type {any} */ o) => o.key === 'new').count).toBeGreaterThanOrEqual(1);
		expect(options.json.options.every((/** @type {any} */ o) => o.count > 0)).toBe(true);
		const all = await h.call('GET', '/v1/tier-filters', { key: h.pk });
		expect(all.json.options.length).toBeGreaterThanOrEqual(options.json.options.length);
		expect((await h.call('GET', '/v1/tier-filters?collection=a%20b', { key: h.pk })).status).toBe(422);
		const items = await h.call('GET', '/v1/tier-filters/items?tier=new,fair&limit=1', { key: h.pk });
		expect(items.json.items, JSON.stringify(items.json)).toHaveLength(1);
		expect(items.json.items[0]).toEqual({ itemId: expect.any(String), tiers: expect.any(Array) });
		const next = await h.call(
			'GET',
			`/v1/tier-filters/items?tier=new,fair&limit=1&cursor=${encodeURIComponent(items.json.nextCursor)}`,
			{ key: h.pk },
		);
		expect(next.json.items[0].itemId > items.json.items[0].itemId).toBe(true);
		const inCollection = await h.call('GET', '/v1/tier-filters/items?tier=new&collection=phones', { key: h.pk });
		expect(inCollection.json.items.map((/** @type {any} */ r) => r.itemId)).toContain('itm_f1');
		expect((await h.call('GET', '/v1/tier-filters/items?tier=mint', { key: h.pk })).status).toBe(422);
		expect((await h.call('GET', '/v1/tier-filters/items', { key: h.pk })).status).toBe(422);
		expect((await h.call('GET', '/v1/tier-filters/items?tier=new&collection=%20', { key: h.pk })).status).toBe(422);
		const sorted = await h.call('POST', '/v1/tier-filters:sort', {
			key: h.pk,
			idempotencyKey: null,
			body: { itemIds: ['ext:1001', 'nothing', 'itm_f1'] },
		});
		expect(sorted.json).toEqual({ itemIds: ['ext:1001', 'itm_f1', 'nothing'], direction: 'tier_order' });
		const worst = await h.call('POST', '/v1/tier-filters:sort', {
			key: h.pk,
			idempotencyKey: null,
			body: { itemIds: ['itm_f1', 'ext:1001'], direction: 'tier_order_desc' },
		});
		expect(worst.json.itemIds).toEqual(['ext:1001', 'itm_f1']);
		expect(
			(
				await h.call('POST', '/v1/tier-filters:sort', {
					key: h.pk,
					idempotencyKey: null,
					body: { itemIds: [], direction: 'x' },
				})
			).status,
		).toBe(422);
		expect(
			(
				await h.call('POST', '/v1/tier-filters:sort', {
					key: h.pk,
					idempotencyKey: null,
					body: { itemIds: ['a'], direction: 'x' },
				})
			).status,
		).toBe(422);
		await h.entitle({
			config: { filters: { visible_when: 'tier.order < 2', hide_empty: false, show_counts: false, multi_select: false } },
		});
		const ruled = await h.call('GET', '/v1/tier-filters', { key: h.pk });
		expect(ruled.json.options.map((/** @type {any} */ o) => [o.key, o.count])).toEqual([['new', null]]);
		const single = await h.call('GET', '/v1/tier-filters/items?tier=fair,new', { key: h.pk });
		expect(single.status).toBe(200);
	});
});

describe('warranty, showcase, mapping', () => {
	it('writes warranty periods in words from settings, as JSON or printable text', async () => {
		await h.entitle({
			config: {
				warranty: {
					terms: [
						{ tier: 'new', days: 365, text: '{period} cover for {tier} ({days} days).', exclusions: ['Water damage'] },
						{ tier: 'excellent', days: 45 },
						{ tier: 'good', days: 1 },
					],
					default_days: 0,
				},
			},
		});
		const terms = await h.call('GET', '/v1/warranty', { key: h.pk });
		expect(terms.json.items.map((/** @type {any} */ t) => [t.tier, t.periodText])).toEqual([
			['new', '12 months 5 days'],
			['excellent', '1 month 15 days'],
			['good', '1 day'],
			['fair', 'No warranty'],
		]);
		expect(terms.json.items[0]).toMatchObject({
			text: '12 months 5 days cover for New (365 days).',
			exclusions: ['Water damage'],
		});
		expect(terms.json.items[3].text).toBe('Items graded Fair come without a warranty.');
		const text = await h.call('GET', '/v1/warranty?format=text', { key: h.pk });
		expect(text.headers.get('content-type')).toContain('text/plain');
		expect(text.text).toContain('Warranty terms');
		expect(text.text).toContain('  - Water damage');
		expect((await h.call('GET', '/v1/warranty?format=xml', { key: h.pk })).status).toBe(422);
		expect((await h.call('GET', '/v1/warranty/excellent', { key: h.pk })).json.days).toBe(45);
		expect((await h.call('GET', '/v1/warranty/zzz', { key: h.pk })).status).toBe(404);
		await h.entitle({
			config: { warranty: { default_days: 60, hide_without_cover: true, default_text: 'Covered: {period}.' } },
		});
		const all = await h.call('GET', '/v1/warranty?lang=en-GB', { key: h.pk });
		expect(all.json.items.map((/** @type {any} */ t) => t.text)).toEqual(Array(4).fill('Covered: 2 months.'));
		await h.entitle();
	});

	it('serves the showcase per tier and per item, with warranty and media from settings', async () => {
		await h.entitle({
			config: {
				showcase: {
					entries: [
						{
							tier: 'excellent',
							headline: 'Like new',
							body: 'Inspected in 40 steps.',
							bullets: ['Battery above 90%', ''],
							video_url: 'https://video.example.com/excellent',
							images: [{ url: 'https://cdn.example.com/a.jpg', alt: 'Front' }, { url: 'http://insecure' }],
						},
					],
					include_tiers_without_entry: true,
				},
				warranty: { terms: [{ tier: 'excellent', days: 90 }] },
			},
		});
		const showcase = await h.call('GET', '/v1/showcase', { key: h.pk });
		expect(showcase.json.layout).toBe('cards');
		const excellent = showcase.json.entries.find((/** @type {any} */ e) => e.tier.key === 'excellent');
		expect(excellent).toMatchObject({
			headline: 'Like new',
			bullets: ['Battery above 90%'],
			video: 'https://video.example.com/excellent',
			images: [{ url: 'https://cdn.example.com/a.jpg', alt: 'Front' }],
			warranty: { days: 90, periodText: '3 months' },
		});
		expect(showcase.json.entries.find((/** @type {any} */ e) => e.tier.key === 'new')).toMatchObject({
			headline: 'New',
			body: 'Unused and complete, in its original state.',
		});
		const one = await h.call('GET', '/v1/showcase?tier=excellent', { key: h.pk });
		expect(one.json.entries).toHaveLength(1);
		const forItem = await h.call('GET', '/v1/showcase?itemId=ext:1001', { key: h.pk });
		expect(forItem.json.entries.map((/** @type {any} */ e) => e.tier.key)).toEqual(['new', 'fair']);
		expect((await h.call('GET', '/v1/showcase?tier=BAD', { key: h.pk })).status).toBe(422);
		expect((await h.call('GET', '/v1/showcase?itemId=a%20b', { key: h.pk })).status).toBe(422);
		await h.entitle({
			config: { showcase: { show_warranty: false, include_tiers_without_entry: false } },
			elements: { warranty: false },
		});
		expect((await h.call('GET', '/v1/showcase', { key: h.pk })).json.entries).toEqual([]);
		await h.entitle();
	});

	it('maps tiers to vocabularies with fallbacks and problems; per item and as feed rows', async () => {
		const table = await h.call('GET', '/v1/condition-mappings', { key: h.pk });
		expect(table.json.items.map((/** @type {any} */ v) => v.key)).toEqual(['schema_org', 'shopping_feed']);
		expect(table.json.items[1].values).toEqual([
			{ tier: 'new', value: 'new', source: 'mapped' },
			{ tier: 'excellent', value: 'used', source: 'fallback' },
			{ tier: 'good', value: 'used', source: 'fallback' },
			{ tier: 'fair', value: 'used', source: 'fallback' },
		]);
		expect(table.json.problems).toBeUndefined();
		expect((await h.call('GET', '/v1/condition-mappings')).json.problems).toEqual([]);
		const conditions = await h.call('GET', '/v1/condition-mappings/items/ext:1001', { key: h.pk });
		expect(conditions.json.item).toMatchObject({
			tier: { key: 'fair' },
			values: { schema_org: 'https://schema.org/UsedCondition', shopping_feed: 'used' },
			offer: { itemCondition: 'https://schema.org/UsedCondition' },
		});
		expect(conditions.json.variants[0]).toMatchObject({
			variantId: 'v-2',
			offer: { itemCondition: 'https://schema.org/NewCondition' },
		});
		expect((await h.call('GET', '/v1/condition-mappings/items/a%20b', { key: h.pk })).status).toBe(422);
		const feed = await h.call('GET', '/v1/condition-mappings/feed?vocabulary=shopping_feed&limit=2');
		expect(feed.json.items[0]).toEqual({
			itemId: expect.any(String),
			variantId: null,
			tier: expect.any(String),
			condition: expect.any(String),
		});
		expect(feed.json.items[0].variantKey).toBeUndefined();
		const feedNext = await h.call(
			'GET',
			`/v1/condition-mappings/feed?vocabulary=shopping_feed&limit=2&cursor=${encodeURIComponent(feed.json.nextCursor)}`,
		);
		expect(feedNext.status).toBe(200);
		expect((await h.call('GET', '/v1/condition-mappings/feed?vocabulary=nope')).status).toBe(422);
		expect((await h.call('GET', '/v1/condition-mappings/feed?vocabulary=shopping_feed', { key: h.pk })).status).toBe(403);
		await h.entitle({
			config: {
				mapping: {
					vocabularies: [
						{
							key: 'market',
							name: 'Marketplace',
							target: 'marketplace',
							property: 'conditionId',
							allowed: ['1000', '3000'],
							fallback: '9999',
							values: [
								{ tier: 'new', value: '1000' },
								{ tier: 'good', value: '2000' },
							],
						},
					],
				},
			},
		});
		const problems = (await h.call('GET', '/v1/condition-mappings')).json.problems;
		expect(problems).toEqual([
			{ vocabulary: 'market', tier: 'excellent', problem: 'unmapped' },
			{ vocabulary: 'market', tier: 'good', problem: 'not_allowed' },
			{ vocabulary: 'market', tier: 'fair', problem: 'unmapped' },
		]);
		await h.entitle();
	});

	it('refuses disabled elements in Mode C (403) and keys of other origins', async () => {
		await h.entitle({ elements: { showcase: false } });
		const off = await h.call('GET', '/v1/showcase', { key: h.pk });
		expect(off.status).toBe(403);
		expect(off.json.type).toContain('element_disabled');
		await h.entitle();
		const foreign = await h.call('GET', '/v1/tiers', { key: h.pk, headers: { origin: 'https://evil.example.net' } });
		expect(foreign.status).toBe(403);
		expect((await h.call('GET', '/v1/tiers', { key: null })).status).toBe(401);
	});
});
