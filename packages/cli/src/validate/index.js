/**
 * `ss app validate` — manifest (schema + semantics, with local `$ref`s bundled), anatomy (Part E §2), manifest ↔ code
 * consistency (headless/renderer modules and exports, strings, OpenAPI resources), import direction
 * (`ui → headless → core`, `api → core`), no DOM globals in `headless/` and `core/`, no hard-coded colours in `ui/`,
 * string keys that exist in the catalog, and a budget estimate for Mode A renderers.
 * @module
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { validateManifest } from '@ss/contracts';
import { isObject, parseJson, walk } from '../fsutil.js';
import { loadManifest, problemOf } from '../manifest.js';
import {
	colourLiterals,
	findColours,
	findCssReferences,
	findDomGlobals,
	findExports,
	findImports,
	findStringKeys,
	lex,
} from './scan.js';

/** @typedef {import('../manifest.js').Problem} Problem */
/** @typedef {import('@ss/contracts').Manifest} Manifest */

/** Files and folders every project needs; folders end with `/`. */
export const ANATOMY = Object.freeze({
	common: Object.freeze([
		'manifest.json',
		'package.json',
		'README.md',
		'core/',
		'headless/',
		'ui/',
		'strings/en.json',
		'schemas/',
		'tests/',
	]),
	service: Object.freeze([
		'openapi.json',
		'api/',
		'adapters/',
		'jobs/',
		'.env.example',
		'vercel.json',
		'app/.well-known/ss-register/route.js',
		'app/.well-known/ss-events/route.js',
		'app/.well-known/ss-app.json/route.js',
		'app/api/v1/[...route]/route.js',
		'app/dashboard/page.js',
	]),
	pack: Object.freeze([]),
});

/** Marker for project-root files (e.g. `manifest.json`) as import targets. */
const ROOT = '.';

/**
 * Import-direction policy per layer: the layers a file may import from and the bare packages it may use
 * (`null` = any package). An entry with a subpath (`@ss/web/element`) admits exactly that subpath, a bare name the whole
 * package. `core/` is pure (no I/O, no framework); `headless/` builds on `core/` and may use the headless element runtime
 * `@ss/web/element` (no DOM); `ui/` only on `headless/`.
 * @type {Readonly<Record<string, { layers: readonly string[], packages: readonly string[] | null }>>}
 */
export const IMPORT_POLICY = Object.freeze({
	core: { layers: ['core'], packages: ['@ss/rules', '@ss/contracts'] },
	headless: {
		layers: ['headless', 'core', 'strings', 'schemas'],
		packages: ['@ss/rules', '@ss/contracts', '@ss/web/element'],
	},
	ui: { layers: ['ui', 'headless', 'strings'], packages: ['@ss/web', '@ss/ui'] },
	api: { layers: ['api', 'core', 'adapters', 'strings', 'schemas'], packages: null },
	adapters: { layers: ['adapters', 'core', 'schemas', 'strings', ROOT], packages: null },
	jobs: { layers: ['jobs', 'core', 'adapters'], packages: null },
});

