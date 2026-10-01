/**
 * `ss app init <dir> --kind service|pack --slug <slug> --name <name>` — generates a project from the templates:
 * `templates/shared` (core, headless, ui, strings, schemas, unit tests) overlaid by `templates/<kind>`.
 * Files and paths may contain `{{slug}}`, `{{name}}`, `{{namespace}}` (slug with `-` → `_`) and `{{sdkVersion}}`.
 * `_gitignore` is written as `.gitignore`.
 * @module
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PATTERNS } from '@ss/contracts';
import { walk } from './fsutil.js';

/** Root of the bundled templates. */
export const TEMPLATES_DIR = fileURLToPath(new URL('../templates/', import.meta.url));

/** Product kinds `init` can generate. */
export const INIT_KINDS = Object.freeze(/** @type {const} */ (['service', 'pack']));

/**
 * @typedef {object} InitOptions
 * @property {string} dir target directory (created; must be empty or absent)
 * @property {'service' | 'pack'} kind
 * @property {string} slug product slug (SSPS slug pattern)
 * @property {string} name display name (1–80 chars)
 * @property {string} [sdkVersion] version range for `@ss/*` dependencies (default `workspace:*`)
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
export const checkInitOptions = ({ dir, kind, slug, name }) => {
	/** @type {string[]} */
	const errors = [];
	if (typeof dir !== 'string' || dir.length === 0) errors.push('a target directory is required');
	if (!INIT_KINDS.includes(/** @type {'service' | 'pack'} */ (kind))) errors.push('--kind must be service or pack');
	if (typeof slug !== 'string' || slug.length < 2 || slug.length > 40 || !new RegExp(PATTERNS.slug).test(slug))
		errors.push('--slug must be 2–40 chars of lowercase letters/digits separated by - or _ (e.g. notes-pro)');
	if (typeof name !== 'string' || name.trim().length === 0 || name.length > 80) errors.push('--name must be 1–80 characters');
	else if (/[{}"\\<>\n\r`]/.test(name)) errors.push('--name must not contain { } " \\ < > ` or line breaks');
	return errors;
};

/**
 * Generate a project.
 * @param {InitOptions} options
 * @returns {Promise<{ dir: string, files: string[] }>} files written (relative)
 */
export const initApp = async ({ dir, kind, slug, name, sdkVersion = 'workspace:*', templatesDir = TEMPLATES_DIR }) => {
	const errors = checkInitOptions({ dir, kind, slug, name });
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
	for (const layer of ['shared', kind]) {
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
	return { dir: target, files: [...plan.keys()].sort() };
};
