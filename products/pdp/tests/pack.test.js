/**
 * The publishable pack (`ss pack build`, F.18): manifest validity, the product string catalog sliced per element, the
 * esbuild bundle (entries + shared chunks) and the budgets the Portal enforces, measured as it measures them (each
 * element's own entry modules ≤ its `budget.js`, the shared chunks ≤ `budget.shared`; the default plan fits the default
 * website budget next to the Loader).
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateManifest } from '@ss/contracts';
import { measurePack } from '@ss/cli/pack';
import { BUNDLE_FORMAT, buildPack, descriptorOf, loadManifest, writePack } from '../pack.js';
import { flush, page, strings } from './helpers.js';

/** Loader + events client gzip (F.7) — the website budget's fixed part. */
const LOADER_KB = 13;
/** Default website budget (`DELIVERY_BUDGET_KB`). */
const WEBSITE_KB = 60;

/** @type {Awaited<ReturnType<typeof buildPack>>} */
let pack;
/** @type {string} */
let out;

beforeAll(async () => {
	pack = await buildPack();
	out = await mkdtemp(path.join(tmpdir(), 'ss-pdp-pack-'));
}, 60_000);
afterAll(async () => {
	await rm(out, { recursive: true, force: true });
});

/** @param {string} ref */
const fileOf = (ref) => ref.split('#')[0] ?? '';
/** @param {string} file */
const gzip = (file) => {
	const entry = pack.assets.find((asset) => asset.path === file);
	if (!entry) throw new Error(`missing asset ${file}`);
	return gzipSync(entry.bytes, { level: 9 }).byteLength;
};

describe('manifest and strings', () => {
	it('is a valid SSPS pack manifest with features inlined', async () => {
		const manifest = await loadManifest();
		const result = validateManifest(manifest);
		expect(result.ok, JSON.stringify(result.ok ? null : result.problems)).toBe(true);
		expect(manifest.product).toMatchObject({ slug: 'pdp', kind: 'pack' });
		expect(manifest.elements.map((/** @type {any} */ e) => e.key)).toEqual([
			'gallery',
			'price_block',
			'structured_data',
			'configurator_embed',
			'deal_pill',
			'grade_showcase',
			'reviews_block',
			'alerts_block',
			'related',
			'faq',
			'sticky_buy_bar',
			'share',
			'hosted_page',
		]);
		for (const element of manifest.elements) {
			expect(element.features.type).toBe('object');
			expect(element.modes).toEqual(['A', 'B']);
			expect(element.features.properties.placement.default).toBeTypeOf('object');
		}
	});

	it('slices strings/en.json per element: every key belongs to exactly one element', async () => {
		const manifest = await loadManifest();
		for (const key of Object.keys(strings)) {
			const owners = manifest.elements.filter((/** @type {any} */ e) =>
				e.stringKeys.some((/** @type {string} */ p) => (p.endsWith('*') ? key.startsWith(p.slice(0, -1)) : key === p)),
			);
			expect(owners.length, key).toBe(1);
		}
		expect(manifest.elements.every((/** @type {any} */ e) => e.strings === undefined)).toBe(true);
	});
});

describe('pack build', () => {
	it('bundles every module reference with shared chunks and every string catalog', async () => {
		const paths = pack.assets.map((asset) => asset.path);
		for (const element of pack.manifest.elements) {
			expect(paths).toContain(fileOf(element.headless));
			expect(paths).toContain(fileOf(element.renderer));
		}
		expect(paths).toContain('strings/en.json');
		expect(paths.some((file) => file.startsWith('chunks/'))).toBe(true);
		for (const asset of pack.assets) {
			expect(asset.path).toMatch(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*(\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/);
			expect(asset.size).toBe(asset.bytes.byteLength);
			expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
			if (asset.path.endsWith('.js')) {
				expect(asset.contentType).toBe('text/javascript');
				// self-contained ES modules: only relative imports of other assets
				for (const match of asset.bytes.toString('utf8').matchAll(/from"([^"]+)"/g))
					expect(paths).toContain(path.posix.normalize(path.posix.join(path.posix.dirname(asset.path), match[1] ?? '')));
			}
		}
		const descriptor = descriptorOf(pack);
		expect(descriptor.format).toBe(BUNDLE_FORMAT);
		expect(descriptor.assets[0]).toEqual({
			path: pack.assets[0]?.path,
			sha256: pack.assets[0]?.sha256,
			size: pack.assets[0]?.size,
			contentType: pack.assets[0]?.contentType,
		});
		// deterministic: the same sources give the same bytes
		const again = await buildPack();
		expect(again.assets.map((asset) => asset.sha256)).toEqual(pack.assets.map((asset) => asset.sha256));
	});

	it('keeps every element within its budget and the default plan within the website budget', () => {
		/** @type {Record<string, number>} */
		const budgets = {};
		const measured = measurePack(pack);
		for (const element of pack.manifest.elements) {
			const own = measured.elements.find((e) => e.key === element.key);
			expect(own?.gzipBytes, `${element.key} ships ${own?.gzipBytes} B gzip`).toBeLessThanOrEqual(element.budget.js * 1024);
			budgets[element.key] = element.budget.js;
		}
		expect(measured.shared.gzipBytes).toBeLessThanOrEqual(pack.manifest.budget.shared * 1024);
		const plan = pack.manifest.plans[0];
		const declared = plan.elements.reduce(
			(/** @type {number} */ sum, /** @type {string} */ key) => sum + (budgets[key] ?? 0),
			0,
		);
		expect(LOADER_KB + declared + pack.manifest.budget.shared).toBeLessThanOrEqual(WEBSITE_KB);
		// what a page with every element really downloads (entries + shared chunks), far below the declarations
		const everything = pack.assets
			.filter((asset) => asset.path.endsWith('.js'))
			.reduce((sum, asset) => sum + gzip(asset.path), 0);
		expect(everything).toBeLessThan(40 * 1024);
	});

	it('writes a publishable folder whose modules run in a browser page', async () => {
		await writePack(out);
		const descriptor = JSON.parse(await readFile(path.join(out, 'descriptor.json'), 'utf8'));
		expect(descriptor.assets).toHaveLength(pack.assets.length);
		const headless = await import(pathToFileURL(path.join(out, 'headless/priceBlock.js')).href);
		const ui = await import(pathToFileURL(path.join(out, 'ui/priceBlock.js')).href);
		const win = page(
			'<div data-ss-item-id="a1" data-ss-item-title="Kettle" data-ss-item-price="25" data-ss-item-currency="GBP"></div>',
			{
				lang: 'en-GB',
			},
		);
		const instance = headless.createPriceBlock({ strings });
		ui.render({ state: instance.state(), actions: instance.actions, strings, dom: win.document });
		await flush();
		const node = ui.render({ state: instance.state(), actions: instance.actions, strings, dom: win.document });
		expect(node.querySelector('.ss-price__now').textContent).toBe('£25.00');
		expect(typeof ui.styles).toBe('string');
	});
});
