/**
 * `ss app validate` — checks a product against the product standard (PLAN 0.4.13, 0.11, F.17, F.19):
 *
 * - the layout: the folders `core/ api/ adapters/ ui/ app/ strings/ schemas/ tests/ docs/` and the files every product
 *   needs (`anatomy.missing`);
 * - `manifest.json` (local `$ref`s bundled) against `@ss/contracts` `validateManifest` (`manifest.*`);
 * - the routes in `api/`: every route has a valid auth, every browser-token, server-token and ticket route belongs to
 *   a feature of the manifest, permissions exist, and the widget script and the docs are public routes
 *   (`routes.*`);
 * - `strings/en.json`, the only widget-text file: flat keys, text values, well-formed `{placeholders}`, and every
 *   `t('key')` used in the code exists (`strings.*`);
 * - `.env.example` lists exactly `MONGODB_URI`, `CONNECT_SECRET`, `ENCRYPTION_KEY` (`env.example`), and `vercel.json`
 *   declares no crons (`vercel.crons`);
 * - import direction: api → core | adapters, adapters → core, ui → core, app → api | adapters | core | strings, never
 *   the reverse; core stays pure and DOM-free; no import leaves the product folder (`imports.*`, `core.dom`);
 * - package wiring: the kit and the tooling are dependencies, the standard scripts exist, and every imported package
 *   is listed in package.json (`package.*`);
 * - the deployment shape (at most two server functions: the API route and the dashboard page) and the generated files
 *   (`openapi.json`, `api/widget-script.js`) being up to date (`server.*`, `assets.*`).
 * @module
 */
import { builtinModules } from 'node:module';
import path from 'node:path';
import { validateManifest } from '@ss/contracts';
import { isObject, parseJson } from '../fsutil.js';
import { loadManifest, problemOf } from '../manifest.js';
import { OPENAPI_FILE, WIDGET_ENTRY, assetStates } from '../assets.js';
import { projectFiles } from '../project.js';
import { scanRoutes } from '../routes.js';
import { findCssReferences, findDomGlobals, findImports, findStringKeys, lex } from './scan.js';

/** @typedef {import('../manifest.js').Problem} Problem */
/** @typedef {import('../project.js').ProjectFiles} ProjectFiles */
/** @typedef {import('../routes.js').ScannedRoute} ScannedRoute */
/** @typedef {import('@ss/contracts').Manifest} Manifest */

/** Folders (ending with `/`) and files every product has (PLAN 0.4.13, F.17). */
export const ANATOMY = Object.freeze([
	'core/',
	'api/',
	'adapters/',
	'ui/',
	'app/',
	'strings/',
	'schemas/',
	'tests/',
	'docs/',
	'manifest.json',
	'package.json',
	'README.md',
	'openapi.json',
	'strings/en.json',
	'.env.example',
	'.gitignore',
	'vercel.json',
	'next.config.js',
	'app/api/[...path]/route.js',
	'app/dashboard/page.js',
]);

/** The variables a product reads, and the only names its `.env.example` lists (PLAN 0.11). */
export const ENV_NAMES = Object.freeze(['MONGODB_URI', 'CONNECT_SECRET', 'ENCRYPTION_KEY']);

/** Marker for project-root files (e.g. `manifest.json`) as import targets. */
const ROOT = '.';

/** Folders holding data files (JSON) that code may import as data: texts, settings schemas, docs and root files. */
const DATA_LAYERS = Object.freeze(['strings', 'schemas', 'docs', ROOT]);

/**
 * Import direction per layer: the layers a file may import code from, whether it may import data files (`.json` in
 * strings/, schemas/, docs/ or the root) and the packages it may use (`null` = any listed package). An entry with a
 * subpath (`@ss/app-kit/widget`) admits exactly that subpath, a bare name the whole package. `core/` is pure logic;
 * `ui/` is bundled into the browser script.
 * @type {Readonly<Record<string, { layers: readonly string[], data: boolean, packages: readonly string[] | null }>>}
 */