const CODE_FILE = /\.(?:m?js|cjs|jsx)$/;
const CSS_FILE = /\.css$/;
const UI_FILE = /\.(?:m?js|jsx|css|html)$/;
const STRING_KEY = /^[A-Za-z][\w.-]*$/;
const PLACEHOLDER = /\{([A-Za-z_]\w*)\}/g;
const LANGUAGE_FILE = /^strings\/([a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)\.json$/;

/**
 * Layer of a project-relative path (`core`, `ui`, …, `.` for root files, `''` for others).
 * @param {string} relative
 * @returns {string}
 */
export const layerOf = (relative) => (relative.includes('/') ? (relative.split('/')[0] ?? '') : ROOT);

/**
 * Resolve a relative import to a project file.
 * @param {string} from importing file (project-relative)
 * @param {string} specifier
 * @param {ReadonlySet<string>} files
 * @returns {{ inside: boolean, target: string | null }}
 */
export const resolveImport = (from, specifier, files) => {
	const joined = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
	if (joined.startsWith('..') || path.posix.isAbsolute(joined)) return { inside: false, target: null };
	for (const candidate of [joined, `${joined}.js`, `${joined}.mjs`, `${joined}/index.js`]) {
		if (files.has(candidate)) return { inside: true, target: candidate };
	}
	return { inside: true, target: null };
};

/**
 * Package name of a bare specifier (`@scope/name/sub` → `@scope/name`, `node:fs` → `node:fs`).
 * @param {string} specifier
 * @returns {string}
 */
export const packageOf = (specifier) => {
	if (specifier.startsWith('node:')) return specifier;
	const parts = specifier.split('/');
	return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
};

/**
 * @param {string} text
 * @returns {string[]}
 */
const placeholders = (text) => [...new Set([...text.matchAll(PLACEHOLDER)].map((match) => match[1] ?? ''))].sort();

/**
 * @typedef {object} ProjectFiles
 * @property {string} dir
 * @property {string[]} list
 * @property {Set<string>} set
 * @property {(relative: string) => Promise<string>} read cached text reader
 */

/**
 * @param {string} dir
 * @returns {Promise<ProjectFiles>}
 */
const projectFiles = async (dir) => {
	const list = await walk(dir);
	/** @type {Map<string, Promise<string>>} */
	const cache = new Map();
	return {
		dir,
		list,
		set: new Set(list),
		read: (relative) => {
			let text = cache.get(relative);
			if (text === undefined) {
				text = readFile(path.join(dir, relative), 'utf8');
				cache.set(relative, text);
			}
			return text;
		},
	};
};

/**
 * @param {ProjectFiles} files
 * @param {string} entry `dir/` or a file
 * @returns {boolean}
 */
const present = (files, entry) =>
	entry.endsWith('/') ? files.list.some((file) => file.startsWith(entry)) : files.set.has(entry);

/**
 * Anatomy check.
 * @param {ProjectFiles} files
 * @param {'service' | 'pack' | null} kind
 * @returns {Problem[]}
 */
export const checkAnatomy = (files, kind) =>
	[...ANATOMY.common, ...(kind === null ? [] : ANATOMY[kind])]
		.filter((entry) => !present(files, entry))
		.map((entry) =>
			problemOf({
				rule: 'anatomy.missing',
				file: entry,
				message: `${entry.endsWith('/') ? 'folder' : 'file'} '${entry}' is required${kind ? ` for ${kind} products` : ''}`,
			}),
		);

/**
 * @param {string} file
 * @param {number} line
 * @param {string} specifier
 * @returns {Problem}
 */
const outside = (file, line, specifier) =>
	problemOf({
		rule: 'imports.outside',
		file,
		line,
		message: `'${specifier}' points outside the project (a project is its own repository: use a package import)`,
	});

/**
 * Imports of every source file and stylesheet stay inside the project (tests, app/ and root files included: the
 * project must build on its own once split into its own repository). Layered files are also checked for import
 * direction, allowed packages and unresolved relative imports.
 * @param {ProjectFiles} files
 * @returns {Promise<Problem[]>}
 */
export const checkImports = async (files) => {
	/** @type {Problem[]} */
	const problems = [];
	for (const file of files.list) {
		if (CSS_FILE.test(file)) {
			for (const { specifier, line } of findCssReferences(await files.read(file)))
				if (specifier.startsWith('.') && !resolveImport(file, specifier, files.set).inside)
					problems.push(outside(file, line, specifier));
			continue;
		}
		if (!CODE_FILE.test(file)) continue;
		const layer = layerOf(file);
		const policy = Object.hasOwn(IMPORT_POLICY, layer) ? IMPORT_POLICY[layer] : undefined;
		for (const { specifier, line } of findImports(lex(await files.read(file)))) {
			if (specifier.startsWith('.')) {
				const { inside, target } = resolveImport(file, specifier, files.set);
				if (!inside) {
					problems.push(outside(file, line, specifier));
					continue;
				}
				if (policy === undefined) continue;
				if (target === null) {
					problems.push(problemOf({ rule: 'imports.unresolved', file, line, message: `cannot resolve '${specifier}'` }));
					continue;
				}
				const targetLayer = layerOf(target);
				if (!policy.layers.includes(targetLayer)) {
					problems.push(
						problemOf({
							rule: 'imports.direction',
							file,
							line,
							message: `${layer}/ must not import from ${targetLayer === ROOT ? 'the project root' : `${targetLayer}/`} ('${specifier}'); allowed: ${policy.layers.map((name) => (name === ROOT ? 'root' : `${name}/`)).join(', ')}`,
						}),
					);
				}
			} else if (
				policy !== undefined &&
				policy.packages !== null &&
				!policy.packages.includes(packageOf(specifier)) &&
				!policy.packages.includes(specifier)
			) {
				problems.push(
					problemOf({
						rule: 'imports.package',
						file,
						line,
						message: `${layer}/ must not import '${specifier}'${policy.packages.length > 0 ? `; allowed packages: ${policy.packages.join(', ')}` : ''}`,
					}),
				);
			}
		}
	}
	return problems;
};

/**
 * No DOM globals in `core/` and `headless/`.
 * @param {ProjectFiles} files
 * @returns {Promise<Problem[]>}
 */
export const checkDomFree = async (files) => {
	/** @type {Problem[]} */
	const problems = [];
	for (const file of files.list) {
		const layer = layerOf(file);
		if ((layer !== 'core' && layer !== 'headless') || !CODE_FILE.test(file)) continue;
		for (const { name, line } of findDomGlobals(lex(await files.read(file)))) {
			problems.push(
				problemOf({ rule: 'headless.dom', file, line, message: `'${name}' is a DOM global; ${layer}/ must stay DOM-free` }),
			);
		}
	}
	return problems;
};

/**
 * No hard-coded colours in `ui/` (design tokens only). `ui/tokens.*` may define token fallbacks.
 * @param {ProjectFiles} files
 * @returns {Promise<Problem[]>}
 */
export const checkColours = async (files) => {
	/** @type {Problem[]} */
	const problems = [];
	for (const file of files.list) {
		if (layerOf(file) !== 'ui' || !UI_FILE.test(file) || /^ui\/(?:.*\/)?tokens\.[a-z]+$/.test(file)) continue;
		const text = await files.read(file);
		const found = CODE_FILE.test(file)
			? findColours(lex(text))
			: colourLiterals(text.replace(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ' '))).map(
					({ value, index }) => ({ value, line: text.slice(0, index).split('\n').length }),
				);
		for (const { value, line } of found) {
			problems.push(
				problemOf({
					rule: 'ui.colour',
					file,
					line,
					message: `hard-coded colour '${value}'; use design tokens (var(--ss-…))`,
				}),
			);
		}
	}
	return problems;
};

