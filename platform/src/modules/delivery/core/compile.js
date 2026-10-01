/**
 * Website-bundle compiler (pure; PLAN §4.1, §4.5, F.7). The service gathers the inputs (verified entitlement
 * documents, accepted manifests, verified pack assets, the website's public key); this module selects the elements,
 * precompiles audience rules, renders the immutable `loader.js`, derives its version from its content, checks the
 * budget and builds `manifest.json`.
 *
 * Selection (per subscription): the signed document must be `runtime.state = active`; an element is delivered when
 * the document enables it **and** its manifest declares mode A. Pack elements ship their own headless + renderer
 * modules (stored, hash-verified assets). Service-product elements ship the modules of the product's signed **UI
 * bundle** when its current ready bundle covers the element (F.16; same descriptor and checks as packs, bound to the
 * product's API base), else the generic element stub (`ss-element-stub@2`, see `runtime/entry.js`). Anything that
 * cannot be delivered is skipped with a warning (fail closed for that element, never for the website).
 *
 * Determinism: inputs are sorted and embedded as canonical JSON, no timestamps enter the artefact, and the version is
 * the first 16 hex digits of the SHA-256 of the bundle rendered with a zero version — the same inputs always produce
 * the same bytes and the same version.
 * @module
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { validatePlacement } from '@ss/contracts';
import { canonicalJson } from '@ss/protocol';
import { compile as compileRule } from '@ss/rules';
import { sha256Hex, sha384Integrity } from './assets.js';

export const BUNDLE_FORMAT = 'ss-website-bundle@1';
export const STUB_PROTOCOL = 'ss-element-stub@2';
/** Delivery kinds recorded per element in `manifest.json`. */
export const DELIVERY_KINDS = Object.freeze({ pack: 'pack', ui: 'ui-bundle', stub: STUB_PROTOCOL });
export const VERSION_PATTERN = /^[0-9a-f]{16}$/;
const ZERO_VERSION = '0'.repeat(16);
const MODULE_REF = /^((?!\/)(?!.*\.\.)[A-Za-z0-9_./-]+\.m?js)#([A-Za-z_$][A-Za-z0-9_$]*)$/;
const MAX_STRING_BYTES = 64 * 1024;

/**
 * @typedef {object} Source one subscription (or one previewed, unsubscribed product)
 * @property {string} appId
 * @property {string} slug
 * @property {'pack' | 'service'} kind
 * @property {number} manifestVersion catalog version the subscription is pinned to
 * @property {import('@ss/contracts').Manifest} manifest
 * @property {Record<string, any> | null} document verified entitlement document payload (null: not subscribed)
 * @property {string | null} apiBase service products: `endpoints.base`
 * @property {ReadonlyMap<string, { sha256: string, size: number }>} assets uploaded, hash-verified pack assets by path
 * @property {ReadonlyMap<string, Record<string, unknown>>} strings parsed string catalogs by asset path
 * @property {ReadonlyMap<string, number>} gzipBytes gzip size of each stored JS asset by path
 * @property {UiBundle | null} [ui] service products: the current ready UI bundle (its assets are in `assets`,
 *   `strings` and `gzipBytes`), or null
 */

/**
 * @typedef {object} UiBundle a service product's signed UI bundle (F.16)
 * @property {number} version delivery's UI bundle version (served under `ui/<appId>/<version>/`)
 * @property {ReadonlyMap<string, { headless: string, renderer: string, strings?: string }>} elements by element key
 */

/**
 * @typedef {object} Candidate preview override
 * @property {string} appId
 * @property {string} key
 * @property {Record<string, unknown>} [config]
 * @property {Record<string, string>} [strings]
 * @property {Record<string, unknown>} [placement]
 */

/** @typedef {{ code: string, appId?: string, key?: string, detail: string }} Warning */

/**
 * @typedef {object} Selected
 * @property {string} appId
 * @property {string} slug
 * @property {'pack' | 'service'} kind
 * @property {number} manifestVersion
 * @property {'pack' | 'ui' | 'stub'} delivery how the element ships: pack modules, UI-bundle modules or the stub
 * @property {number} moduleVersion version of the module directory (pack catalog version or UI bundle version)
 * @property {string} key
 * @property {number} budgetKb declared `budget.js`
 * @property {number} actualGzipBytes gzip size of the element's own modules (packs; 0 for stubs)
 * @property {Record<string, unknown>} config
 * @property {Record<string, unknown>} strings
 * @property {Record<string, unknown> | null} placement as configured (audience still source text)
 * @property {{ path: string, name: string, sha256: string } | null} headless
 * @property {{ path: string, name: string, sha256: string } | null} renderer
 * @property {string | null} api
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
 * Product defaults of an element's top-level features (unsubscribed preview candidates).
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
 * Select the deliverable elements.
 * @param {ReadonlyArray<Source>} sources
 * @param {{ base?: 'current' | 'empty', elements: ReadonlyArray<Candidate> } | null} [candidates]
 * @returns {{ selected: Selected[], warnings: Warning[] }}
 */
