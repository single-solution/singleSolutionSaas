/**
 * `ss app init <dir> --kind service|pack --slug <slug> --name <name>` — generates a project from the templates:
 * `templates/shared` (core, headless, ui, strings, schemas, unit tests) overlaid by `templates/<kind>`.
 * Files and paths may contain `{{slug}}`, `{{name}}`, `{{namespace}}` (slug with `-` → `_`) and `{{sdkVersion}}`.
 * `_gitignore` is written as `.gitignore`. Outside a pnpm workspace `templates/standalone` (the pnpm settings and
 * `.nvmrc` a repository of its own needs) is added; inside one (e.g. `products/` of the monorepo) the workspace's apply.
 *
 * `--minimal` (service products): the `notes` sample ({@link NOTES_SAMPLE_FILES}) is left out and
 * `templates/minimal/service` is overlaid instead: one placeholder Mode C element `status` (`GET /v1/status`, marked
 * `x-ss-certify`, no database, no events) because a product needs at least one element. The project still passes
 * `ss app validate` and its own tests.
 * @module
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { generateConnectSecret } from '@ss/protocol';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PATTERNS } from '@ss/contracts';
import { exists, walk } from './fsutil.js';
import { ASSETS_FILE, writeAssets } from './assets.js';

/** Root of the bundled templates. */
export const TEMPLATES_DIR = fileURLToPath(new URL('../templates/', import.meta.url));

/** Product kinds `init` can generate. */
export const INIT_KINDS = Object.freeze(/** @type {const} */ (['service', 'pack']));

/**
 * Template files (source paths, before placeholder substitution) that belong to the `notes` sample only; `--minimal`
 * leaves them out. The manifest, openapi.json, strings, api/routes.js, adapters/privacy.js, docs and README are
 * replaced by the minimal overlay instead.
 */
export const NOTES_SAMPLE_FILES = Object.freeze([
	'core/notes.js',
	'headless/notes.js',
	'ui/notes.js',
	'schemas/notes.features.json',
	'tests/core.test.js',
	'tests/headless.test.js',
	'tests/ui.test.js',
	'tests/helpers.js',
	'api/notes.js',
	'api/events.js',
	'adapters/db.js',
	'schemas/events/{{namespace}}.note_created@1.json',
	'tests/api.test.js',
	'tests/memory-collection.js',
]);

/**
 * @typedef {object} InitOptions
 * @property {string} dir target directory (created; must be empty or absent)
 * @property {'service' | 'pack'} kind
 * @property {string} slug product slug (SSPS slug pattern)
 * @property {string} name display name (1–80 chars)
 * @property {string} [sdkVersion] version range for `@ss/*` dependencies (default `workspace:^`)
 * @property {boolean} [minimal] service only: leave out the `notes` sample (one placeholder element instead)
 * @property {boolean} [standalone] add the files of a repository of its own (default: when `dir` is not inside a pnpm
 *   workspace)
 * @property {string} [templatesDir]
 */

/**
 * Substitute `{{placeholders}}`.
 * @param {string} text
 * @param {Readonly<Record<string, string>>} values
 * @returns {string}
 */
export const fill = (text, values) =>
	text.replace(/\{\{([A-Za-z]+)\}\}/g, (match, key) =>
		Object.hasOwn(values, key) ? /** @type {string} */ (values[key]) : match,
	);

/**
 * Check init options; returns error messages (empty when valid).
 * @param {Partial<InitOptions>} options
 * @returns {string[]}
 */
export const checkInitOptions = ({ dir, kind, slug, name, minimal }) => {
	/** @type {string[]} */
	const errors = [];
	if (typeof dir !== 'string' || dir.length === 0) errors.push('a target directory is required');
	if (!INIT_KINDS.includes(/** @type {'service' | 'pack'} */ (kind))) errors.push('--kind must be service or pack');
	if (typeof slug !== 'string' || slug.length < 2 || slug.length > 40 || !new RegExp(PATTERNS.slug).test(slug))
		errors.push('--slug must be 2–40 chars of lowercase letters/digits separated by - or _ (e.g. notes-pro)');
	if (typeof name !== 'string' || name.trim().length === 0 || name.length > 80) errors.push('--name must be 1–80 characters');
	else if (/[{}"\\<>\n\r`]/.test(name)) errors.push('--name must not contain { } " \\ < > ` or line breaks');
	if (minimal === true && kind === 'pack')
		errors.push('--minimal is for service products (a pack element is the sample: it needs a headless core and renderer)');
	return errors;
};

/**
 * True when `dir` or one of its ancestors holds a `pnpm-workspace.yaml`.
 * @param {string} dir
 * @returns {Promise<boolean>}
 */
export const insideWorkspace = async (dir) => {
	const current = path.resolve(dir);
	if (await exists(path.join(current, 'pnpm-workspace.yaml'))) return true;
	const parent = path.dirname(current);
	return parent === current ? false : insideWorkspace(parent);
};

/**
 * Generate a project.
 * @param {InitOptions} options
 * @returns {Promise<{ dir: string, files: string[] }>} files written (relative)
 */
export const initApp = async ({
	dir,
	kind,
	slug,
	name,
	sdkVersion = 'workspace:^',
	minimal = false,
	standalone,
	templatesDir = TEMPLATES_DIR,
}) => {
	const errors = checkInitOptions({ dir, kind, slug, name, minimal });
	if (errors.length > 0) throw Object.assign(new Error(errors.join('; ')), { code: 'invalid_options' });
	const target = path.resolve(dir);
	try {
		const existing = await readdir(target);
		if (existing.length > 0) throw Object.assign(new Error(`${dir} is not empty`), { code: 'not_empty' });
	} catch (error) {
		if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
	}
	const values = { slug, name: name.trim(), namespace: slug.replace(/-/g, '_'), sdkVersion };
	/** @type {Map<string, string>} destination → source */
	const plan = new Map();
	const skip = new Set(minimal ? NOTES_SAMPLE_FILES : []);
	const own = standalone ?? !(await insideWorkspace(path.dirname(target)));
	const layers = [...(minimal ? ['shared', kind, `minimal/${kind}`] : ['shared', kind]), ...(own ? ['standalone'] : [])];
	for (const layer of layers) {
		const root = path.join(templatesDir, layer);
		for (const file of await walk(root, { ignore: new Set(['node_modules']) })) {
			if (skip.has(file)) continue;
			const destination = fill(file, values)
				.split('/')
				.map((part) => (part === '_gitignore' ? '.gitignore' : part))
				.join('/');
			plan.set(destination, path.join(root, file));
		}
	}
	for (const [destination, source] of plan) {
		const out = path.join(target, destination);
		await mkdir(path.dirname(out), { recursive: true });
		await writeFile(out, fill(await readFile(source, 'utf8'), values));
	}
	const files = [...plan.keys()];
	if (kind === 'service') {
		// the manifest, feature schemas and strings bundled into the Next.js server build (regenerated by `prebuild`)
		await writeAssets(target);
		files.push(ASSETS_FILE);
		// local development secret (git-ignored); deployments set their own CONNECT_SECRET
		await writeFile(path.join(target, '.env.local'), `MONGODB_URI=\nCONNECT_SECRET=${generateConnectSecret()}\n`, {
			mode: 0o600,
		});
		files.push('.env.local');
	}
	return { dir: target, files: files.sort() };
};