/**
 * @typedef {object} Catalogs
 * @property {Map<string, Record<string, string>>} byFile valid catalogs by file
 * @property {Problem[]} problems
 */

/**
 * Load and check every `strings/*.json` catalog.
 * @param {ProjectFiles} files
 * @returns {Promise<Catalogs>}
 */
const loadCatalogs = async (files) => {
	/** @type {Problem[]} */
	const problems = [];
	/** @type {Map<string, Record<string, string>>} */
	const byFile = new Map();
	for (const file of files.list.filter((name) => /^strings\/[^/]+\.json$/.test(name))) {
		const parsed = parseJson(await files.read(file));
		if (!parsed.ok || !isObject(parsed.value)) {
			problems.push(
				problemOf({ rule: 'strings.invalid', file, message: parsed.ok ? 'catalog must be a JSON object' : parsed.message }),
			);
			continue;
		}
		/** @type {Record<string, string>} */
		const catalog = {};
		for (const [key, value] of Object.entries(parsed.value)) {
			if (!STRING_KEY.test(key) || typeof value !== 'string') {
				problems.push(
					problemOf({
						rule: 'strings.invalid',
						file,
						pointer: `/${key}`,
						message: `'${key}' must be a string entry with a simple key`,
					}),
				);
			} else catalog[key] = value;
		}
		byFile.set(file, catalog);
	}
	const base = byFile.get('strings/en.json');
	if (base !== undefined) {
		for (const [file, catalog] of byFile) {
			if (file === 'strings/en.json' || !LANGUAGE_FILE.test(file)) continue;
			for (const [key, value] of Object.entries(catalog)) {
				const source = base[key];
				if (source === undefined) {
					problems.push(
						problemOf({
							severity: 'warning',
							rule: 'strings.extra-key',
							file,
							pointer: `/${key}`,
							message: `'${key}' is not in strings/en.json`,
						}),
					);
				} else if (placeholders(source).join() !== placeholders(value).join()) {
					problems.push(
						problemOf({
							rule: 'strings.placeholders',
							file,
							pointer: `/${key}`,
							message: `placeholders {${placeholders(value).join('}, {')}} differ from strings/en.json {${placeholders(source).join('}, {')}}`,
						}),
					);
				}
			}
		}
	}
	return { byFile, problems };
};

