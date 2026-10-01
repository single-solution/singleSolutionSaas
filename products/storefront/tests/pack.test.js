// @vitest-environment jsdom
/**
 * The pack as the Portal serves it (tests/build.test.js checks the modules are current): every element ships within its declared budget
 * (gzip of its headless + renderer modules, as the Portal measures, and the renderer's size, as `ss app validate`
 * estimates), the elements switched on by each plan fit the website budget next to the Loader, and the built modules
 * really work: each is loaded and mounted the way the Loader does.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { assetPaths, loadManifest, packAssets } from '../pack.js';
import { ITEMS, ROOT, flush, mount, pageScript, strings } from './helpers.js';

const manifest = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
/** @param {string} relative */
const bytes = (relative) => readFileSync(path.join(ROOT, relative));
/** @param {string} ref */
const file = (ref) => String(ref).split('#')[0] ?? '';
/** Portal default website budget (KB gzip, `DELIVERY_BUDGET_KB`) and what the Loader itself takes of it. */
const WEBSITE_BUDGET_KB = 60;
const LOADER_KB = 18;

describe('built modules', () => {
	it('stay within each element’s declared budget, and the budgets are not padded', () => {
		for (const element of manifest.elements) {
			const limit = element.budget.js * 1024;
			const renderer = bytes(file(element.renderer));
			const gzip =
				gzipSync(bytes(file(element.headless)), { level: 9 }).byteLength + gzipSync(renderer, { level: 9 }).byteLength;
			expect(gzip, `${element.key} gzip`).toBeLessThanOrEqual(limit);
			expect(renderer.byteLength, `${element.key} renderer`).toBeLessThanOrEqual(limit);
			expect(Math.max(gzip, renderer.byteLength), `${element.key} budget is padded`).toBeGreaterThan(limit - 1024);
		}
	});

	it('switch on, per plan, only what fits the website budget next to the Loader', () => {
		const budget = Object.fromEntries(manifest.elements.map((/** @type {any} */ e) => [e.key, e.budget.js]));
		for (const plan of manifest.plans) {
			const total = plan.elements.reduce((/** @type {number} */ sum, /** @type {string} */ key) => sum + budget[key], 0);
			expect(total + LOADER_KB, plan.code).toBeLessThanOrEqual(WEBSITE_BUDGET_KB);
		}
	});

	it('mount and render like the Loader mounts them', async () => {
		pageScript(ITEMS);
		for (const element of manifest.elements) {
			const [headlessFile, headlessName = ''] = String(element.headless).split('#');
			const [rendererFile, rendererName = ''] = String(element.renderer).split('#');
			const headless = await import(/* @vite-ignore */ path.join(ROOT, String(headlessFile)));
			const renderer = await import(/* @vite-ignore */ path.join(ROOT, String(rendererFile)));
			expect(typeof renderer.styles, element.key).toBe('string');
			const instance = headless[headlessName]({ config: {}, strings, emit: () => undefined });
			const view = mount(instance, renderer[rendererName]);
			await flush();
			const root = view.node();
			if (element.a11y) {
				expect(root.getAttribute('role'), element.key).toBe(element.a11y.role);
				expect(root.getAttribute('aria-label'), element.key).toBeTruthy();
			}
			view.destroy();
			instance.destroy();
		}
	});
});

describe('pack.js', () => {
	it('lists the assets the Portal stores, with their hashes, and inlines the feature schemas', async () => {
		const assets = await packAssets();
		expect(assets.map((a) => a.path).sort()).toEqual([...assetPaths(manifest)].sort());
		expect(assets.map((a) => a.path)).toContain('strings/grid.en.json');
		for (const asset of assets) {
			expect(asset.size).toBe(asset.bytes.byteLength);
			expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(asset.contentType).toBe(asset.path.endsWith('.json') ? 'application/json' : 'text/javascript');
		}
		const inline = await loadManifest();
		expect(inline.elements.every((/** @type {any} */ e) => e.features.type === 'object')).toBe(true);
		expect(assetPaths({ elements: [{ headless: 'a.js#x' }, { renderer: 'b.png#y', strings: 'a.js' }] })).toEqual([
			'a.js',
			'b.png',
		]);
	});
});