export const IMPORT_POLICY = Object.freeze({
	core: { layers: ['core'], data: false, packages: ['@ss/contracts', '@ss/rules'] },
	api: { layers: ['api', 'core', 'adapters'], data: true, packages: null },
	adapters: { layers: ['adapters', 'core'], data: true, packages: null },
	ui: { layers: ['ui', 'core'], data: false, packages: ['@ss/app-kit/widget', '@ss/web'] },
	app: { layers: ['app', 'api', 'adapters', 'core', 'strings'], data: true, packages: null },
});

/** Auth modes of `defineRoute`. */
const AUTH_MODES = Object.freeze(['browser', 'server', 'ticket', 'dashboard', 'none']);
/** Auth modes of website routes, which belong to exactly one feature. */
const WEBSITE_AUTH = Object.freeze(['browser', 'server', 'ticket']);

const CODE_FILE = /\.(?:m?js|cjs|jsx)$/;
const CSS_FILE = /\.css$/;
const STRING_KEY = /^[A-Za-z][\w.-]*$/;
const BRACES = /[{}]/g;
const PLACEHOLDER = /\{[A-Za-z][A-Za-z0-9_]{0,63}\}/g;
const ENV_LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
const BUILTINS = new Set(builtinModules);

/**
 * Layer of a project-relative path (`core`, `ui`, …, `.` for root files).
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
 * @param {ProjectFiles} files
 * @param {string} entry `dir/` or a file
 * @returns {boolean}
 */
const present = (files, entry) =>
	entry.endsWith('/') ? files.list.some((file) => file.startsWith(entry)) : files.set.has(entry);

/**
 * The layout every product has.
 * @param {ProjectFiles} files
 * @returns {Problem[]}
 */
