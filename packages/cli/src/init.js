/**
 * `ss app init <dir> --id <id> --name <name>` — generates a product in the PLAN 0.4.13 layout from
 * `templates/product`: `core/ api/ adapters/ ui/ app/ strings/ schemas/ tests/ docs/`, the manifest, the Next.js
 * wiring (one API route and the dashboard page), the tooling config from `@ss/config` and a sample feature `notes`
 * (a visitor widget, an admin widget with a ticket permission, one setting, widget texts and public docs).
 *
 * Template files and paths may contain `{{id}}`, `{{name}}`, `{{global}}` (the widget's browser global,
 * `SS<Product>`), `{{baseUrl}}` and `{{sdkVersion}}`. `_gitignore` is written as `.gitignore`. Outside a pnpm workspace
 * `templates/standalone` (the pnpm settings and `.nvmrc` a repository of its own needs) is added; inside one (e.g.
 * `products/` of the monorepo) the workspace's apply. `openapi.json` and `api/widget-script.js` are then generated
 * (`ss app assets`), and `.env.local` (git-ignored) gets fresh development secrets.
 * @module
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exists, walk } from './fsutil.js';
import { writeAssets } from './assets.js';

/** Root of the bundled templates. */
const TEMPLATES_DIR = fileURLToPath(new URL('../templates/', import.meta.url));

/** Product ids (manifest `id`, PLAN 0.4.13). */
const PRODUCT_ID = /^[a-z][a-z0-9-]{1,30}$/;

/** Where a new product's manifest says it lives until its deployment address is set. */
const DEFAULT_BASE_URL = 'http://localhost:3000';

/**
 * @typedef {object} InitOptions
 * @property {string} dir target directory (created; must be empty or absent)
 * @property {string} id product id (manifest `id`)
 * @property {string} name display name (1–80 chars)
 * @property {string} [baseUrl] the product's address for `manifest.endpoints.base` (default {@link DEFAULT_BASE_URL})
 * @property {string} [sdkVersion] version range for `@ss/*` dependencies (default `workspace:^`)
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
 * The browser global of a product's widgets (PLAN 0.4.10: `window.SS<Product>`), e.g. `order-notes` → `SSOrderNotes`.
 * @param {string} id
 * @returns {string}
 */
export const globalNameOf = (id) =>
	`SS${id
		.split('-')
		.filter((part) => part.length > 0)
		.map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
		.join('')}`;

/**
 * @param {unknown} value
 * @returns {boolean} an https origin, or http on a local host
 */
const isBaseUrl = (value) => {
	if (typeof value !== 'string') return false;
	try {
		const url = new URL(value);
		const local = /^(?:localhost|.+\.localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname);
		return (
			(url.protocol === 'https:' || (url.protocol === 'http:' && local)) &&
			url.origin === value &&
			url.username === '' &&
			url.password === ''
		);
	} catch {
		return false;
	}
};

/**
 * Check init options; returns error messages (empty when valid).
 * @param {Partial<InitOptions>} options
 * @returns {string[]}
 */
export const checkInitOptions = ({ dir, id, name, baseUrl = DEFAULT_BASE_URL }) => {
	/** @type {string[]} */
	const errors = [];
	if (typeof dir !== 'string' || dir.length === 0) errors.push('a target directory is required');
	if (typeof id !== 'string' || !PRODUCT_ID.test(id))
		errors.push('--id must be 2–31 lowercase letters, digits or - and start with a letter (e.g. notes)');
	if (typeof name !== 'string' || name.trim().length === 0 || name.length > 80) errors.push('--name must be 1–80 characters');
	else if (/[{}"\\<>\n\r`$]/.test(name)) errors.push('--name must not contain { } " \\ < > ` $ or line breaks');
	if (!isBaseUrl(baseUrl))
		errors.push('--base-url must be an origin: https://<host>, or http on localhost, *.localhost, 127.0.0.1 or [::1]');
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

/** @param {number} bytes */
const secret = (bytes) => randomBytes(bytes).toString('base64url');

/**
 * Generate a product.
 * @param {InitOptions} options
 * @returns {Promise<{ dir: string, files: string[] }>} files written (relative, sorted)
 */
export const initApp = async ({
	dir,
	id,
	name,
	baseUrl = DEFAULT_BASE_URL,
	sdkVersion = 'workspace:^',
	standalone,
	templatesDir = TEMPLATES_DIR,
}) => {
	const errors = checkInitOptions({ dir, id, name, baseUrl });
	if (errors.length > 0) throw Object.assign(new Error(errors.join('; ')), { code: 'invalid_options' });
	const target = path.resolve(dir);
	try {
		const existing = await readdir(target);
		if (existing.length > 0) throw Object.assign(new Error(`${dir} is not empty`), { code: 'not_empty' });
	} catch (error) {
		if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
	}
	const values = { id, name: name.trim(), global: globalNameOf(id), baseUrl, sdkVersion };
	const own = standalone ?? !(await insideWorkspace(path.dirname(target)));
	/** @type {Map<string, string>} destination → source */
	const plan = new Map();
	for (const layer of ['product', ...(own ? ['standalone'] : [])]) {
		const root = path.join(templatesDir, layer);
		for (const file of await walk(root, { ignore: new Set(['node_modules']) })) {
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
	for (const { file } of await writeAssets(target)) if (!files.includes(file)) files.push(file);
	// development secrets (git-ignored); each deployment sets its own
	await writeFile(
		path.join(target, '.env.local'),
		`MONGODB_URI=\nCONNECT_SECRET=${secret(32)}\nENCRYPTION_KEY=${secret(32)}\n`,
		{ mode: 0o600 },
	);
	files.push('.env.local');
	return { dir: target, files: files.sort() };
};