export const selectElements = (sources, candidates = null) => {
	/** @type {Selected[]} */
	const selected = [];
	/** @type {Warning[]} */
	const warnings = [];
	/** @type {Map<string, Candidate>} */
	const wanted = new Map((candidates?.elements ?? []).map((c) => [`${c.appId}:${c.key}`, c]));
	const onlyCandidates = candidates?.base === 'empty';

	for (const source of [...sources].sort((a, b) => (a.appId < b.appId ? -1 : a.appId > b.appId ? 1 : 0))) {
		const doc = source.document;
		const state = doc && isObject(doc.runtime) ? doc.runtime.state : null;
		for (const element of source.manifest.elements) {
			const id = `${source.appId}:${element.key}`;
			const candidate = wanted.get(id);
			const enabled = doc !== null && state === 'active' && doc.elements?.[element.key]?.enabled === true;
			if (!candidate && (onlyCandidates || !enabled)) continue;
			/** @param {string} code @param {string} detail */
			const warn = (code, detail) => warnings.push({ code, appId: source.appId, key: element.key, detail });
			if (candidate && doc !== null && state !== 'active') {
				warn('inactive', `the subscription is ${state}`);
				continue;
			}
			if (!element.modes.includes('A')) {
				if (candidate) warn('no_mode_a', 'the element has no drop-in (mode A) renderer');
				continue;
			}
			const configured =
				doc && isObject(doc.config?.[element.key]) ? doc.config[element.key] : featureDefaults(element.features);
			const { placement: configuredPlacement, ...config } = /** @type {Record<string, unknown>} */ (configured);
			const placement = candidate?.placement ?? (isObject(configuredPlacement) ? configuredPlacement : null);
			const base = {
				appId: source.appId,
				slug: source.slug,
				kind: source.kind,
				manifestVersion: source.manifestVersion,
				key: element.key,
				budgetKb: element.budget?.js ?? 0,
				config: { ...config, ...(candidate?.config ?? {}) },
				placement,
			};
			/** @type {{ headless?: unknown, renderer?: unknown, strings?: unknown }} */
			let modules = /** @type {any} */ (element);
			/** @type {'pack' | 'ui'} */
			let delivery = 'pack';
			if (source.kind === 'service') {
				if (!source.apiBase || !source.apiBase.startsWith('https://')) {
					warn('no_api_base', 'the service product has no https API base');
					continue;
				}
				const ui = source.ui?.elements.get(element.key);
				const usable =
					ui &&
					[parseModuleRef(ui.headless), parseModuleRef(ui.renderer)].every(
						(ref) => ref !== null && source.assets.has(ref.path),
					);
				if (!ui || !usable) {
					if (ui) warn('ui_assets_missing', 'the UI bundle modules are not uploaded; the element stub is delivered');
					selected.push({
						...base,
						delivery: 'stub',
						moduleVersion: 0,
						actualGzipBytes: 0,
						strings: stringCatalog(candidate?.strings),
						headless: null,
						renderer: null,
						api: source.apiBase,
					});
					continue;
				}
				modules = ui;
				delivery = 'ui';
			}
			const headless = parseModuleRef(modules.headless);
			const renderer = parseModuleRef(modules.renderer);
			const missing = [headless, renderer]
				.filter((ref) => ref !== null)
				.map((ref) => /** @type {{ path: string }} */ (ref).path)
				.filter((path) => !source.assets.has(path));
			if (!headless || !renderer) {
				warn('no_modules', 'the pack element declares no headless core and renderer');
				continue;
			}
			if (missing.length > 0) {
				warn('assets_missing', `not uploaded: ${missing.join(', ')}`);
				continue;
			}
			const stringsPath = typeof modules.strings === 'string' ? modules.strings : null;
			const files = [...new Set([headless.path, renderer.path])];
			selected.push({
				...base,
				delivery,
				moduleVersion: delivery === 'ui' ? /** @type {UiBundle} */ (source.ui).version : source.manifestVersion,
				actualGzipBytes: files.reduce((sum, path) => sum + (source.gzipBytes.get(path) ?? 0), 0),
				strings: {
					...stringCatalog(stringsPath ? source.strings.get(stringsPath) : null),
					...stringCatalog(candidate?.strings),
				},
				headless: { ...headless, sha256: /** @type {{ sha256: string }} */ (source.assets.get(headless.path)).sha256 },
				renderer: { ...renderer, sha256: /** @type {{ sha256: string }} */ (source.assets.get(renderer.path)).sha256 },
				api: delivery === 'ui' ? source.apiBase : null,
			});
		}
	}
	for (const candidate of wanted.values()) {
		const known = sources.some((s) => s.appId === candidate.appId && s.manifest.elements.some((e) => e.key === candidate.key));
		if (!known)
			warnings.push({
				code: 'unknown_element',
				appId: candidate.appId,
				key: candidate.key,
				detail: 'no such element in the product',
			});
	}
	return { selected, warnings };
};