export const checkAnatomy = (files) =>
	ANATOMY.filter((entry) => !present(files, entry)).map((entry) =>
		problemOf({
			rule: 'anatomy.missing',
			file: entry,
			message: `${entry.endsWith('/') ? 'folder' : 'file'} '${entry}' is required`,
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

/** @param {string} layer */
const layerName = (layer) => (layer === ROOT ? 'the project root' : `${layer}/`);

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
				const data = policy.data && target.endsWith('.json') && DATA_LAYERS.includes(targetLayer);
				if (!policy.layers.includes(targetLayer) && !data) {
					problems.push(
						problemOf({
							rule: 'imports.direction',
							file,
							line,
							message: `${layer}/ must not import from ${layerName(targetLayer)} ('${specifier}'); allowed: ${[
								...policy.layers.map(layerName),
								...(policy.data ? ['JSON data in strings/, schemas/, docs/ and the root'] : []),
							].join(', ')}`,
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
 * `core/` is pure logic: no DOM globals.
 * @param {ProjectFiles} files
 * @returns {Promise<Problem[]>}
 */
export const checkCorePure = async (files) => {
	/** @type {Problem[]} */
	const problems = [];
	for (const file of files.list) {
		if (layerOf(file) !== 'core' || !CODE_FILE.test(file)) continue;
		for (const { name, line } of findDomGlobals(lex(await files.read(file))))
			problems.push(problemOf({ rule: 'core.dom', file, line, message: `'${name}' is a DOM global; core/ is pure logic` }));
	}
	return problems;
};

/**
 * Placeholders of a text: well-formed `{name}` only; any other brace is a problem.
 * @param {string} text
 * @returns {boolean}
 */
const placeholdersWellFormed = (text) => text.replace(PLACEHOLDER, '').match(BRACES) === null;

/**
 * Widget texts (PLAN 0.4.10): `strings/en.json` is the only file, a flat object of texts with well-formed
 * `{placeholders}`; every `t('key')` the code uses exists in it.
 * @param {ProjectFiles} files
 * @returns {Promise<Problem[]>}
 */
export const checkStrings = async (files) => {
	/** @type {Problem[]} */
	const problems = [];
	for (const file of files.list.filter((name) => name.startsWith('strings/') && name !== 'strings/en.json')) {
		problems.push(
			problemOf({
				rule: 'strings.file',
				file,
				message: 'strings/en.json is the only text file: merchants change or translate texts per website in Settings → Texts',
			}),
		);
	}
	if (!files.set.has('strings/en.json')) return problems;
	const file = 'strings/en.json';
	const parsed = parseJson(await files.read(file));
	if (!parsed.ok || !isObject(parsed.value)) {
		problems.push(
			problemOf({ rule: 'strings.invalid', file, message: parsed.ok ? 'texts must be a JSON object' : parsed.message }),
		);
		return problems;
	}
	const known = new Set();
	for (const [key, value] of Object.entries(parsed.value)) {
		if (!STRING_KEY.test(key) || typeof value !== 'string') {
			problems.push(
				problemOf({
					rule: 'strings.invalid',
					file,
					pointer: `/${key}`,
					message: `'${key}' must be a text with a simple key`,
				}),
			);
			continue;
		}
		known.add(key);
		if (!placeholdersWellFormed(value)) {
			problems.push(
				problemOf({
					rule: 'strings.placeholders',
					file,
					pointer: `/${key}`,
					message: `'${key}' has a brace that is not a placeholder: write placeholders as {name} (letters, digits, _)`,
				}),
			);
		}
	}
	for (const source of files.list) {
		if (!['core', 'api', 'adapters', 'ui', 'app'].includes(layerOf(source)) || !CODE_FILE.test(source)) continue;
		for (const { key, line } of findStringKeys(lex(await files.read(source)))) {
			if (!known.has(key))
				problems.push(
					problemOf({ rule: 'strings.unknown-key', file: source, line, message: `text '${key}' is not in strings/en.json` }),
				);
		}
	}
	return problems;
};

/**
 * `.env.example` lists exactly the three variables a product reads (PLAN 0.11).
 * @param {ProjectFiles} files
 * @returns {Promise<Problem[]>}
 */
export const checkEnvExample = async (files) => {
	if (!files.set.has('.env.example')) return [];
	const names = (await files.read('.env.example'))
		.split('\n')
		.map((line) => ENV_LINE.exec(line.trim())?.[1])
		.filter((name) => name !== undefined);
	const same = names.length === ENV_NAMES.length && ENV_NAMES.every((name) => names.includes(name));
	return same
		? []
		: [
				problemOf({
					rule: 'env.example',
					file: '.env.example',
					message: `must list exactly ${ENV_NAMES.join(', ')} (found: ${names.join(', ') || 'none'})`,
				}),
			];
};

/**
 * `vercel.json` declares no crons (PLAN F.19: no scheduled or background work). Work happens on the request that
 * causes it, on read, or from a dashboard button.
 * @param {ProjectFiles} files
 * @returns {Promise<Problem[]>}
 */
export const checkCrons = async (files) => {
	if (!files.set.has('vercel.json')) return [];
	const parsed = parseJson(await files.read('vercel.json'));
	const config = parsed.ok ? parsed.value : null;
	if (!isObject(config) || !Object.hasOwn(config, 'crons')) return [];
	return [
		problemOf({
			rule: 'vercel.crons',
			file: 'vercel.json',
			pointer: '/crons',
			message:
				'crons are not allowed: run work on the request that causes it, treat expiries on read, or add a dashboard button',
		}),
	];
};

/**
 * Routes ↔ manifest: valid auth; every website route (browser, server, ticket) belongs to a feature of the manifest,
 * through `feature` or its ticket `permission`; the widget script (one public script for every website, PLAN 0.4.10)
 * and the docs are public routes.
 * @param {readonly ScannedRoute[]} routes
 * @param {Manifest} manifest
 * @returns {Problem[]}
 */
export const checkRoutes = (routes, manifest) => {
	/** @type {Problem[]} */
	const problems = [];
	const features = new Set(manifest.features.map((feature) => feature.key));
	const permissions = new Set(manifest.permissions.map((permission) => permission.key));
	for (const route of routes) {
		const where = { file: route.file, line: route.line };
		const name = `${route.method} ${route.path}`;
		if (!AUTH_MODES.includes(route.auth)) {
			problems.push(
				problemOf({ rule: 'routes.auth', ...where, message: `${name}: auth must be one of ${AUTH_MODES.join(', ')}` }),
			);
			continue;
		}
		if (route.feature !== undefined && !features.has(route.feature))
			problems.push(
				problemOf({
					rule: 'routes.feature',
					...where,
					message: `${name}: feature '${route.feature}' is not in manifest.json`,
				}),
			);
		if (route.permission !== undefined && !permissions.has(route.permission))
			problems.push(
				problemOf({
					rule: 'routes.permission',
					...where,
					message: `${name}: permission '${route.permission}' is not in manifest.json`,
				}),
			);
		if (WEBSITE_AUTH.includes(route.auth) && route.feature === undefined && route.permission === undefined)
			problems.push(
				problemOf({
					rule: 'routes.feature',
					...where,
					message: `${name}: every ${route.auth} route belongs to one feature (set feature${route.auth === 'ticket' ? ' or permission' : ''})`,
				}),
			);
	}
	/** @param {string} where */
	const publicRoute = (where) => routes.some((route) => route.method === 'GET' && route.path === where && route.auth === 'none');
	const script = manifest.widgetScriptUrl;
	if (script !== null && script.startsWith('/') && !publicRoute(script))
		problems.push(
			problemOf({
				rule: 'routes.widget-script',
				file: 'api/',
				message: `widgetScriptUrl is ${script}: serve the widgets' script publicly with a GET ${script} route (auth none, the same for every website)`,
			}),
		);
	const docs = manifest.docsUrl;
	if (docs.startsWith('/') && !publicRoute(docs))
		problems.push(
			problemOf({
				rule: 'routes.docs',
				file: 'api/',
				message: `docsUrl is ${docs}: serve the docs publicly with a GET ${docs} route (auth none)`,
			}),
		);
	return problems;
};

/**
 * package.json wiring every product needs to work on its own (in the monorepo and once split into its own repository):
 * the kit it is built on, its tooling (`@ss/cli`, `@ss/config`) and its scripts (F.17).
 */
export const PACKAGE_WIRING = Object.freeze({
	dependencies: Object.freeze(['@ss/app-kit']),
	devDependencies: Object.freeze(['@ss/cli', '@ss/config']),
	scripts: Object.freeze(['check', 'test', 'lint', 'typecheck', 'format', 'format:check', 'dev', 'build', 'start', 'validate']),
});

/**
 * package.json wiring: required dependencies and imported packages (errors), tooling dev dependencies and scripts
 * (warnings).
 * @param {ProjectFiles} files
 * @returns {Promise<Problem[]>}
 */
export const checkPackageWiring = async (files) => {
	if (!files.set.has('package.json')) return [];
	const parsed = parseJson(await files.read('package.json'));
	const pkg = parsed.ok && isObject(parsed.value) ? parsed.value : {};
	/** @param {unknown} value */
	const keys = (value) => (isObject(value) ? value : {});
	const deps = keys(pkg.dependencies);
	const devDeps = keys(pkg.devDependencies);
	const scripts = keys(pkg.scripts);
	const listed = new Set([
		...Object.keys(deps),
		...Object.keys(devDeps),
		...Object.keys(keys(pkg.peerDependencies)),
		...Object.keys(keys(pkg.optionalDependencies)),
		...(typeof pkg.name === 'string' ? [pkg.name] : []),
	]);
	/** @type {Problem[]} */
	const problems = [
		...PACKAGE_WIRING.dependencies
			.filter((name) => !Object.hasOwn(deps, name))
			.map((name) =>
				problemOf({ rule: 'package.dependency', file: 'package.json', message: `dependencies must include '${name}'` }),
			),
		...PACKAGE_WIRING.devDependencies
			.filter((name) => !Object.hasOwn(devDeps, name) && !Object.hasOwn(deps, name))
			.map((name) =>
				problemOf({
					severity: 'warning',
					rule: 'package.devDependency',
					file: 'package.json',
					message: `devDependencies should include '${name}'`,
				}),
			),
		...PACKAGE_WIRING.scripts
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
	for (const file of files.list) {
		if (!CODE_FILE.test(file)) continue;
		for (const { specifier, line } of findImports(lex(await files.read(file)))) {
			if (specifier.startsWith('.') || specifier.startsWith('node:') || BUILTINS.has(specifier)) continue;
			const name = packageOf(specifier);
			if (!listed.has(name))
				problems.push(
					problemOf({
						rule: 'package.missing',
						file,
						line,
						message: `'${name}' is imported but not listed in package.json (a unit imports only the packages it lists)`,
					}),
				);
		}
	}
	return problems;
};

/** Server functions a product has: the API route handler and the dashboard page (PLAN 0.9, Vercel Hobby). */
export const MAX_SERVER_ENTRIES = 2;

const ROUTE_FILE = /^(?:src\/)?app\/(?:.*\/)?route\.(?:m?js|jsx|ts|tsx)$/;
const PAGE_FILE = /^(?:src\/)?app\/(?:.*\/)?page\.(?:m?js|jsx|ts|tsx)$/;
const PROXY_FILE = /^(?:src\/)?(?:proxy|middleware)\.(?:m?js|ts)$/;
const DYNAMIC_PAGE = /force-dynamic|searchParams|\bparams\b|\bcookies\(|\bheaders\(|\bconnection\(|\bdraftMode\(/;
const NEXT_CONFIG = /^next\.config\.(?:m?js|cjs|ts)$/;

/**
 * Server entry points of a Next.js app: every route handler, every dynamic page (a dynamic segment or request data)
 * and the proxy (middleware). Static pages are prerendered and need no function.
 * @param {ProjectFiles} files
 * @returns {Promise<string[]>}
 */
export const serverEntries = async (files) => {
	/** @type {string[]} */
	const entries = [];
	for (const file of files.list) {
		if (ROUTE_FILE.test(file) || PROXY_FILE.test(file)) entries.push(file);
		else if (PAGE_FILE.test(file) && (file.includes('[') || DYNAMIC_PAGE.test(await files.read(file)))) entries.push(file);
	}
	return entries;
};

/**
 * Deployment shape: at most {@link MAX_SERVER_ENTRIES} server entry points (the route handler behind next.config.js
 * rewrites and the dashboard page; no proxy) and no `outputFileTracingIncludes` (runtime files are imported as
 * modules).
 * @param {ProjectFiles} files
 * @returns {Promise<Problem[]>}
 */
export const checkServerShape = async (files) => {
	/** @type {Problem[]} */
	const problems = [];
	const entries = await serverEntries(files);
	if (entries.length > MAX_SERVER_ENTRIES) {
		problems.push(
			problemOf({
				rule: 'server.entries',
				file: 'app/',
				message: `${entries.length} server entry points (at most ${MAX_SERVER_ENTRIES}: app/api/[...path]/route.js behind next.config.js rewrites and the dashboard page; no proxy): ${entries.join(', ')}`,
			}),
		);
	}
	for (const file of files.list.filter((name) => NEXT_CONFIG.test(name))) {
		if ((await files.read(file)).includes('outputFileTracingIncludes')) {
			problems.push(
				problemOf({
					rule: 'server.tracing',
					file,
					message: 'outputFileTracingIncludes is not allowed: import runtime files as modules',
				}),
			);
		}
	}
	return problems;
};

/**
 * The generated files (`openapi.json`, `api/widget-script.js`) match the sources.
 * @param {ProjectFiles} files
 * @param {Manifest | null} manifest
 * @returns {Promise<Problem[]>}
 */
export const checkAssets = async (files, manifest) => {
	if (manifest !== null && manifest.widgets.length > 0 && !files.set.has(WIDGET_ENTRY))
		return [
			problemOf({
				rule: 'assets.widget',
				file: WIDGET_ENTRY,
				message: `the manifest has widgets: ${WIDGET_ENTRY} (default export: start the widgets with their config) is required`,
			}),
		];
	try {
		return (await assetStates(files.dir))
			.filter((state) => !state.upToDate)
			.map((state) =>
				problemOf({
					rule: state.file === OPENAPI_FILE ? 'assets.openapi' : 'assets.widget',
					file: state.file,
					message: 'out of date with the sources: run ss app assets',
				}),
			);
	} catch (error) {
		return [
			problemOf({
				rule: 'assets.widget',
				file: WIDGET_ENTRY,
				message: `the widgets cannot be bundled: ${/** @type {Error} */ (error).message.split('\n')[0]}`,
			}),
		];
	}
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
		}
	}
	const scanned = await scanRoutes(files);
	problems.push(
		...checkAnatomy(files),
		...(await checkImports(files)),
		...(await checkCorePure(files)),
		...(await checkStrings(files)),
		...(await checkEnvExample(files)),
		...(await checkCrons(files)),
		...scanned.problems,
		...(manifest === null ? [] : checkRoutes(scanned.routes, manifest)),
		...(await checkPackageWiring(files)),
		...(await checkServerShape(files)),
		...(await checkAssets(files, manifest)),
	);
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
