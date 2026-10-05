/**
 * Delivery wave-1 changes (F.18): element keys namespaced per product, packs reading service products through a
 * Loader client (and the loader key's read scopes), per-website string overrides, shared-chunk budgets and the
 * language-sliced product catalogs.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeMongoClients } from '../../../src/infra/db.js';
import { startMongo } from '../../helpers.js';
import {
	checkBudget,
	elementStrings,
	inSlice,
	languageChain,
	measureSelected,
	readsFor,
	selectElements,
} from '../../../src/modules/delivery/core/compile.js';
import { checkStringOverride } from '../../../src/modules/delivery/core/strings.js';
import { BIG, M1, PACK, SERVICE, W1, bootDelivery, packManifest } from './fixtures.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

/** @type {Awaited<ReturnType<typeof startMongo>>} */
let mongo;
beforeAll(async () => {
	mongo = await startMongo();
}, 120_000);
afterAll(async () => {
	await closeMongoClients();
	await mongo?.stop();
});

const SITE = `/v1/merchants/${M1}/websites/${W1}`;

/** @param {string} text */
const compiledData = (text) => JSON.parse(/** @type {string} */ (/__ssr\.start\((\{.*\})\);/s.exec(text)?.[1]));

describe('compiled bundles (F.18)', () => {
	it('delivers the same key from two products, gives pack elements read clients and scopes the loader key', async () => {
		const t = await bootDelivery({ db: mongo.db() });
		// a second pack delivering `bar` too, and the notice bar reading the chat service product
		const big = /** @type {any} */ (t.world.apps.get(BIG)).versions.get(1);
		big.manifest = { ...packManifest(), product: { ...packManifest().product, slug: 'big-gallery' } };
		const pack = /** @type {any} */ (t.world.apps.get(PACK)).versions.get(1);
		pack.manifest = { ...packManifest(), reads: ['chat-box', 'search'] };
		await t.uploadAll(PACK);
		await t.uploadAll(BIG);
		await t.subscribe(W1, PACK);
		await t.subscribe(W1, BIG);
		const owner = await t.cookie();
		const before = await t.request('POST', `${SITE}/delivery/compile`, { cookie: owner });
		expect(before.status, before.text).toBe(200);
		expect(before.json.warnings.map((/** @type {any} */ w) => w.code)).toContain('reads_inactive');
		await t.subscribe(W1, SERVICE);
		const compiled = await t.request('POST', `${SITE}/delivery/compile`, { cookie: owner });
		expect(compiled.status, compiled.text).toBe(200);
		const alias = await t.request('GET', `/w/${W1}/loader.js`);
		const data = compiledData(alias.text);
		const bars = data.elements.filter((/** @type {any} */ e) => e.key === 'bar');
		expect(bars.map((/** @type {any} */ e) => e.product).sort()).toEqual(['big-gallery', 'notice-bar']);
		expect(bars.find((/** @type {any} */ e) => e.product === 'notice-bar').reads).toEqual({
			'chat-box': 'https://chat.example.net',
		});
		expect(data.elements.find((/** @type {any} */ e) => e.key === 'launcher')).toMatchObject({ product: 'chat-box' });
		// the loader key now also reads the chat product; the earlier key stays active for cached bundles
		const keys = [...t.world.keys.values()];
		expect(keys).toHaveLength(2);
		expect(keys.at(-1)?.scopes).toEqual(['events.write', 'elements.read', 'chat-box.read']);
		expect(data.key).toBe(keys.at(-1)?.key);
		const manifest = await t.request('GET', `/w/${W1}/${compiled.json.version}/manifest.json`);
		expect(manifest.json.elements.find((/** @type {any} */ e) => e.slug === 'notice-bar').reads).toEqual(['chat-box']);
		// the stub element ships no product code and takes none of the website budget
		expect(manifest.json.elements.find((/** @type {any} */ e) => e.key === 'launcher').budgetKb).toBe(0);
	});

	it('applies per-website string overrides from the merchant console and recompiles', async () => {
		const t = await bootDelivery({ db: mongo.db() });
		await t.uploadAll(PACK);
		await t.subscribe(W1, PACK);
		const owner = await t.cookie();
		const put = (/** @type {string} */ path, /** @type {unknown} */ body) =>
			t.request('PUT', `${SITE}/delivery/strings/${path}`, { cookie: owner, body });
		expect((await put(`${PACK}/bar/en`, { strings: { 'bar.label': 'Heads up' } })).json).toMatchObject({
			appId: PACK,
			element: 'bar',
			languages: { en: { 'bar.label': 'Heads up' } },
		});
		expect((await put(`${PACK}/bar/*`, { strings: { 'bar.extra': 'Everywhere' } })).status).toBe(200);
		expect((await put(`${PACK}/bar/xx-!!`, { strings: {} })).status).toBe(422);
		expect((await put(`${PACK}/nope/en`, { strings: { a: 'b' } })).status).toBe(404);
		expect((await put(`${SERVICE}/launcher/en`, { strings: { a: 'b' } })).status).toBe(404);
		const listed = await t.request('GET', `${SITE}/delivery/strings`, { cookie: owner });
		expect(listed.json.items).toHaveLength(1);
		await t.request('POST', `${SITE}/delivery/compile`, { cookie: owner });
		const data = compiledData((await t.request('GET', `/w/${W1}/loader.js`)).text);
		expect(data.elements[0].strings).toMatchObject({ 'bar.label': 'Heads up', 'bar.extra': 'Everywhere' });
		// an empty object removes a language, and the last one removes the record
		await put(`${PACK}/bar/en`, { strings: {} });
		await put(`${PACK}/bar/*`, { strings: {} });
		expect((await t.request('GET', `${SITE}/delivery/strings`, { cookie: owner })).json.items).toEqual([]);
		const audit = await t.db.collection('platform_audit').find({ action: 'delivery.strings_updated' }).toArray();
		expect(audit.length).toBeGreaterThanOrEqual(4);
	});
});

