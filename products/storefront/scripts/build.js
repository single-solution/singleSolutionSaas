// Build the browser modules the Portal serves for this pack: one minified, self-contained ES module per element for
// its headless core (`headless/bundle/<key>.js`) and one for its renderer (`ui/bundle/<key>.js`), as the manifest names
// them. The sources stay the readable, tested modules in core/, headless/ and ui/.
//   node scripts/build.js          (writes the modules and prints their sizes)
//   node scripts/build.js --check  (exit 1 when a committed module is out of date)
// Development only: esbuild is a dev dependency.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Source modules of each element's headless core and renderer, and the renderer's stylesheet export. */
export const SOURCES = /** @type {Readonly<Record<string, readonly [string, string, string]>>} */ (
	Object.freeze({
		grid: ['grid.js', 'grid.js', 'styles'],
		cards: ['cards.js', 'cards.js', 'styles'],
		filters: ['filters.js', 'filters.js', 'styles'],
		search_overlay: ['searchOverlay.js', 'searchOverlay.js', 'styles'],
		hero: ['hero.js', 'hero.js', 'styles'],
		trending_band: ['cards.js', 'cards.js', 'bandStyles'],
		category_cards: ['navCards.js', 'navCards.js', 'styles'],
		brand_cards: ['navCards.js', 'navCards.js', 'styles'],
		deals_page: ['dealsPage.js', 'dealsPage.js', 'styles'],
		notice_bar: ['blocks.js', 'blocks.js', 'noticeStyles'],
		mobile_tab_bar: ['blocks.js', 'blocks.js', 'tabBarStyles'],
		contact_footer: ['blocks.js', 'blocks.js', 'footerStyles'],
		theme: ['theme.js', 'theme.js', 'styles'],
	})
);

/**
 * @param {string} layer `headless` or `ui`
 * @param {string} file source file in that layer
 * @param {string[]} names exports
 */
const bundle = async (layer, file, names) => {
	const result = await build({
		stdin: {
			contents: `export { ${names.join(', ')} } from './${file}';`,
			resolveDir: path.join(ROOT, layer),
			sourcefile: `${layer}-entry.js`,
			loader: 'js',
		},
		bundle: true,
		minifyWhitespace: true,
		minifySyntax: true,
		// identifiers keep their names: `ss app validate` reads t('key') calls, and a minified name could collide
		minifyIdentifiers: false,
		format: 'esm',
		platform: 'browser',
		target: ['es2020'],
		legalComments: 'none',
		charset: 'utf8',
		write: false,
		logLevel: 'silent',
	});
	return result.outputFiles[0]?.text ?? '';
};

/**
 * String-key prefixes each element's own catalog takes from `strings/en.json` (the Loader embeds an element's catalog
 * in every website bundle, so each element ships only the strings it renders).
 */
export const STRING_PREFIXES = /** @type {Readonly<Record<string, readonly string[]>>} */ (
	Object.freeze({
		grid: ['grid.', 'card.', 'storefront.'],
		cards: ['cards.', 'card.', 'storefront.'],
		filters: ['filters.', 'storefront.'],
		search_overlay: ['search_overlay.', 'storefront.'],
		hero: ['hero.'],
		trending_band: ['trending_band.', 'card.', 'storefront.'],
		category_cards: ['category_cards.', 'nav.'],
		brand_cards: ['brand_cards.', 'nav.'],
		deals_page: ['deals_page.', 'card.', 'storefront.'],
		notice_bar: ['notice_bar.'],
		mobile_tab_bar: ['mobile_tab_bar.'],
		contact_footer: ['contact_footer.'],
	})
);

/**
 * An element's string catalog: the keys of `strings/en.json` under its prefixes.
 * @param {Record<string, string>} catalog
 * @param {readonly string[]} prefixes
 */
export const catalogFor = (catalog, prefixes) =>
	`${JSON.stringify(Object.fromEntries(Object.entries(catalog).filter(([key]) => prefixes.some((prefix) => key.startsWith(prefix)))), null, '\t')}\n`;

/** Every built file: `{ path, text }` (modules in manifest order, then the element string catalogs). */
export const buildModules = async () => {
	const manifest = JSON.parse(await readFile(path.join(ROOT, 'manifest.json'), 'utf8'));
	const catalog = JSON.parse(await readFile(path.join(ROOT, 'strings/en.json'), 'utf8'));
	/** @type {Array<{ path: string, text: string }>} */
	const out = [];
	/** @type {Array<{ path: string, text: string }>} */
	const catalogs = [];
	for (const element of manifest.elements) {
		const files = SOURCES[element.key];
		if (!files) throw new Error(`no source for element ${element.key}`);
		const [headlessRef, headlessName] = String(element.headless).split('#');
		const [rendererRef, rendererName] = String(element.renderer).split('#');
		out.push({ path: String(headlessRef), text: await bundle('headless', files[0], [String(headlessName)]) });
		const styles = files[2] === 'styles' ? 'styles' : `${files[2]} as styles`;
		out.push({ path: String(rendererRef), text: await bundle('ui', files[1], [String(rendererName), styles]) });
		const prefixes = STRING_PREFIXES[element.key];
		if (prefixes && typeof element.strings === 'string')
			catalogs.push({ path: element.strings, text: catalogFor(catalog, prefixes) });
	}
	return [...out, ...catalogs];
};

const main = async () => {
	const check = process.argv.includes('--check');
	const modules = await buildModules();
	const stale = [];
	for (const module of modules) {
		const target = path.join(ROOT, module.path);
		const current = await readFile(target, 'utf8').catch(() => null);
		if (current === module.text) continue;
		if (check) stale.push(module.path);
		else {
			await mkdir(path.dirname(target), { recursive: true });
			await writeFile(target, module.text);
		}
	}
	for (const module of modules)
		process.stdout.write(
			`${module.path.padEnd(32)} ${String(module.text.length).padStart(6)} B  ${String(gzipSync(module.text, { level: 9 }).byteLength).padStart(5)} B gzip\n`,
		);
	if (stale.length > 0) {
		process.stderr.write(`out of date (run node scripts/build.js): ${stale.join(', ')}\n`);
		process.exit(1);
	}
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
