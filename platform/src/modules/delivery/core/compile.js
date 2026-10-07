/**
 * Website-bundle compiler (pure; PLAN §4.1, §4.5, F.7). The service gathers the inputs (verified entitlement
 * documents, accepted manifests, verified uploaded modules, the website's public key); this module selects the
 * elements, precompiles audience rules, renders the immutable `loader.js`, derives its version from its content and
 * builds `manifest.json`.
 *
 * Selection (per subscription): the signed document must be `runtime.state = active`; an element is delivered when
 * the document enables it **and** its manifest declares mode A. Pack elements ship the headless + renderer modules of
 * the pack version; service-product elements ship the modules of the product's newest ready **widget bundle** (same
 * `ss-pack-bundle@1` format and checks as packs) with their element API client bound to the product's base URL. A
 * service mode-A element without widgets is not delivered (`widgets_missing`). Anything that cannot be delivered is
 * skipped with a warning (fail closed for that element, never for the website).
 *
 * Every element carries its product slug (the Loader id is `<product>:<key>`, so two products may deliver the same
 * key); pack elements get an API base per service product they read (`manifest.reads`) that is active on the website;
 * strings come from the product catalogs `strings/<lang>.json`, sliced per element (`stringKeys`) for the website's
 * language with fallback to `en`, then the merchant's per-website overrides.
 *
 * Determinism: inputs are sorted and embedded as canonical JSON, no timestamps enter the artefact, and the version is
 * the first 16 hex digits of the SHA-256 of the bundle rendered with a zero version — the same inputs always produce
 * the same bytes and the same version.
 * @module
 */
import { createHash } from 'node:crypto';
import { readsOf, validatePlacement } from '@ss/contracts';
import { canonicalJson } from '@ss/protocol';
import { compile as compileRule } from '@ss/rules';
import { sha256Hex, sha384Integrity } from './assets.js';

