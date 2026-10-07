/**
 * The pack as the Portal serves it, built by `ss pack build` (F.18): minified ES modules with shared chunks, and the
 * built modules really work: each is imported from the build output and mounted the way the Loader does.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { BUNDLE_FORMAT, descriptorOf, loadManifest, writePack } from '../pack.js';
import { ITEMS, ROOT, flush, mount, pageScript, strings } from './helpers.js';

/** @type {string} */
let out;
/** @type {Awaited<ReturnType<typeof writePack>>} */
let pack;
beforeAll(async () => {
	out = await mkdtemp(path.join(tmpdir(), 'storefront-pack-'));
	pack = await writePack(out);
}, 60_000);
afterAll(async () => {
	await rm(out, { recursive: true, force: true });
});

describe('the built pack', () => {
	it('writes minified modules, the product catalog and the descriptor', async () => {
		const descriptor = JSON.parse(await readFile(path.join(out, 'descriptor.json'), 'utf8'));
		expect(descriptor).toEqual(JSON.parse(JSON.stringify(descriptorOf(pack))));
		expect(descriptor.format).toBe(BUNDLE_FORMAT);
		const paths = descriptor.assets.map((/** @type {any} */ a) => a.path);
		expect(paths).toContain('strings/en.json');
		expect(paths.some((/** @type {string} */ p) => p.startsWith('chunks/'))).toBe(true);
		expect(paths.filter((/** @type {string} */ p) => /\.en\.json$/.test(p))).toEqual([]);
		const grid = await readFile(path.join(out, 'ui/grid.js'), 'utf8');
		const source = await readFile(path.join(ROOT, 'ui/grid.js'), 'utf8');
		expect(grid.length).toBeLessThan(source.length); // minified, identifiers included
		expect(grid).not.toContain('@param');
		const inline = await loadManifest();
		expect(inline.elements.every((/** @type {any} */ e) => e.features.type === 'object')).toBe(true);
		expect(inline.reads.map((/** @type {any} */ r) => r.product)).toEqual(['catalog', 'search', 'deals']);
	});

	it('mounts every built element like the Loader does', async () => {
		// esbuild needs Node's own globals, so this file runs in Node with a document of its own for the mounting
		const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://shop.example.com/' });
		const globals = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (globalThis));
		const names = [
			'window',
			'document',
			'HTMLElement',
			'Node',
			'CustomEvent',
			'Event',
			'KeyboardEvent',
			'MouseEvent',
			'location',
			'history',
			'IntersectionObserver',
		];
		const saved = Object.fromEntries(names.map((name) => [name, globals[name]]));
		for (const name of names) if (name in dom.window) globals[name] = /** @type {any} */ (dom.window)[name];
		pageScript(ITEMS);
		for (const element of pack.manifest.elements) {
			const [headlessFile, headlessName = ''] = String(element.headless).split('#');
			const [rendererFile, rendererName = ''] = String(element.renderer).split('#');
			const headless = await import(/* @vite-ignore */ pathToFileURL(path.join(out, String(headlessFile))).href);
			const renderer = await import(/* @vite-ignore */ pathToFileURL(path.join(out, String(rendererFile))).href);
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
		for (const name of names) globals[name] = saved[name];
	});
});