/**
 * Element keys must be unique in one bundle (the Loader, `SS.elements` and frequency caps are keyed by element key).
 * @param {ReadonlyArray<Selected>} selected
 * @returns {Array<{ path: string, message: string }>}
 */
export const keyConflicts = (selected) => {
	/** @type {Map<string, string[]>} */
	const owners = new Map();
	for (const s of selected) owners.set(s.key, [...(owners.get(s.key) ?? []), s.slug]);
	return [...owners.entries()]
		.filter(([, slugs]) => slugs.length > 1)
		.map(([key, slugs]) => ({ path: `/elements/${key}`, message: `element key ${key} is used by ${slugs.join(' and ')}` }));
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
 * Module path relative to the asset base (`<portal>/w/`): `packs/<appId>/<catalog version>/<file>` for packs,
 * `ui/<appId>/<UI bundle version>/<file>` for service UI bundles (immutable, hash-verified).
 * @param {Selected} s
 * @param {{ path: string } | null} ref
 */
const assetPath = (s, ref) => `${s.delivery === 'ui' ? 'ui' : 'packs'}/${s.appId}/${s.moduleVersion}/${ref?.path ?? ''}`;

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
		.map((s) => {
			return {
				key: s.key,
				...(s.compiledPlacement ? { placement: s.compiledPlacement } : {}),
				config: s.config,
				strings: s.strings,
				...(s.delivery === 'stub'
					? { stub: STUB_PROTOCOL, api: s.api }
					: {
							headless: { path: assetPath(s, s.headless), name: s.headless?.name },
							renderer: { path: assetPath(s, s.renderer), name: s.renderer?.name },
							...(s.api ? { api: s.api } : {}),
						}),
			};
		}),
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

/** @param {string} text */
export const gzipSize = (text) => gzipSync(Buffer.from(text, 'utf8'), { level: 9 }).byteLength;

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
 * Budget check: Σ element `budget.js` + the loader itself (gzip) ≤ the website budget, and no element ships more than
 * it declares.
 * @param {{ loaderGzipBytes: number, limitKb: number, elements: ReadonlyArray<Pick<Selected, 'appId' | 'slug' | 'key' | 'budgetKb' | 'actualGzipBytes'>> }} input
 */
export const checkBudget = ({ loaderGzipBytes, limitKb, elements }) => {
	const elementsKb = elements.reduce((sum, e) => sum + e.budgetKb, 0);
	const loaderKb = Math.ceil((loaderGzipBytes / 1024) * 10) / 10;
	const totalKb = Math.round((loaderKb + elementsKb) * 10) / 10;
	const report = { limitKb, loaderKb, elementsKb, totalKb };
	const overDeclared = elements.filter((e) => e.actualGzipBytes > e.budgetKb * 1024);
	const overTotal = totalKb > limitKb;
	/** @type {Array<{ path: string, message: string, code: string }>} */
	const offenders = [
		...overDeclared.map((e) => ({
			path: `/elements/${e.key}`,
			code: 'over_declared',
			message: `${e.slug}/${e.key} ships ${Math.ceil(e.actualGzipBytes / 102.4) / 10} KB gzip but declares budget.js ${e.budgetKb} KB`,
		})),
		...(overTotal
			? [...elements]
					.filter((e) => e.budgetKb > 0)
					.sort((a, b) => b.budgetKb - a.budgetKb || (a.key < b.key ? -1 : 1))
					.map((e) => ({
						path: `/elements/${e.key}`,
						code: 'budget',
						message: `${e.slug}/${e.key} budget.js ${e.budgetKb} KB`,
					}))
			: []),
	];
	return { ok: offenders.length === 0, report, offenders };
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
 *   audience: string | null, budget: ReturnType<typeof checkBudget>['report'],
 *   elements: ReadonlyArray<Selected & { audience: boolean }>, warnings: ReadonlyArray<Warning> }} input
 */
export const bundleManifest = ({ websiteId, env, version, text, portalOrigin, core, audience, budget, elements, warnings }) => {
	const bytes = Buffer.from(text, 'utf8');
	const integrity = sha384Integrity(bytes);
	const apiOrigins = elements.flatMap((e) => (e.api ? [new URL(e.api).origin] : []));
	return {
		format: BUNDLE_FORMAT,
		websiteId,
		env,
		version,
		integrity,
		sha256: sha256Hex(bytes),
		bytes: bytes.byteLength,
		gzipBytes: gzipSize(text),
		budget,
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
				delivery: DELIVERY_KINDS[e.delivery],
				...(e.delivery === 'ui' ? { uiBundleVersion: e.moduleVersion } : {}),
				budgetKb: e.budgetKb,
				audience: e.audience,
				modules: [e.headless, e.renderer]
					.filter((m) => m !== null)
					.map((m) => ({ path: /** @type {any} */ (m).path, sha256: /** @type {any} */ (m).sha256 })),
				...(e.api ? { api: e.api } : {}),
			})),
		warnings: [...warnings],
	};
};