/**
 * Keys referenced through `t('key')` must exist in the default catalog(s).
 * @param {ProjectFiles} files
 * @param {Catalogs} catalogs
 * @param {readonly string[]} catalogFiles default-language catalogs referenced by the manifest (fallback `strings/en.json`)
 * @returns {Promise<Problem[]>}
 */
export const checkStringKeys = async (files, catalogs, catalogFiles) => {
	/** @type {Set<string>} */
	const known = new Set();
	for (const file of catalogFiles) for (const key of Object.keys(catalogs.byFile.get(file) ?? {})) known.add(key);
	/** @type {Problem[]} */
	const problems = [];
	for (const file of files.list) {
		if (!['core', 'headless', 'ui', 'api', 'app', 'jobs', 'adapters'].includes(layerOf(file)) || !CODE_FILE.test(file))
			continue;
		for (const { key, line } of findStringKeys(lex(await files.read(file)))) {
			if (!known.has(key)) {
				problems.push(
					problemOf({
						rule: 'strings.unknown-key',
						file,
						line,
						message: `string '${key}' is not in ${catalogFiles.join(', ')}`,
					}),
				);
			}
		}
	}
	return problems;
};

/**
 * Relative import closure of a module (for the budget estimate).
 * @param {ProjectFiles} files
 * @param {string} entry
 * @returns {Promise<string[]>}
 */
const importClosure = async (files, entry) => {
	/** @type {Set<string>} */
	const seen = new Set();
	/** @param {string} file */
	const visit = async (file) => {
		if (seen.has(file)) return;
		seen.add(file);
		if (!CODE_FILE.test(file)) return;
		for (const { specifier } of findImports(lex(await files.read(file)))) {
			if (!specifier.startsWith('.')) continue;
			const { target } = resolveImport(file, specifier, files.set);
			if (target !== null) await visit(target);
		}
	};
	await visit(entry);
	return [...seen];
};

/**
 * Manifest ↔ code: headless/renderer module refs, exports, strings files and the Mode A budget estimate.
 * @param {ProjectFiles} files
 * @param {Manifest} manifest
 * @returns {Promise<Problem[]>}
 */
export const checkModules = async (files, manifest) => {
	/** @type {Problem[]} */
	const problems = [];
	for (const [index, element] of manifest.elements.entries()) {
		for (const field of /** @type {const} */ (['headless', 'renderer'])) {
			const ref = element[field];
			if (typeof ref !== 'string') continue;
			const [file = '', name = ''] = ref.split('#');
			const pointer = `/elements/${index}/${field}`;
			if (!files.set.has(file)) {
				problems.push(
					problemOf({
						rule: 'module.missing',
						file: 'manifest.json',
						pointer,
						message: `${field} module '${file}' does not exist`,
					}),
				);
				continue;
			}
			const expected = field === 'headless' ? 'headless/' : 'ui/';
			if (!file.startsWith(expected)) {
				problems.push(
					problemOf({
						rule: 'module.layer',
						file: 'manifest.json',
						pointer,
						message: `${field} module must live in ${expected}`,
					}),
				);
			}
			if (!findExports(lex(await files.read(file))).has(name)) {
				problems.push(
					problemOf({ rule: 'module.export', file, message: `'${name}' is not exported (referenced by ${pointer})` }),
				);
			}
			if (field === 'renderer' && typeof element.budget?.js === 'number' && element.budget.js > 0) {
				const closure = await importClosure(files, file);
				const bytes = (await Promise.all(closure.map((member) => files.read(member)))).reduce(
					(sum, text) => sum + Buffer.byteLength(text),
					0,
				);
				if (bytes > element.budget.js * 1024) {
					problems.push(
						problemOf({
							severity: 'warning',
							rule: 'budget.estimate',
							file,
							message: `renderer source closure is ${(bytes / 1024).toFixed(1)} KB (unminified) against budget.js ${element.budget.js} KB`,
						}),
					);
				}
			}
		}
		if (typeof element.strings === 'string' && !files.set.has(element.strings)) {
			problems.push(
				problemOf({
					rule: 'strings.missing-file',
					file: 'manifest.json',
					pointer: `/elements/${index}/strings`,
					message: `'${element.strings}' does not exist`,
				}),
			);
		}
	}
	return problems;
};