describe('compiler helpers (F.18)', () => {
	/** @param {Record<string, any>} [overrides] @returns {any} */
	const source = (overrides = {}) => ({
		appId: PACK,
		slug: 'notice-bar',
		kind: 'pack',
		manifestVersion: 1,
		manifest: packManifest(),
		document: { runtime: { state: 'active' }, elements: { bar: { enabled: true } }, config: {} },
		apiBase: null,
		assets: new Map(
			['headless/bar.js', 'ui/bar.js', 'chunks/c.js', 'strings/en.json'].map((p) => [p, { sha256: 'x', size: 1 }]),
		),
		strings: new Map([
			['strings/en.json', { 'bar.label': 'Notice', 'bar.more': 'More', 'other.key': 'Other' }],
			['strings/de.json', { 'bar.label': 'Hinweis' }],
			['strings/de-CH.json', { 'bar.more': 'Mehr (CH)' }],
		]),
		gzipBytes: new Map([
			['headless/bar.js', 300],
			['ui/bar.js', 200],
			['chunks/c.js', 2048],
		]),
		files: new Map([
			['headless/bar.js', Buffer.from('import"./../chunks/c.js";export const createBar=1;')],
			['ui/bar.js', Buffer.from('export const render=1;')],
			['chunks/c.js', Buffer.from('export const c=1;')],
		]),
		...overrides,
	});

	it('resolves language chains and slices', () => {
		expect(languageChain(null)).toEqual(['en']);
		expect(languageChain('de-CH')).toEqual(['en', 'de', 'de-CH']);
		expect(languageChain('EN-gb')).toEqual(['en', 'EN-gb']);
		expect(inSlice(['bar.*', 'other.key'], 'other.key')).toBe(true);
		expect(inSlice(['bar.*'], 'baz.x')).toBe(false);
	});

	it('slices the product catalogs per element and language, then applies overrides', () => {
		const s = source();
		const element = { key: 'bar', stringKeys: ['bar.*'] };
		expect(elementStrings({ element, modules: element, source: s, context: { language: 'de-CH' } })).toEqual({
			'bar.label': 'Hinweis',
			'bar.more': 'Mehr (CH)',
		});
		// default slice `<key>.*`, english fallback
		expect(elementStrings({ element: { key: 'bar' }, modules: {}, source: s, context: { language: 'fr' } })).toEqual({
			'bar.label': 'Notice',
			'bar.more': 'More',
		});
		// a legacy strings/<lang>.json reference takes the whole chain catalog; another file is used as is
		expect(
			elementStrings({
				element: { key: 'bar' },
				modules: { strings: 'strings/en.json' },
				source: s,
				context: { language: 'de' },
			}),
		).toMatchObject({ 'bar.label': 'Hinweis', 'other.key': 'Other' });
		const legacy = source({ strings: new Map([['strings/bar.en.json', { x: 'y' }]]) });
		expect(
			elementStrings({
				element: { key: 'bar' },
				modules: { strings: 'strings/bar.en.json' },
				source: legacy,
				context: { language: null },
			}),
		).toEqual({ x: 'y' });
		const overrides = new Map([[`${PACK}:bar`, { '*': { 'bar.label': 'All' }, de: { 'bar.more': 'DE' } }]]);
		expect(elementStrings({ element, modules: element, source: s, context: { language: 'de', overrides } })).toEqual({
			'bar.label': 'All',
			'bar.more': 'DE',
		});
		const selected = selectElements([s], null, { language: 'de', overrides }).selected;
		expect(selected[0]?.strings).toMatchObject({ 'bar.label': 'All' });
	});

	it('finds read products and measures shared chunks once per product', () => {
		const pack = source({ manifest: { ...packManifest(), reads: [{ product: 'chat-box', scopes: ['chat-box.read'] }] } });
		const chat = source({
			appId: SERVICE,
			slug: 'chat-box',
			kind: 'service',
			apiBase: 'https://chat.example.net',
			manifest: { ...packManifest(), elements: [] },
		});
		expect(readsFor(pack, [pack, chat])).toEqual({
			reads: { 'chat-box': 'https://chat.example.net' },
			scopes: ['chat-box.read'],
			missing: [],
		});
		expect(readsFor(pack, [pack, { ...chat, document: { runtime: { state: 'paused' } } }]).missing).toEqual(['chat-box']);
		const { selected } = selectElements([pack]);
		const measured = measureSelected(selected, [pack]);
		expect(measured.selected[0]?.actualGzipBytes).toBe(500);
		expect(measured.shared).toEqual([
			{ appId: PACK, slug: 'notice-bar', declaredKb: null, gzipBytes: 2048, modules: ['chunks/c.js'] },
		]);
		const declared = measureSelected(selected, [{ ...pack, manifest: { ...pack.manifest, budget: { shared: 1 } } }]);
		const budget = checkBudget({ loaderGzipBytes: 1024, limitKb: 3, elements: declared.selected, shared: declared.shared });
		expect(budget.offenders.map((o) => o.code)).toEqual(['shared_over_declared', 'budget', 'budget']);
		expect(budget.report).toMatchObject({
			sharedKb: 1,
			shared: [{ slug: 'notice-bar', declaredKb: 1, measuredKb: 2, modules: 1 }],
		});
		const undeclared = checkBudget({
			loaderGzipBytes: 1024,
			limitKb: 60,
			elements: measured.selected,
			shared: measured.shared,
		});
		expect(undeclared).toMatchObject({ ok: true, report: { sharedKb: 2 } });
		expect(measureSelected(selected, []).shared).toEqual([]);
	});

	it('checks string override requests', () => {
		expect(
			checkStringOverride({ appId: PACK, element: 'bar', language: 'de-CH', body: { strings: { 'bar.x': 'y' } } }),
		).toEqual({
			ok: true,
			strings: { 'bar.x': 'y' },
		});
		const bad = checkStringOverride({
			appId: 'nope',
			element: 'Bad',
			language: 'not a tag',
			body: { strings: { '!': 'x', ok: 3 }, extra: 1 },
		});
		expect(bad.ok).toBe(false);
		const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`k${i}`, 'x'.repeat(200)]));
		const big = checkStringOverride({ appId: PACK, element: 'bar', language: '*', body: { strings: many } });
		expect(big.ok ? [] : big.errors.map((e) => e.path)).toEqual(['/strings', '/strings']);
		expect(checkStringOverride({ appId: PACK, element: 'bar', language: 'en', body: { strings: { ok: 'x' } } }).ok).toBe(true);
		const nested = checkStringOverride({
			appId: PACK,
			element: 'bar',
			language: 'en',
			body: { strings: { ok: 'x'.repeat(2001) } },
		});
		expect(nested.ok).toBe(false);
	});
});