export const BUNDLE_FORMAT = 'ss-website-bundle@1';
export const VERSION_PATTERN = /^[0-9a-f]{16}$/;
const ZERO_VERSION = '0'.repeat(16);
const MODULE_REF = /^((?!\/)(?!.*\.\.)[A-Za-z0-9_./-]+\.m?js)#([A-Za-z_$][A-Za-z0-9_$]*)$/;
const MAX_STRING_BYTES = 64 * 1024;
/** Product string catalogs (`strings/<lang>.json`). */
export const LANGUAGE_CATALOG = /^strings\/([a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)\.json$/;
export const DEFAULT_LANGUAGE = 'en';

/**
 * @typedef {{ key: string, headless?: unknown, renderer?: unknown, strings?: unknown, stringKeys?: unknown }} ElementModules
 */

/**
 * @typedef {object} Source one subscription
 * @property {string} appId
 * @property {string} slug
 * @property {'pack' | 'service'} kind
 * @property {number} manifestVersion catalog version the subscription is pinned to
 * @property {import('@ss/contracts').Manifest} manifest
 * @property {Record<string, any> | null} document verified entitlement document payload
 * @property {string | null} apiBase service products: the connected base URL (fallback `endpoints.base`)
 * @property {ReadonlyMap<string, { sha256: string, size: number }>} assets uploaded, hash-verified modules by path
 * @property {ReadonlyMap<string, Record<string, unknown>>} strings parsed string catalogs by asset path
 * @property {Widgets | null} [widgets] service products: the newest ready widget bundle (its assets are in `assets`
 *   and `strings`), or null
 */

/**
 * @typedef {object} StringContext what element strings are resolved with
 * @property {string | null} language the website's language (BCP 47), null = `en`
 * @property {ReadonlyMap<string, Readonly<Record<string, Readonly<Record<string, string>>>>>} [overrides] per-website
 *   overrides by `<appId>:<element key>` → language (or `*`) → strings
 */

/**
 * @typedef {object} Widgets a service product's widget bundle
 * @property {number} version widget bundle version (served under `packs/<appId>/<version>/`)
 * @property {ReadonlyMap<string, ElementModules>} elements by element key
 */

/** @typedef {{ code: string, appId?: string, key?: string, detail: string }} Warning */

/**
 * @typedef {object} Selected
 * @property {string} appId
 * @property {string} slug
 * @property {'pack' | 'service'} kind
 * @property {number} manifestVersion
 * @property {number} moduleVersion version of the module directory (pack catalog version or widget bundle version)
 * @property {string} key
 * @property {Record<string, unknown>} config
 * @property {Record<string, unknown>} strings
 * @property {Record<string, unknown> | null} placement as configured (audience still source text)
 * @property {{ path: string, name: string, sha256: string }} headless
 * @property {{ path: string, name: string, sha256: string }} renderer
 * @property {string | null} api the service product's base URL (its widgets' element API client)
 * @property {Record<string, string>} reads API base of each read service product active on the website, by slug
 * @property {string[]} readScopes key scopes the element needs (`manifest.reads` scopes; service widgets: the
 *   product's `<slug>.read` / `<slug>.write`)
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `file.js#export` → `{ path, name }`.
 * @param {unknown} ref
 */
export const parseModuleRef = (ref) => {
	const match = typeof ref === 'string' ? MODULE_REF.exec(ref) : null;
	return match ? { path: /** @type {string} */ (match[1]), name: /** @type {string} */ (match[2]) } : null;
};

/**
 * Product defaults of an element's top-level features (a document without config for the element).
 * @param {unknown} features
 * @returns {Record<string, unknown>}
 */
export const featureDefaults = (features) => {
	/** @type {Record<string, unknown>} */
	const out = {};
	const properties = isObject(features) && isObject(features.properties) ? features.properties : {};
	for (const [name, node] of Object.entries(properties)) if (isObject(node) && 'default' in node) out[name] = node.default;
	return out;
};

/**
 * Flat string catalog (string values only, bounded).
 * @param {unknown} value
 * @returns {Record<string, string>}
 */
const stringCatalog = (value) => {
	/** @type {Record<string, string>} */
	const out = {};
	if (!isObject(value)) return out;
	let size = 0;
	for (const [key, text] of Object.entries(value)) {
		if (typeof text !== 'string' || key.length > 200) continue;
		size += key.length + text.length;
		if (size > MAX_STRING_BYTES) break;
		out[key] = text;
	}
	return out;
};

/**
 * Languages to look up, least specific first: `en`, then each prefix of the website language (`de`, `de-CH`).
 * @param {string | null | undefined} language
 * @returns {string[]}
 */
export const languageChain = (language) => {
	const chain = [DEFAULT_LANGUAGE];
	if (typeof language !== 'string' || language === '') return chain;
	const parts = language.split('-');
	for (let i = 1; i <= parts.length; i += 1) {
		const tag = parts.slice(0, i).join('-');
		const lower = tag.toLowerCase();
		if (!chain.some((known) => known.toLowerCase() === lower)) chain.push(tag);
	}
	return chain;
};

/**
 * Whether a string key is in an element's slice (`stringKeys`: exact keys or `prefix*`).
 * @param {readonly string[]} patterns
 * @param {string} key
 */
export const inSlice = (patterns, key) =>
	patterns.some((pattern) => (pattern.endsWith('*') ? key.startsWith(pattern.slice(0, -1)) : key === pattern));

/**
 * The catalog of a language chain from the product catalogs (case-insensitive language match), more specific wins.
 * @param {ReadonlyMap<string, Record<string, unknown>>} catalogs by asset path
 * @param {readonly string[]} chain
 * @returns {Record<string, string>}
 */
const chainCatalog = (catalogs, chain) => {
	/** @type {Map<string, Record<string, unknown>>} */
	const byLanguage = new Map();
	for (const [file, catalog] of catalogs) {
		const match = LANGUAGE_CATALOG.exec(file);
		if (match) byLanguage.set(String(match[1]).toLowerCase(), catalog);
	}
	return Object.assign({}, ...chain.map((tag) => stringCatalog(byLanguage.get(tag.toLowerCase()) ?? null)));
};

/**
 * An element's strings (F.18): the product catalogs sliced by `stringKeys` (default `<key>.*`) for the website's
 * language chain — or, for an element naming a catalog in `strings`, that catalog (a `strings/<lang>.json` path takes
 * the language chain too) — then the merchant's per-website overrides (`*` first, then the chain).
 * @param {{ element: Record<string, any>, modules: { strings?: unknown, stringKeys?: unknown }, source: Source,
 *   context: StringContext }} input
 * @returns {Record<string, string>}
 */
export const elementStrings = ({ element, modules, source, context }) => {
	const chain = languageChain(context.language);
	const stringsPath = typeof modules.strings === 'string' ? modules.strings : null;
	const patterns = Array.isArray(modules.stringKeys)
		? modules.stringKeys.filter((p) => typeof p === 'string')
		: Array.isArray(element.stringKeys)
			? element.stringKeys
			: null;
	/** @type {Record<string, string>} */
	let base;
	if (patterns === null && stringsPath !== null && !LANGUAGE_CATALOG.test(stringsPath))
		base = stringCatalog(source.strings.get(stringsPath) ?? null);
	else {
		const full = chainCatalog(source.strings, chain);
		const slice = patterns ?? (stringsPath !== null ? null : [`${element.key}.*`]);
		base = slice === null ? full : Object.fromEntries(Object.entries(full).filter(([key]) => inSlice(slice, key)));
	}
	const override = context.overrides?.get(`${source.appId}:${element.key}`);
	if (!override) return stringCatalog(base);
	return stringCatalog(Object.assign({}, base, ...['*', ...chain].map((tag) => stringCatalog(override[tag] ?? null))));
};

/**
 * Read API bases a source's elements get (`manifest.reads`): each listed service product with an active subscription
 * on the website and an https API base.
 * @param {Source} source
 * @param {ReadonlyArray<Source>} sources
 * @returns {{ reads: Record<string, string>, scopes: string[], missing: string[] }}
 */
export const readsFor = (source, sources) => {
	/** @type {Record<string, string>} */
	const reads = {};
	/** @type {string[]} */
	const scopes = [];
	/** @type {string[]} */
	const missing = [];
	for (const read of readsOf(/** @type {any} */ (source.manifest))) {
		const product = sources.find(
			(s) =>
				s.kind === 'service' &&
				s.slug === read.product &&
				s.document !== null &&
				isObject(s.document.runtime) &&
				s.document.runtime.state === 'active' &&
				typeof s.apiBase === 'string' &&
				s.apiBase.startsWith('https://'),
		);
		if (!product) {
			missing.push(read.product);
			continue;
		}
		reads[read.product] = /** @type {string} */ (product.apiBase);
		scopes.push(...read.scopes);
	}
	return { reads, scopes: [...new Set(scopes)].sort(), missing };
};

/**
 * The module refs of an element when every module is uploaded.
 * @param {ElementModules} modules
 * @param {Source} source
 * @returns {{ ok: true, headless: Selected['headless'], renderer: Selected['renderer'] } | { ok: false, code: string, detail: string }}
 */
const resolveModules = (modules, source) => {
	const headless = parseModuleRef(modules.headless);
	const renderer = parseModuleRef(modules.renderer);
	if (!headless || !renderer)
		return { ok: false, code: 'no_modules', detail: 'the element declares no headless core and renderer' };
	const missing = [...new Set([headless.path, renderer.path])].filter((path) => !source.assets.has(path));
	if (missing.length > 0) return { ok: false, code: 'assets_missing', detail: `not uploaded: ${missing.join(', ')}` };
	/** @param {{ path: string, name: string }} ref */
	const withHash = (ref) => ({ ...ref, sha256: /** @type {{ sha256: string }} */ (source.assets.get(ref.path)).sha256 });
	return { ok: true, headless: withHash(headless), renderer: withHash(renderer) };
};

/**
 * Select the deliverable elements.
 * @param {ReadonlyArray<Source>} sources
 * @param {StringContext} [context] website language and string overrides
 * @returns {{ selected: Selected[], warnings: Warning[] }}
 */
export const selectElements = (sources, context = { language: null }) => {
	/** @type {Selected[]} */
	const selected = [];
	/** @type {Warning[]} */
	const warnings = [];
	for (const source of [...sources].sort((a, b) => (a.appId < b.appId ? -1 : a.appId > b.appId ? 1 : 0))) {
		const doc = source.document;
		if (!doc || !isObject(doc.runtime) || doc.runtime.state !== 'active') continue;
		const read = readsFor(source, sources);
		let readsWarned = false;
		for (const element of source.manifest.elements) {
			if (doc.elements?.[element.key]?.enabled !== true || !element.modes.includes('A')) continue;
			/** @param {string} code @param {string} detail */
			const warn = (code, detail) => warnings.push({ code, appId: source.appId, key: element.key, detail });
			if (read.missing.length > 0 && !readsWarned) {
				readsWarned = true;
				warnings.push({
					code: 'reads_inactive',
					appId: source.appId,
					detail: `no active subscription to ${read.missing.join(', ')}; its elements get no client for it`,
				});
			}
			/** @type {ElementModules | undefined} */
			let modules = element;
			/** @type {string | null} */
			let api = null;
			/** @type {string[]} */
			let scopes = read.scopes;
			if (source.kind === 'service') {
				if (!source.apiBase || !source.apiBase.startsWith('https://')) {
					warn('no_api_base', 'the service product has no https base URL');
					continue;
				}
				modules = source.widgets?.elements.get(element.key);
				if (!modules) {
					warn('widgets_missing', 'no widgets are uploaded for this element');
					continue;
				}
				api = source.apiBase;
				scopes = [...new Set([...scopes, `${source.slug}.read`, `${source.slug}.write`])].sort();
			}
			const resolved = resolveModules(modules, source);
			if (!resolved.ok) {
				warn(resolved.code, resolved.detail);
				continue;
			}
			const configured = isObject(doc.config?.[element.key]) ? doc.config[element.key] : featureDefaults(element.features);
			const { placement, ...config } = /** @type {Record<string, unknown>} */ (configured);
			selected.push({
				appId: source.appId,
				slug: source.slug,
				kind: source.kind,
				manifestVersion: source.manifestVersion,
				moduleVersion: source.kind === 'service' ? /** @type {Widgets} */ (source.widgets).version : source.manifestVersion,
				key: element.key,
				config,
				placement: isObject(placement) ? placement : null,
				strings: elementStrings({ element, modules, source, context }),
				headless: resolved.headless,
				renderer: resolved.renderer,
				api,
				reads: read.reads,
				readScopes: scopes,
			});
		}
	}
	return { selected, warnings };
};

/**
 * Element ids (`<product>:<key>`) must be unique in one bundle (F.18: keys are namespaced per product, so two products
 * may deliver the same key; only one product delivering a key twice conflicts).
 * @param {ReadonlyArray<Selected>} selected
 * @returns {Array<{ path: string, message: string }>}
 */
export const keyConflicts = (selected) => {
	/** @type {Map<string, number>} */
	const seen = new Map();
	for (const s of selected) seen.set(`${s.slug}:${s.key}`, (seen.get(`${s.slug}:${s.key}`) ?? 0) + 1);
	return [...seen.entries()]
		.filter(([, count]) => count > 1)
		.map(([id]) => ({ path: `/elements/${id}`, message: `element ${id} is delivered twice` }));
};

/**
 * Validate a placement and precompile its audience rule.
 * @param {Record<string, unknown> | null} placement
 * @returns {{ ok: true, placement: Record<string, unknown> | null, audience: boolean } | { ok: false, code: string, detail: string }}
 */
export const compilePlacement = (placement) => {
	if (placement === null) return { ok: true, placement: null, audience: false };
	const checked = validatePlacement(placement);
	if (!checked.ok)
		return {
			ok: false,
			code: 'placement_invalid',
			detail: checked.problems.map((p) => `${p.path || '/'} ${p.message}`).join('; '),
		};
	if (typeof placement.audience !== 'string') return { ok: true, placement, audience: false };
	const compiled = compileRule(placement.audience);
	if (!compiled.ok) return { ok: false, code: 'audience_invalid', detail: compiled.error.message };
	return { ok: true, placement: { ...placement, audience: compiled.program }, audience: true };
};

/**
 * Module path relative to the asset base (`<portal>/w/`): `packs/<appId>/<version>/<file>` — the pack version or the
 * service product's widget bundle version (immutable, hash-verified).
 * @param {Selected} s
 * @param {{ path: string }} ref
 */
const assetPath = (s, ref) => `packs/${s.appId}/${s.moduleVersion}/${ref.path}`;

/**
 * The data `start()` receives (see `runtime/entry.js` `CompiledData`).
 * @param {{ websiteId: string, env: 'live' | 'test', version: string, publicKey: string, eventsUrl: string,
 *   assetBase: string, elements: ReadonlyArray<Selected & { compiledPlacement: Record<string, unknown> | null }> }} input
 */
export const bundleData = ({ websiteId, env, version, publicKey, eventsUrl, assetBase, elements }) => ({
	websiteId,
	env,
	version,
	key: publicKey,
	events: eventsUrl,
	assets: assetBase,
	elements: [...elements]
		.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
		.map((s) => ({
			key: s.key,
			product: s.slug,
			...(Object.keys(s.reads).length > 0 ? { reads: s.reads } : {}),
			...(s.compiledPlacement ? { placement: s.compiledPlacement } : {}),
			config: s.config,
			strings: s.strings,
			headless: { path: assetPath(s, s.headless), name: s.headless.name },
			renderer: { path: assetPath(s, s.renderer), name: s.renderer.name },
			...(s.api ? { api: s.api } : {}),
		})),
});

/**
 * Render `loader.js`: one classic script, nothing global but `window.SS` (set by the Loader).
 * @param {{ data: Record<string, unknown>, core: string, audience: string | null }} input
 */
export const renderLoader = ({ data, core, audience }) =>
	[
		`/*! Single Solution loader ${data.websiteId} ${data.env} ${data.version} */`,
		'(function(){',
		core,
		...(audience ? [audience] : []),
		`__ssr.start(${canonicalJson(data)}${audience ? ',{audience:__ssa.evaluateAudienceProgram}' : ''});`,
		'})();',
		'',
	].join('\n');

/**
 * Render with a zero version, hash, render again with the derived version.
 * @param {{ data: Record<string, unknown>, core: string, audience: string | null }} input
 * @returns {{ version: string, text: string }}
 */
export const versionedLoader = ({ data, core, audience }) => {
	const draft = renderLoader({ data: { ...data, version: ZERO_VERSION }, core, audience });
	const version = createHash('sha256').update(draft).digest('hex').slice(0, 16);
	return { version, text: renderLoader({ data: { ...data, version }, core, audience }) };
};

/**
 * Content-Security-Policy additions a merchant needs for this bundle.
 * @param {{ portalOrigin: string, integrity: string, apiOrigins: ReadonlyArray<string> }} input
 */
export const cspFor = ({ portalOrigin, integrity, apiOrigins }) => ({
	scriptSrc: [portalOrigin, `'${integrity}'`],
	connectSrc: [...new Set([portalOrigin, ...apiOrigins])].sort(),
	styleSrc: ["'nonce-<loader script nonce>' (only where constructable stylesheets are unavailable)"],
	hashes: [integrity],
});

/**
 * `manifest.json` of an artefact (deterministic: no timestamps).
 * @param {{ websiteId: string, env: string, version: string, text: string, portalOrigin: string, core: string,
 *   audience: string | null, elements: ReadonlyArray<Selected & { audience: boolean }>, warnings: ReadonlyArray<Warning> }} input
 */
export const bundleManifest = ({ websiteId, env, version, text, portalOrigin, core, audience, elements, warnings }) => {
	const bytes = Buffer.from(text, 'utf8');
	const integrity = sha384Integrity(bytes);
	const apiOrigins = elements.flatMap((e) => [
		...(e.api ? [new URL(e.api).origin] : []),
		...Object.values(e.reads).map((base) => new URL(base).origin),
	]);
	return {
		format: BUNDLE_FORMAT,
		websiteId,
		env,
		version,
		integrity,
		sha256: sha256Hex(bytes),
		bytes: bytes.byteLength,
		csp: cspFor({ portalOrigin, integrity, apiOrigins }),
		runtime: { core: sha256Hex(Buffer.from(core)), audience: audience ? sha256Hex(Buffer.from(audience)) : null },
		elements: [...elements]
			.sort((a, b) => (a.key < b.key ? -1 : 1))
			.map((e) => ({
				appId: e.appId,
				slug: e.slug,
				key: e.key,
				kind: e.kind,
				manifestVersion: e.manifestVersion,
				moduleVersion: e.moduleVersion,
				...(Object.keys(e.reads).length > 0 ? { reads: Object.keys(e.reads).sort() } : {}),
				audience: e.audience,
				modules: [e.headless, e.renderer].map((m) => ({ path: m.path, sha256: m.sha256 })),
				...(e.api ? { api: e.api } : {}),
			})),
		warnings: [...warnings],
	};
};