/**
 * Service products: OpenAPI 3.1 document present and documents every Mode C resource.
 * @param {ProjectFiles} files
 * @param {Manifest} manifest
 * @returns {Promise<Problem[]>}
 */
export const checkServiceContract = async (files, manifest) => {
	/** @type {Problem[]} */
	const problems = [];
	if (files.set.has('openapi.json')) {
		const parsed = parseJson(await files.read('openapi.json'));
		const doc = parsed.ok ? parsed.value : null;
		if (!isObject(doc) || typeof doc.openapi !== 'string' || !doc.openapi.startsWith('3.1') || !isObject(doc.paths)) {
			problems.push(
				problemOf({ rule: 'openapi.invalid', file: 'openapi.json', message: 'must be an OpenAPI 3.1 document with paths' }),
			);
		} else {
			const paths = Object.keys(doc.paths);
			for (const [index, element] of manifest.elements.entries()) {
				if (!element.modes.includes('C')) continue;
				for (const resource of element.api?.resources ?? []) {
					if (
						!paths.some(
							(p) => p === `/v1/${resource}` || p.startsWith(`/v1/${resource}/`) || p.startsWith(`/v1/${resource}:`),
						)
					) {
						problems.push(
							problemOf({
								rule: 'openapi.resource',
								file: 'openapi.json',
								message: `resource '${resource}' of element '${element.key}' (/elements/${index}) is not documented under /v1/${resource}`,
							}),
						);
					}
				}
			}
		}
	}
	return problems;
};

/**
 * package.json wiring every project needs to work on its own (in the monorepo and once split into its own repository):
 * the kit it is built on, its tooling (`@ss/cli`, `@ss/config`) and its scripts.
 */
export const PACKAGE_WIRING = Object.freeze({
	service: Object.freeze({
		dependencies: Object.freeze(['@ss/app-kit', '@ss/contracts']),
		devDependencies: Object.freeze(['@ss/cli', '@ss/config']),
		scripts: Object.freeze([
			'dev',
			'build',
			'start',
			'portal',
			'check',
			'test',
			'lint',
			'typecheck',
			'format:check',
			'validate',
			'certify',
		]),
	}),
	pack: Object.freeze({
		dependencies: Object.freeze(['@ss/contracts']),
		devDependencies: Object.freeze(['@ss/cli', '@ss/config']),
		scripts: Object.freeze(['dev', 'check', 'test', 'lint', 'typecheck', 'format:check', 'validate', 'certify']),
	}),
});

/**
 * package.json wiring: required dependencies (errors), tooling dev dependencies and scripts (warnings).
 * @param {ProjectFiles} files
 * @param {'service' | 'pack'} kind
 * @returns {Promise<Problem[]>}
 */
export const checkPackageWiring = async (files, kind) => {
	if (!files.set.has('package.json')) return [];
	const parsed = parseJson(await files.read('package.json'));
	const pkg = parsed.ok && isObject(parsed.value) ? parsed.value : {};
	/** @param {unknown} value */
	const keys = (value) => (isObject(value) ? value : {});
	const wiring = PACKAGE_WIRING[kind];
	const deps = keys(pkg.dependencies);
	const devDeps = keys(pkg.devDependencies);
	const scripts = keys(pkg.scripts);
	return [
		...wiring.dependencies
			.filter((name) => !Object.hasOwn(deps, name))
			.map((name) =>
				problemOf({ rule: 'package.dependency', file: 'package.json', message: `dependencies must include '${name}'` }),
			),
		...wiring.devDependencies
			.filter((name) => !Object.hasOwn(devDeps, name) && !Object.hasOwn(deps, name))
			.map((name) =>
				problemOf({
					severity: 'warning',
					rule: 'package.devDependency',
					file: 'package.json',
					message: `devDependencies should include '${name}'`,
				}),
			),
		...wiring.scripts
			.filter((name) => !Object.hasOwn(scripts, name))
			.map((name) =>
				problemOf({
					severity: 'warning',
					rule: 'package.script',
					file: 'package.json',
					message: `scripts.${name} is missing`,
				}),
			),
	];
};

/**
 * Product events published in the product namespace should ship a data schema at `schemas/events/<type@v>.json`.
 * @param {ProjectFiles} files
 * @param {Manifest} manifest
 * @returns {Problem[]}
 */
export const checkEventSchemas = (files, manifest) => {
	const namespace = `${manifest.product.slug.replace(/-/g, '_')}.`;
	return (manifest.events?.publishes ?? [])
		.filter((type) => type.startsWith(namespace) && !files.set.has(`schemas/events/${type}.json`))
		.map((type) =>
			problemOf({
				severity: 'warning',
				rule: 'events.schema',
				file: `schemas/events/${type}.json`,
				message: `data schema for '${type}' is missing`,
			}),
		);
};

/**
 * @typedef {object} ValidationReport
 * @property {boolean} ok no errors (warnings allowed)
 * @property {string} dir
 * @property {unknown} manifest bundled manifest (null when unreadable)
 * @property {Problem[]} problems sorted by file, line
 * @property {{ errors: number, warnings: number, files: number }} summary
 */

/**
 * Validate a project directory.
 * @param {string} dir
 * @returns {Promise<ValidationReport>}
 */
export const validateProject = async (dir) => {
	const files = await projectFiles(dir);
	const loaded = await loadManifest(dir);
	/** @type {Problem[]} */
	const problems = [...loaded.problems];
	/** @type {Manifest | null} */
	let manifest = null;
	if (loaded.manifest !== null && loaded.ok) {
		const result = validateManifest(loaded.manifest);
		if (result.ok) manifest = result.value;
		else {
			for (const problem of result.problems) {
				problems.push(
					problemOf({
						rule: `manifest.${problem.keyword ?? 'schema'}`,
						file: 'manifest.json',
						pointer: problem.path,
						message: problem.message,
					}),
				);
			}
			if (isObject(loaded.manifest) && Array.isArray(loaded.manifest.elements) && isObject(loaded.manifest.product))
				manifest = /** @type {Manifest} */ (loaded.manifest);
		}
	}
	const rawKind = isObject(loaded.manifest) && isObject(loaded.manifest.product) ? loaded.manifest.product.kind : null;
	const kind = rawKind === 'service' || rawKind === 'pack' ? rawKind : null;
	const catalogs = await loadCatalogs(files);
	const catalogFiles = manifest
		? [...new Set(manifest.elements.map((element) => element.strings).filter((file) => typeof file === 'string'))]
		: [];
	const defaultCatalogs = /** @type {string[]} */ (catalogFiles.length > 0 ? catalogFiles : ['strings/en.json']);
	problems.push(
		...checkAnatomy(files, kind),
		...(await checkImports(files)),
		...(await checkDomFree(files)),
		...(await checkColours(files)),
		...catalogs.problems,
		...(await checkStringKeys(files, catalogs, defaultCatalogs)),
	);
	if (manifest !== null && Array.isArray(manifest.elements)) {
		problems.push(...(await checkModules(files, manifest)), ...checkEventSchemas(files, manifest));
		if (kind === 'service') problems.push(...(await checkServiceContract(files, manifest)));
		if (kind !== null) problems.push(...(await checkPackageWiring(files, kind)));
	}
	problems.sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0) || a.rule.localeCompare(b.rule));
	const errors = problems.filter((problem) => problem.severity === 'error').length;
	return {
		ok: errors === 0,
		dir,
		manifest: loaded.manifest,
		problems,
		summary: { errors, warnings: problems.length - errors, files: files.list.length },
	};
};

/**
 * Human-readable report lines.
 * @param {ValidationReport} report
 * @returns {string}
 */
export const formatValidation = (report) => {
	const lines = report.problems.map((problem) => {
		const where = `${problem.file}${problem.line ? `:${problem.line}` : ''}${problem.pointer ? `#${problem.pointer}` : ''}`;
		return `${problem.severity === 'error' ? 'error  ' : 'warning'}  ${where}  ${problem.rule}  ${problem.message}`;
	});
	lines.push(
		report.ok
			? `✔ valid (${report.summary.warnings} warning${report.summary.warnings === 1 ? '' : 's'}, ${report.summary.files} files)`
			: `✖ ${report.summary.errors} error${report.summary.errors === 1 ? '' : 's'}, ${report.summary.warnings} warning${report.summary.warnings === 1 ? '' : 's'}`,
	);
	return `${lines.join('\n')}\n`;
};
