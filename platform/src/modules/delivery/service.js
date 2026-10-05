/**
 * Public service of the `delivery` module (PLAN §4): pack asset storage, the website-bundle compiler with immutable
 * versioned artefacts and an atomically flipped alias, serving, snippets, rollback and the preview proxy.
 *
 * - **Assets** (`uploadAsset`): developers/staff upload each file of a pack version; the bytes must match the SHA-256
 *   and size of the signed descriptor the catalog stored. Stored at `packs/<appId>/<version>/<path>` in platform
 *   asset storage (our artefacts — never client data).
 * - **Compile** (`compile`, job `delivery.compile` via `requestCompile`): verified entitlement documents (commerce
 *   `documentFor`, checked with the Portal keys) × accepted manifests → `w/<websiteId>/<env>/<version>/loader.js` +
 *   `manifest.json`; the alias in `delivery_aliases` flips with a compare-and-set so an older compile never replaces
 *   a newer one. Budget overruns refuse the compile (`delivery_budget_exceeded`) and keep the current alias.
 * - **UI bundles** (`submitUiBundle`, `uploadUiAsset`; F.16): a service product publishes the browser modules of its
 *   mode-A elements itself — the same signed `ss-pack-bundle@1` descriptor as packs (verified by catalog with the
 *   product's registered keys), then each asset (bytes = descriptor sha256 and size). Once every asset is stored the
 *   bundle is `ready`, the newest ready bundle replaces the element stub, and every subscribed website recompiles.
 * - **Serve**: `/w/<websiteId>/loader.js` (alias, 60 s + stale-while-revalidate) and `/w/<websiteId>/<version>/…`
 *   (immutable), `/w/packs/<appId>/<version>/<path>` (pack modules) and `/w/ui/<appId>/<version>/<path>` (service UI
 *   bundle modules), both immutable.
 * - **Preview**: a signed 10-minute session with a candidate element set; `/p/<token>/<path>` fetches the merchant's
 *   public page through `@ss/net` `safeFetch` (website origin only, GET, no cookies, HTML ≤ 2 MB), injects the
 *   candidate bundle and a ribbon, and returns it sandboxed — nothing fetched is ever stored. With `PREVIEW_ORIGIN`
 *   previews are served only from that dedicated cookie-less origin (the merchant's own scripts may run there).
 * @module
 */
import { createId, isId } from '@ss/contracts';
import { createOutboundPolicy, isNetError, safeFetch as netFetch } from '@ss/net';
import { canonicalJson, verifyEntitlementDocument } from '@ss/protocol';
import { deriveSecret } from '../../infra/config.js';
import { problem } from '../../infra/http.js';
import { checkUpload, isAssetPath, sha256Hex } from './core/assets.js';
import {
	LANGUAGE_CATALOG,
	VERSION_PATTERN,
	bundleData,
	bundleManifest,
	checkBudget,
	compilePlacement,
	gzipSize,
	keyConflicts,
	measureSelected,
	selectElements,
	versionedLoader,
} from './core/compile.js';
import { checkStringOverride } from './core/strings.js';
import {
	MAX_PAGE_BYTES,
	PREVIEW_TTL_MS,
	decodePage,
	injectPreview,
	isHtml,
	previewHeaders,
	signPreviewToken,
	targetUrl,
	verifyPreviewToken,
} from './core/preview.js';
import { RUNTIME_AUDIENCE, RUNTIME_CORE } from './runtime/generated.js';
import { ALIASES, ARTEFACTS, ASSETS, PREVIEWS, STRINGS, UI_BUNDLES } from './schema.js';
import { createAssetStorage, withImmutableCache } from './storage.js';

/** @typedef {import('../../infra/modules.js').ModuleContext} ModuleContext */
/** @typedef {import('../../infra/rbac.js').Actor} Actor */
/** @typedef {import('./storage.js').AssetStorage} AssetStorage */
/** @typedef {import('./core/compile.js').Source} Source */
/** @typedef {import('./core/compile.js').Candidate} Candidate */
/** @typedef {import('./core/compile.js').Warning} Warning */
/**
 * @typedef {(url: string, init: import('@ss/net').SafeFetchInit, policy: import('@ss/net').OutboundPolicy) =>
 *   Promise<import('@ss/net').SafeResponse>} SafeFetch
 */

/**
 * @typedef {object} DeliveryOptions
 * @property {AssetStorage | null} [storage] asset storage (default: from `PLATFORM_ASSET_STORAGE`)
 * @property {SafeFetch} [fetch] outbound HTTP client (preview pages, S3) — default `@ss/net` `safeFetch`
 * @property {import('@ss/net').Resolver} [resolve] DNS resolver of the outbound policies (tests)
 * @property {ReadonlyArray<string>} [allowHosts] development allowlist (default `ctx.config.outbound.allowHosts`;
 *   always empty in production)
 * @property {{ core: string, audience: string }} [runtime] browser runtime (default: `runtime/generated.js`)
 * @property {string | null} [previewOrigin] dedicated preview origin (default `ctx.config.delivery.previewOrigin`)
 */

export const COMPILE_JOB = 'delivery.compile';
export const LOADER_SCOPES = Object.freeze(['events.write', 'elements.read']);
const SYSTEM = /** @type {Actor} */ ({ type: 'system', id: 'delivery' });
const JS = 'text/javascript; charset=utf-8';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const ALIAS_CACHE = 'public, max-age=60, stale-while-revalidate=600';
const ASSET_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";
const ELEMENT_KEY = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const MAX_CANDIDATES = 20;
const MAX_CANDIDATE_JSON = 16 * 1024;
const HISTORY = 20;

/**
 * @param {string} code
 * @param {string} detail
 * @param {{ errors?: Array<{ path: string, message: string, code?: string }> }} [extra]
 * @returns {never}
 */
const fail = (code, detail, extra) => {
	throw problem(code, detail, extra);
};

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** @param {unknown} value */
const iso = (value) =>
	value instanceof Date ? value.toISOString() : value === null || value === undefined ? null : String(value);

/** Response headers every served artefact carries. */
const servedHeaders = () => ({
	'access-control-allow-origin': '*',
	'cross-origin-resource-policy': 'cross-origin',
	'x-content-type-options': 'nosniff',
	'timing-allow-origin': '*',
	'content-security-policy': ASSET_CSP,
});

/**
 * @param {ModuleContext} ctx
 * @param {DeliveryOptions} [options]
 */
export const createDeliveryService = (ctx, options = {}) => {
	const allowHosts = ctx.config.isProduction ? [] : [...(options.allowHosts ?? ctx.config.outbound.allowHosts)];
	const resolve = options.resolve ? { resolve: options.resolve } : {};
	const policy = createOutboundPolicy({ allowHosts, ...resolve, maxBytes: 8 * 1024 * 1024, timeoutMs: 15_000 });
	const pagePolicy = createOutboundPolicy({
		allowHosts,
		...resolve,
		maxBytes: MAX_PAGE_BYTES,
		timeoutMs: 8_000,
		userAgent: 'ss-preview/1',
	});
	const fetch = options.fetch ?? netFetch;
	const configured =
		options.storage === undefined
			? createAssetStorage(ctx.config.delivery.storage, { policy, fetch: /** @type {any} */ (fetch), now: ctx.now })
			: options.storage;
	const storage = configured ? withImmutableCache(configured) : null;
	const runtime = options.runtime ?? { core: RUNTIME_CORE, audience: RUNTIME_AUDIENCE };
	const previewKey = deriveSecret(ctx.config.sessionSecret, 'delivery-preview');
	const portalUrl = ctx.config.portalUrl;
	const portalOrigin = ctx.config.portalOrigin;
	const eventsUrl = `${portalUrl}/v1/events`;
	// element modules: `packs/<appId>/<version>/<path>` and `ui/<appId>/<version>/<path>` below this base
	const assetBase = `${portalUrl}/w/`;
	const previewOrigin =
		options.previewOrigin === undefined ? (ctx.config.delivery.previewOrigin ?? null) : options.previewOrigin;
	const previewHost = previewOrigin ? new URL(previewOrigin).host : null;

	const assets = ctx.collection(ASSETS);
	const artefacts = ctx.collection(ARTEFACTS);
	const aliases = ctx.collection(ALIASES);
	const previews = ctx.collection(PREVIEWS);
	const uiBundles = ctx.collection(UI_BUNDLES);
	const stringOverrides = ctx.collection(STRINGS);
	const identity = () => ctx.service('identity');
	const catalog = () => ctx.service('catalog');
	const commerce = () => ctx.service('commerce');

	const store = () => storage ?? fail('unavailable', 'Platform asset storage is not configured (PLATFORM_ASSET_STORAGE).');

	/**
	 * @param {Actor} actor
	 * @param {string} action
	 * @param {{ type: string, id: string, merchantId?: string | null, websiteId?: string | null }} target
	 * @param {{ before?: unknown, after?: unknown, reason?: string | null, requestId?: string | null, ip?: string | null }} [details]
	 */
	const audit = (actor, action, target, { before, after, reason = null, requestId = null, ip = null } = {}) =>
		ctx.audit.record({
			actor: /** @type {any} */ (actor),
			action,
			target: /** @type {any} */ (target),
			...(before === undefined ? {} : { before }),
			...(after === undefined ? {} : { after }),
			reason,
			requestId,
			ip,
		});

	/**
	 * @param {string} websiteId
	 * @param {string | null} [merchantId] when given, the website must belong to it (else 404)
	 */
	const loadWebsite = async (websiteId, merchantId = null) => {
		if (!isId(websiteId, 'web')) return fail('not_found', 'No such website.');
		const website = await identity().getWebsite(websiteId);
		if (merchantId !== null && website.merchantId !== merchantId) return fail('not_found', 'No such website.');
		return /** @type {{ websiteId: string, merchantId: string, domain: string, env: 'live' | 'test', status: string, language?: string | null }} */ (
			website
		);
	};

	// ------------------------------------------------------------------------------------------------------------
	// pack assets

	/**
	 * Upload one asset of a pack version (verified against the signed descriptor).
	 * @param {{ appId: string, version: string | number, path: string, bytes: Uint8Array, contentType: string | null,
	 *   actor: Actor, requestId?: string | null, ip?: string | null }} input
	 */
	const uploadAsset = async ({ appId, version, path, bytes, contentType, actor, requestId = null, ip = null }) => {
		const n = Number(version);
		if (!isId(appId, 'app') || !Number.isSafeInteger(n) || n < 1) return fail('not_found', 'No such pack version.');
		if (!isAssetPath(path))
			fail('validation_failed', 'The asset path is invalid.', {
				errors: [{ path: '/path', message: 'must be a relative file path' }],
			});
		const app = await catalog().getApp(appId);
		if (app.kind !== 'pack') fail('conflict', 'Only element packs have uploaded assets.');
		const detail = await catalog().versionDetail(appId, n);
		if (detail.status === 'rejected' || detail.status === 'superseded')
			fail('conflict', `Version ${n} is ${detail.status}; assets are accepted for pending and accepted versions only.`);
		const declared = (detail.assets ?? []).find((/** @type {{ path: string }} */ a) => a.path === path);
		const checked = checkUpload({ path, bytes, contentType, declared });
		if (checked.errors.length > 0) {
			const first = /** @type {{ code: string }} */ (checked.errors[0]).code;
			const code =
				first === 'type_not_allowed' || first === 'content_type'
					? 'unsupported_media_type'
					: first === 'too_large'
						? 'payload_too_large'
						: 'delivery_asset_mismatch';
			fail(code, 'The asset does not match the signed bundle descriptor.', { errors: checked.errors });
		}
		const sha256 = /** @type {{ sha256: string }} */ (declared).sha256;
		const id = `${appId}:${n}:${path}`;
		const storageKey = `packs/${appId}/${n}/${path}`;
		const existing = await assets.findOne({ _id: id });
		if (!existing || existing.sha256 !== sha256) {
			await store().put(storageKey, bytes, { contentType: checked.contentType, cacheControl: IMMUTABLE });
			await assets.updateOne(
				{ _id: id },
				{
					$set: { appId, version: n, path, sha256, size: bytes.byteLength, contentType: checked.contentType, storageKey },
					$setOnInsert: { uploadedBy: actor.id },
				},
				{ upsert: true },
			);
			await audit(
				actor,
				'delivery.asset_uploaded',
				{ type: 'app', id: appId },
				{ after: { version: n, path, sha256, size: bytes.byteLength }, requestId, ip },
			);
		}
		/** @type {Array<Record<string, any>>} */
		const records = await assets.find({ appId, version: n }).toArray();
		const uploaded = new Set(records.map((a) => a.path));
		return {
			appId,
			version: n,
			path,
			sha256,
			size: bytes.byteLength,
			contentType: checked.contentType,
			url: `${assetBase}packs/${appId}/${n}/${path}`,
			changed: !existing,
			missing: (detail.assets ?? [])
				.map((/** @type {{ path: string }} */ a) => a.path)
				.filter((/** @type {string} */ p) => !uploaded.has(p)),
		};
	};

	// ------------------------------------------------------------------------------------------------------------
	// service UI bundles (F.16)

	/** @param {Record<string, any>} doc */
	const uiBundleView = (doc, /** @type {string[]} */ missing = []) => ({
		appId: doc.appId,
		version: doc.version,
		status: doc.status,
		productVersion: doc.productVersion,
		elements: (doc.elements ?? []).map((/** @type {Record<string, any>} */ e) => e.key),
		assets: (doc.assets ?? []).length,
		missing,
		uploadPath: `/v1/product/ui-bundles/${doc.version}/assets/`,
		createdAt: iso(doc.createdAt),
		readyAt: iso(doc.readyAt),
	});

	/** @param {Record<string, any>} bundle */
	const missingUiAssets = async (bundle) => {
		/** @type {Array<Record<string, any>>} */
		const stored = await assets.find({ appId: bundle.appId, version: bundle.version, bundle: 'ui' }).toArray();
		const have = new Map(stored.map((a) => [String(a.path), String(a.sha256)]));
		return (bundle.assets ?? [])
			.filter((/** @type {{ path: string, sha256: string }} */ a) => have.get(a.path) !== a.sha256)
			.map((/** @type {{ path: string }} */ a) => a.path);
	};

	/** Recompile every website subscribed to an app (best effort; each request coalesces per website). */
	const recompileApp = async (/** @type {string} */ appId, /** @type {string} */ reason) => {
		/** @type {string[]} */
		let websiteIds = [];
		try {
			const listed = await commerce().websitesOfApp?.(appId);
			websiteIds = Array.isArray(listed) ? listed : [];
		} catch (error) {
			ctx.logger.warn('websites of an app unavailable for recompiling', { appId, error });
		}
		for (const websiteId of websiteIds)
			await requestCompile(websiteId, { reason }).catch((error) =>
				ctx.logger.warn('recompile not requested', { appId, websiteId, error }),
			);
		return websiteIds.length;
	};

	/**
	 * Mark a UI bundle ready when every declared asset is stored (idempotent), then recompile its websites.
	 * @param {Record<string, any>} bundle
	 * @param {Actor} actor
	 */
	const settleUiBundle = async (bundle, actor) => {
		const missing = await missingUiAssets(bundle);
		if (missing.length > 0 || bundle.status === 'ready') return { bundle, missing };
		const readyAt = new Date(ctx.now());
		const updated = await uiBundles.findOneAndUpdate(
			{ _id: bundle._id, status: 'pending' },
			{ $set: { status: 'ready', readyAt } },
		);
		if (!updated) return { bundle: (await uiBundles.findOne({ _id: bundle._id })) ?? bundle, missing };
		await audit(
			actor,
			'delivery.ui_bundle_ready',
			{ type: 'app', id: bundle.appId },
			{ after: { version: bundle.version, elements: (bundle.elements ?? []).map((/** @type {any} */ e) => e.key) } },
		);
		await recompileApp(bundle.appId, 'ui_bundle.ready');
		return { bundle: { ...bundle, status: 'ready', readyAt }, missing };
	};

	/**
	 * `POST /v1/product/ui-bundles`: a service product submits a signed UI bundle descriptor (catalog verifies the
	 * format, the module references and the signature with the product's registered keys). The same descriptor is
	 * idempotent (same version); a new one gets the next version, `pending` until its assets are uploaded.
	 * @param {{ appId: string, body: unknown, requestId?: string | null, ip?: string | null }} input
	 */
	const submitUiBundle = async ({ appId, body, requestId = null, ip = null }) => {
		store();
		const verified = await catalog().verifyUiBundle({ appId, body });
		const descriptorHash = sha256Hex(Buffer.from(canonicalJson(verified.descriptor), 'utf8'));
		const actor = /** @type {Actor} */ ({ type: 'product', id: appId });
		let doc = await uiBundles.findOne({ appId, descriptorHash });
		if (!doc) {
			for (let attempt = 0; attempt < 5 && !doc; attempt += 1) {
				const last = await uiBundles.find({ appId }).sort({ version: -1 }).limit(1).toArray();
				const version = Number(last[0]?.version ?? 0) + 1;
				const record = {
					_id: `${appId}:${version}`,
					appId,
					version,
					descriptorHash,
					productVersion: String(/** @type {any} */ (verified.descriptor.manifest).product.version),
					elements: verified.elements,
					assets: verified.descriptor.assets.map((/** @type {{ path: string, sha256: string, size: number }} */ a) => ({
						path: a.path,
						sha256: a.sha256,
						size: a.size,
					})),
					kid: verified.signature.kid,
					status: 'pending',
					readyAt: null,
				};
				try {
					await uiBundles.insertOne(record);
					doc = record;
					await audit(
						actor,
						'delivery.ui_bundle_submitted',
						{ type: 'app', id: appId },
						{
							after: {
								version,
								descriptorHash,
								elements: verified.elements.map((/** @type {{ key: string }} */ e) => e.key),
							},
							requestId,
							ip,
						},
					);
				} catch (error) {
					doc = await uiBundles.findOne({ appId, descriptorHash });
					if (!doc && !(isObject(error) && error.code === 11000)) throw error;
				}
			}
			if (!doc) fail('conflict', 'The UI bundle could not be stored concurrently; retry.');
		}
		const settled = await settleUiBundle(/** @type {Record<string, any>} */ (doc), actor);
		return uiBundleView(settled.bundle, settled.missing);
	};

	/**
	 * `PUT /v1/product/ui-bundles/:version/assets/<path>`: one asset of the product's own UI bundle.
	 * @param {{ appId: string, version: string | number, path: string, bytes: Uint8Array, contentType: string | null,
	 *   requestId?: string | null, ip?: string | null }} input
	 */
	const uploadUiAsset = async ({ appId, version, path, bytes, contentType, requestId = null, ip = null }) => {
		const n = Number(version);
		if (!Number.isSafeInteger(n) || n < 1) return fail('not_found', 'No such UI bundle version.');
		if (!isAssetPath(path))
			fail('validation_failed', 'The asset path is invalid.', {
				errors: [{ path: '/path', message: 'must be a relative file path' }],
			});
		const bundle = (await uiBundles.findOne({ _id: `${appId}:${n}` })) ?? fail('not_found', 'No such UI bundle version.');
		const declared = (bundle.assets ?? []).find((/** @type {{ path: string }} */ a) => a.path === path);
		const checked = checkUpload({ path, bytes, contentType, declared });
		if (checked.errors.length > 0) {
			const first = /** @type {{ code: string }} */ (checked.errors[0]).code;
			const code =
				first === 'type_not_allowed' || first === 'content_type'
					? 'unsupported_media_type'
					: first === 'too_large'
						? 'payload_too_large'
						: 'delivery_asset_mismatch';
			fail(code, 'The asset does not match the signed UI bundle descriptor.', { errors: checked.errors });
		}
		const sha256 = /** @type {{ sha256: string }} */ (declared).sha256;
		const id = `ui:${appId}:${n}:${path}`;
		const storageKey = `ui/${appId}/${n}/${path}`;
		const actor = /** @type {Actor} */ ({ type: 'product', id: appId });
		const existing = await assets.findOne({ _id: id });
		if (!existing || existing.sha256 !== sha256) {
			await store().put(storageKey, bytes, { contentType: checked.contentType, cacheControl: IMMUTABLE });
			await assets.updateOne(
				{ _id: id },
				{
					$set: {
						appId,
						version: n,
						path,
						bundle: 'ui',
						sha256,
						size: bytes.byteLength,
						contentType: checked.contentType,
						storageKey,
					},
					$setOnInsert: { uploadedBy: actor.id },
				},
				{ upsert: true },
			);
			await audit(
				actor,
				'delivery.ui_asset_uploaded',
				{ type: 'app', id: appId },
				{ after: { version: n, path, sha256, size: bytes.byteLength }, requestId, ip },
			);
		}
		const settled = await settleUiBundle(bundle, actor);
		return {
			appId,
			version: n,
			path,
			sha256,
			size: bytes.byteLength,
			contentType: checked.contentType,
			url: `${assetBase}ui/${appId}/${n}/${path}`,
			changed: !existing,
			status: settled.bundle.status,
			missing: settled.missing,
		};
	};

	/**
	 * The UI bundles of a product, newest first (`GET /v1/product/ui-bundles`).
	 * @param {{ appId: string }} input
	 */
	const listUiBundles = async ({ appId }) => {
		/** @type {Array<Record<string, any>>} */
		const docs = await uiBundles.find({ appId }).sort({ version: -1 }).limit(HISTORY).toArray();
		const items = [];
		for (const doc of docs) items.push(uiBundleView(doc, doc.status === 'ready' ? [] : await missingUiAssets(doc)));
		return { items };
	};

	// ------------------------------------------------------------------------------------------------------------
	// compiler

	/**
	 * Load stored assets into a source's maps: every JS module (bytes and gzip size — element entries and the shared
	 * chunks they import, F.18), the product string catalogs `strings/<lang>.json` and any per-element catalog.
	 * @param {{ appId: string, records: Array<Record<string, any>>, elements: ReadonlyArray<{ key: string, headless?: unknown,
	 *   renderer?: unknown, strings?: unknown }>, stored: Map<string, { sha256: string, size: number }>,
	 *   strings: Map<string, Record<string, unknown>>, gzipBytes: Map<string, number>, files: Map<string, Uint8Array> }} input
	 * @param {Warning[]} warnings
	 */
	const loadModules = async ({ appId, records, elements, stored, strings, gzipBytes, files }, warnings) => {
		for (const r of records) stored.set(String(r.path), { sha256: String(r.sha256), size: Number(r.size) });
		const catalogs = new Set(elements.map((element) => element.strings).filter((path) => typeof path === 'string'));
		for (const record of records) {
			const path = String(record.path);
			if (/\.m?js$/.test(path)) {
				const object = await store().get(String(record.storageKey));
				if (!object) {
					stored.delete(path);
					continue;
				}
				files.set(path, object.body);
				gzipBytes.set(path, gzipSize(object.body));
			} else if (LANGUAGE_CATALOG.test(path) || catalogs.has(path)) {
				const object = await store().get(String(record.storageKey));
				try {
					if (object) strings.set(path, JSON.parse(Buffer.from(object.body).toString('utf8')));
				} catch {
					warnings.push({ code: 'strings_invalid', appId, detail: `${path} is not JSON` });
				}
			}
		}
	};

	/**
	 * Inputs of one product for the compiler.
	 * @param {{ appId: string, manifestVersion: number, document: Record<string, any> | null }} input
	 * @param {Warning[]} warnings
	 * @returns {Promise<Source | null>}
	 */
	const sourceOf = async ({ appId, manifestVersion, document }, warnings) => {
		const app = await catalog().getApp(appId);
		if (app.status !== 'active' && app.status !== 'deprecated') {
			warnings.push({ code: 'app_unavailable', appId, detail: `the product is ${app.status}` });
			return null;
		}
		const manifest = /** @type {import('@ss/contracts').Manifest} */ (await catalog().getManifest(appId, manifestVersion));
		/** @type {Map<string, { sha256: string, size: number }>} */
		const stored = new Map();
		/** @type {Map<string, Record<string, unknown>>} */
		const strings = new Map();
		/** @type {Map<string, number>} */
		const gzipBytes = new Map();
		/** @type {Map<string, Uint8Array>} */
		const files = new Map();
		/** @type {import('./core/compile.js').UiBundle | null} */
		let ui = null;
		if (app.kind === 'pack') {
			/** @type {Array<Record<string, any>>} */
			const records = await assets.find({ appId, version: manifestVersion, bundle: { $exists: false } }).toArray();
			const elements = manifest.elements.filter((element) => element.modes.includes('A'));
			await loadModules({ appId, records, elements, stored, strings, gzipBytes, files }, warnings);
		} else {
			// the newest ready UI bundle, restricted to the mode-A elements of the pinned manifest
			const [bundle] = await uiBundles.find({ appId, status: 'ready' }).sort({ version: -1 }).limit(1).toArray();
			if (bundle) {
				const modeA = new Set(manifest.elements.filter((e) => e.modes.includes('A')).map((e) => e.key));
				/** @type {Array<{ key: string, headless: string, renderer: string, strings?: string }>} */
				const elements = (bundle.elements ?? []).filter((/** @type {{ key: string }} */ e) => modeA.has(e.key));
				/** @type {Array<Record<string, any>>} */
				const records = await assets.find({ appId, version: Number(bundle.version), bundle: 'ui' }).toArray();
				await loadModules({ appId, records, elements, stored, strings, gzipBytes, files }, warnings);
				ui = { version: Number(bundle.version), elements: new Map(elements.map((e) => [e.key, e])) };
			}
		}
		return {
			appId,
			slug: manifest.product.slug,
			kind: /** @type {'pack' | 'service'} */ (app.kind),
			manifestVersion,
			manifest,
			document,
			apiBase: app.kind === 'service' ? (manifest.endpoints?.base?.replace(/\/+$/, '') ?? null) : null,
			assets: stored,
			strings,
			gzipBytes,
			files,
			ui,
		};
	};

	/**
	 * Every live subscription of the website with its verified document, plus unsubscribed preview candidates.
	 * @param {{ websiteId: string, domain: string, env: string }} website
	 * @param {ReadonlyArray<Candidate>} candidates
	 * @param {Warning[]} warnings
	 */
	const gatherSources = async (website, candidates, warnings) => {
		/** @type {Source[]} */
		const sources = [];
		const subscriptions = /** @type {Array<{ appId: string, manifestVersion: number, cancelledAt: string | null }>} */ (
			await commerce().subscriptionsForWebsite(website.websiteId)
		).filter((s) => !s.cancelledAt);
		const seen = new Set();
		for (const sub of subscriptions) {
			if (seen.has(sub.appId)) continue;
			seen.add(sub.appId);
			/** @type {Record<string, any> | null} */
			let payload = null;
			try {
				const jws = await commerce().documentFor({ websiteId: website.websiteId, appId: sub.appId });
				payload = (
					await verifyEntitlementDocument({
						token: jws,
						keyResolver: ctx.keys.keyResolver,
						now: ctx.now,
						expectedDomain: website.domain,
						graceMs: 0,
					})
				).payload;
			} catch (error) {
				warnings.push({
					code: 'no_document',
					appId: sub.appId,
					detail: isObject(error) && typeof error.code === 'string' ? error.code : 'unverifiable',
				});
				continue;
			}
			if (payload.websiteId !== website.websiteId || payload.env !== website.env) {
				warnings.push({ code: 'document_mismatch', appId: sub.appId, detail: 'the document is bound to another website' });
				continue;
			}
			const source = await sourceOf({ appId: sub.appId, manifestVersion: sub.manifestVersion, document: payload }, warnings);
			if (source) sources.push(source);
		}
		for (const appId of new Set(candidates.map((c) => c.appId))) {
			if (seen.has(appId)) continue;
			seen.add(appId);
			try {
				const app = await catalog().getApp(appId);
				const source = await sourceOf({ appId, manifestVersion: app.currentVersion, document: null }, warnings);
				if (source) sources.push(source);
			} catch {
				warnings.push({ code: 'unknown_product', appId, detail: 'no such product' });
			}
		}
		return sources;
	};

	/**
	 * The alias record of a website, created on first use, with an active public key for the bundle. The key holds
	 * {@link LOADER_SCOPES} plus the read scopes of the products pack elements read (`manifest.reads`, F.18); it is
	 * re-issued when it is no longer active or lacks a scope the bundle needs.
	 * @param {{ websiteId: string, merchantId: string, env: 'live' | 'test' }} website
	 * @param {ReadonlyArray<string>} [readScopes]
	 */
	const ensureAlias = async (website, readScopes = []) => {
		const scopes = [...new Set([...LOADER_SCOPES, ...[...readScopes].sort()])];
		const _id = `${website.websiteId}:${website.env}`;
		await aliases.updateOne(
			{ _id },
			{
				$setOnInsert: {
					websiteId: website.websiteId,
					merchantId: website.merchantId,
					env: website.env,
					version: null,
					artefactSeq: 0,
					requested: 0,
					compiledRequest: 0,
					publicKey: null,
					history: [],
					lastFailure: null,
				},
			},
			{ upsert: true },
		);
		let doc = /** @type {Record<string, any>} */ (await aliases.findOne({ _id }));
		const keys = doc.publicKey
			? /** @type {Array<{ keyId: string, status: string }>} */ (
					await identity().listKeys({ merchantId: website.merchantId, websiteId: website.websiteId })
				)
			: [];
		const active = doc.publicKey && keys.some((k) => k.keyId === doc.publicKey.keyId && k.status === 'active');
		/** @type {string[]} */
		const held = Array.isArray(doc.publicKey?.scopes) ? doc.publicKey.scopes : [...LOADER_SCOPES];
		const covered = scopes.every((scope) => held.includes(scope));
		if (!active || !covered) {
			const previous = active ? doc.publicKey.keyId : null;
			const issued = await identity().issueKey({
				websiteId: website.websiteId,
				merchantId: website.merchantId,
				kind: 'pk',
				scopes,
				actor: SYSTEM,
				meta: { purpose: 'loader' },
			});
			const updated = await aliases.findOneAndUpdate(
				{ _id, 'publicKey.keyId': doc.publicKey?.keyId ?? null },
				{ $set: { publicKey: { keyId: issued.keyId, key: issued.key, scopes } } },
			);
			// a key superseded for its scopes stays active: browsers may still hold bundles (and aliases) that embed it
			void previous;
			if (updated) doc = updated;
			else {
				await identity()
					.revokeKey({
						keyId: issued.keyId,
						merchantId: website.merchantId,
						websiteId: website.websiteId,
						reason: 'superseded',
						actor: SYSTEM,
					})
					.catch(() => undefined);
				doc = /** @type {Record<string, any>} */ (await aliases.findOne({ _id }));
			}
		}
		return doc;
	};

	/**
	 * @param {unknown} body
	 * @returns {{ base: 'current' | 'empty', elements: Candidate[], path: string }}
	 */
	const parseCandidates = (body) => {
		const input = body === undefined || body === null ? {} : body;
		/** @type {Array<{ path: string, message: string }>} */
		const errors = [];
		if (!isObject(input)) return fail('validation_failed', 'The body must be an object.');
		const { base = 'current', elements = [], path = '/', ...rest } = input;
		for (const key of Object.keys(rest)) errors.push({ path: `/${key}`, message: 'unknown property' });
		if (base !== 'current' && base !== 'empty') errors.push({ path: '/base', message: 'must be current or empty' });
		if (typeof path !== 'string' || !targetUrl('https://example.invalid', path))
			errors.push({ path: '/path', message: 'must be an absolute path on the website' });
		/** @type {Candidate[]} */
		const candidates = [];
		if (!Array.isArray(elements) || elements.length > MAX_CANDIDATES)
			errors.push({ path: '/elements', message: `must list at most ${MAX_CANDIDATES} elements` });
		else
			elements.forEach((entry, i) => {
				const at = `/elements/${i}`;
				if (!isObject(entry)) return void errors.push({ path: at, message: 'must be an object' });
				const { appId, key, config, strings, placement, ...more } = entry;
				for (const name of Object.keys(more)) errors.push({ path: `${at}/${name}`, message: 'unknown property' });
				if (!isId(appId, 'app')) errors.push({ path: `${at}/appId`, message: 'must be an app id' });
				if (typeof key !== 'string' || key.length > 40 || !ELEMENT_KEY.test(key))
					errors.push({ path: `${at}/key`, message: 'must be an element key' });
				for (const [name, value] of /** @type {const} */ ([
					['config', config],
					['strings', strings],
					['placement', placement],
				])) {
					if (value === undefined) continue;
					if (!isObject(value) || JSON.stringify(value).length > MAX_CANDIDATE_JSON)
						errors.push({ path: `${at}/${name}`, message: `must be an object of at most ${MAX_CANDIDATE_JSON} bytes` });
				}
				if (isObject(strings) && Object.values(strings).some((v) => typeof v !== 'string'))
					errors.push({ path: `${at}/strings`, message: 'values must be strings' });
				candidates.push({
					appId,
					key,
					...(isObject(config) ? { config } : {}),
					...(isObject(strings) ? { strings } : {}),
					...(isObject(placement) ? { placement } : {}),
				});
			});
		if (errors.length > 0) fail('validation_failed', 'The preview request is invalid.', { errors });
		return { base: /** @type {'current' | 'empty'} */ (base), elements: candidates, path: /** @type {string} */ (path) };
	};

	/**
	 * Build (but do not store) the bundle of a website.
	 * @param {{ websiteId: string, merchantId?: string | null, candidates?: { base: 'current' | 'empty', elements: Candidate[] } | null }} input
	 */
	const build = async ({ websiteId, merchantId = null, candidates = null }) => {
		store();
		const website = await loadWebsite(websiteId, merchantId);
		/** @type {Warning[]} */
		const warnings = [];
		const sources = website.status === 'active' ? await gatherSources(website, candidates?.elements ?? [], warnings) : [];
		const overrides = await overridesFor(website.websiteId);
		const selection = selectElements(sources, candidates, {
			language: typeof website.language === 'string' ? website.language : null,
			overrides,
		});
		warnings.push(...selection.warnings);
		const conflicts = keyConflicts(selection.selected);
		if (conflicts.length > 0) fail('conflict', 'A product delivers the same element twice.', { errors: conflicts });
		const measured = measureSelected(selection.selected, sources);
		for (const shared of measured.shared)
			if (shared.declaredKb === null)
				warnings.push({
					code: 'shared_undeclared',
					appId: shared.appId,
					detail: `the elements share ${Math.ceil(shared.gzipBytes / 102.4) / 10} KB gzip of chunks but the product declares no budget.shared`,
				});
		const alias = await ensureAlias(
			website,
			measured.selected.flatMap((s) => s.readScopes ?? []),
		);
		const prepared = [];
		for (const selected of measured.selected) {
			const placed = compilePlacement(selected.placement);
			if (!placed.ok) {
				warnings.push({ code: placed.code, appId: selected.appId, key: selected.key, detail: placed.detail });
				continue;
			}
			prepared.push({ ...selected, compiledPlacement: placed.placement, audience: placed.audience });
		}
		const audience = prepared.some((p) => p.audience) ? runtime.audience : null;
		const data = bundleData({
			websiteId,
			env: website.env,
			version: '',
			publicKey: alias.publicKey.key,
			eventsUrl,
			assetBase,
			elements: prepared,
		});
		const { version, text } = versionedLoader({ data, core: runtime.core, audience });
		const budget = checkBudget({
			loaderGzipBytes: gzipSize(text),
			limitKb: ctx.config.delivery.budgetKb,
			elements: prepared,
			shared: measured.shared,
		});
		if (!budget.ok)
			fail(
				'delivery_budget_exceeded',
				`The bundle needs ${budget.report.totalKb} KB gzip (loader ${budget.report.loaderKb} KB + elements ${budget.report.elementsKb} KB + shared ${budget.report.sharedKb} KB); the website budget is ${budget.report.limitKb} KB.`,
				{ errors: budget.offenders },
			);
		const manifest = bundleManifest({
			websiteId,
			env: website.env,
			version,
			text,
			portalOrigin,
			core: runtime.core,
			audience,
			budget: budget.report,
			elements: prepared,
			warnings,
		});
		return { website, alias, version, text, manifest };
	};

	// ------------------------------------------------------------------------------------------------------------
	// per-website string overrides (F.18)

	/**
	 * A website's string overrides for the compiler: `<appId>:<element key>` → language (or `*`) → strings.
	 * @param {string} websiteId
	 * @returns {Promise<Map<string, Record<string, Record<string, string>>>>}
	 */
	const overridesFor = async (websiteId) => {
		/** @type {Array<Record<string, any>>} */
		const docs = await stringOverrides.find({ websiteId }).toArray();
		return new Map(docs.map((doc) => [`${doc.appId}:${doc.element}`, isObject(doc.languages) ? doc.languages : {}]));
	};

	/** @param {Record<string, any>} doc */
	const overrideView = (doc) => ({
		appId: doc.appId,
		element: doc.element,
		languages: isObject(doc.languages) ? doc.languages : {},
		updatedAt: iso(doc.updatedAt),
	});

	/**
	 * The merchant's string overrides of a website (`GET …/delivery/strings`).
	 * @param {{ merchantId: string, websiteId: string }} input
	 */
	const listStringOverrides = async ({ merchantId, websiteId }) => {
		await loadWebsite(websiteId, merchantId);
		/** @type {Array<Record<string, any>>} */
		const docs = await stringOverrides.find({ websiteId }).sort({ appId: 1, element: 1 }).toArray();
		return { items: docs.map(overrideView) };
	};

	/**
	 * Replace one element's string overrides for one language (`PUT …/delivery/strings/:appId/:element/:language`,
	 * `language` a BCP 47 tag or `*` for every language; an empty object removes them) and recompile the website.
	 * @param {{ merchantId: string, websiteId: string, appId: string, element: string, language: string, body: unknown,
	 *   actor: Actor, requestId?: string | null, ip?: string | null }} input
	 */
	const setStringOverride = async ({
		merchantId,
		websiteId,
		appId,
		element,
		language,
		body,
		actor,
		requestId = null,
		ip = null,
	}) => {
		const website = await loadWebsite(websiteId, merchantId);
		const checked = checkStringOverride({ appId, element, language, body });
		if (!checked.ok) return fail('validation_failed', 'The string override is invalid.', { errors: checked.errors });
		const subscribed = /** @type {Array<{ appId: string, cancelledAt: string | null }>} */ (
			await commerce().subscriptionsForWebsite(website.websiteId)
		).some((sub) => sub.appId === appId && !sub.cancelledAt);
		if (!subscribed) return fail('not_found', 'The website has no subscription to this product.');
		const manifest = /** @type {import('@ss/contracts').Manifest} */ (
			await catalog().getManifest(appId, (await catalog().getApp(appId)).currentVersion)
		);
		if (!manifest.elements.some((e) => e.key === element && e.modes.includes('A')))
			return fail('not_found', 'The product has no drop-in element with this key.');
		const _id = `${website.websiteId}:${appId}:${element}`;
		const before = await stringOverrides.findOne({ _id });
		const languages = { ...(isObject(before?.languages) ? before.languages : {}) };
		if (Object.keys(checked.strings).length === 0) delete languages[language];
		else languages[language] = checked.strings;
		if (Object.keys(languages).length === 0) await stringOverrides.deleteOne({ _id });
		else
			await stringOverrides.updateOne(
				{ _id },
				{
					$set: { websiteId: website.websiteId, merchantId: website.merchantId, appId, element, languages },
				},
				{ upsert: true },
			);
		await audit(
			actor,
			'delivery.strings_updated',
			{ type: 'website', id: website.websiteId, merchantId: website.merchantId, websiteId: website.websiteId },
			{
				before: { language, keys: Object.keys(before?.languages?.[language] ?? {}) },
				after: { language, keys: Object.keys(checked.strings) },
				requestId,
				ip,
			},
		);
		await requestCompile(website.websiteId, { reason: 'strings.updated' }).catch((error) =>
			ctx.logger.warn('recompile not requested', { websiteId: website.websiteId, error }),
		);
		return overrideView({ appId, element, languages, updatedAt: new Date(ctx.now()) });
	};

	/** @param {Record<string, any>} doc */
	const artefactView = (doc) => ({
		version: doc.version,
		seq: doc.seq,
		integrity: doc.integrity,
		sha256: doc.sha256,
		bytes: doc.bytes,
		gzipBytes: doc.gzipBytes,
		budget: doc.budget,
		elements: doc.elements,
		warnings: doc.warnings,
		reason: doc.reason ?? null,
		createdAt: iso(doc.createdAt),
		url: `${portalUrl}/w/${doc.websiteId}/${doc.version}/loader.js`,
	});

	/**
	 * Compile, store the immutable artefact and flip the alias (unless a newer compile already did).
	 * @param {{ websiteId: string, merchantId?: string | null, actor?: Actor, reason?: string, request?: number | null,
	 *   requestId?: string | null, ip?: string | null }} input
	 */
	const compile = async ({
		websiteId,
		merchantId = null,
		actor = SYSTEM,
		reason = 'manual',
		request = null,
		requestId = null,
		ip = null,
	}) => {
		const { website, alias, version, text, manifest } = await build({ websiteId, merchantId });
		const aliasId = String(alias._id);
		const artefactId = `${websiteId}:${website.env}:${version}`;
		const prefix = `w/${websiteId}/${website.env}/${version}`;
		let artefact = await artefacts.findOne({ _id: artefactId });
		if (!artefact) {
			const bytes = Buffer.from(text, 'utf8');
			await store().put(`${prefix}/loader.js`, bytes, { contentType: JS, cacheControl: IMMUTABLE });
			await store().put(`${prefix}/manifest.json`, Buffer.from(canonicalJson(manifest), 'utf8'), {
				contentType: 'application/json',
				cacheControl: IMMUTABLE,
			});
			const counter = /** @type {Record<string, any>} */ (
				await aliases.findOneAndUpdate({ _id: aliasId }, { $inc: { artefactSeq: 1 } })
			);
			const doc = {
				_id: artefactId,
				websiteId,
				merchantId: website.merchantId,
				env: website.env,
				version,
				seq: counter.artefactSeq,
				integrity: manifest.integrity,
				sha256: manifest.sha256,
				bytes: manifest.bytes,
				gzipBytes: manifest.gzipBytes,
				budget: manifest.budget,
				csp: manifest.csp,
				elements: manifest.elements.map((e) => ({
					appId: e.appId,
					slug: e.slug,
					key: e.key,
					kind: e.kind,
					budgetKb: e.budgetKb,
				})),
				warnings: manifest.warnings,
				loaderKey: `${prefix}/loader.js`,
				manifestKey: `${prefix}/manifest.json`,
				reason,
				createdBy: actor.id,
			};
			try {
				await artefacts.insertOne(doc);
				artefact = doc;
			} catch (error) {
				artefact = await artefacts.findOne({ _id: artefactId });
				if (!artefact) throw error;
			}
		}
		const view = artefactView(/** @type {Record<string, any>} */ (artefact));
		if (alias.version === version) {
			if (request !== null)
				await aliases.updateOne(
					{ _id: aliasId, compiledRequest: { $lt: request } },
					{ $set: { compiledRequest: request, lastFailure: null } },
				);
			return { changed: false, version, artefact: view, warnings: manifest.warnings };
		}
		const at = new Date(ctx.now());
		const seq = request ?? Number(alias.requested ?? 0);
		const flipped = await aliases.findOneAndUpdate(
			{ _id: aliasId, compiledRequest: { $lte: seq } },
			{
				$set: { version, flippedAt: at, compiledRequest: seq, previousVersion: alias.version ?? null, lastFailure: null },
				$push: { history: { $each: [{ version, at, by: actor.id, reason }], $slice: -HISTORY } },
			},
		);
		if (!flipped) return { changed: false, stale: true, version, artefact: view, warnings: manifest.warnings };
		await audit(
			actor,
			'delivery.alias_flipped',
			{ type: 'website', id: websiteId, merchantId: website.merchantId, websiteId },
			{ before: { version: alias.version ?? null }, after: { version, integrity: manifest.integrity }, reason, requestId, ip },
		);
		return { changed: true, version, previousVersion: alias.version ?? null, artefact: view, warnings: manifest.warnings };
	};

	/**
	 * Ask for a recompile (called by commerce whenever an entitlement document version is bumped). Cheap: one counter
	 * increment and one deduplicated job; the job skips itself when a newer request exists.
	 * @param {string} websiteId
	 * @param {{ reason?: string }} [options]
	 */
	const requestCompile = async (websiteId, { reason = 'entitlement.changed' } = {}) => {
		const website = await loadWebsite(websiteId);
		const _id = `${websiteId}:${website.env}`;
		const doc = /** @type {Record<string, any>} */ (
			await aliases.findOneAndUpdate(
				{ _id },
				{
					$inc: { requested: 1 },
					$setOnInsert: {
						websiteId,
						merchantId: website.merchantId,
						env: website.env,
						version: null,
						artefactSeq: 0,
						compiledRequest: 0,
						publicKey: null,
						history: [],
						lastFailure: null,
					},
				},
				{ upsert: true },
			)
		);
		const job = await ctx.jobs.enqueue({
			name: COMPILE_JOB,
			payload: { websiteId, request: doc.requested, reason },
			key: `${COMPILE_JOB}:${websiteId}:${doc.requested}`,
			maxAttempts: 5,
		});
		return { websiteId, request: doc.requested, jobId: job.id };
	};

	/**
	 * Job `delivery.compile`.
	 * @param {{ websiteId: string, request: number, reason?: string }} payload
	 */
	const runCompileJob = async (payload) => {
		const alias = await aliases.findOne({ websiteId: payload.websiteId });
		if (alias && Number(alias.requested) > payload.request) return { skipped: 'superseded' };
		try {
			return await compile({
				websiteId: payload.websiteId,
				reason: payload.reason ?? 'entitlement.changed',
				request: payload.request,
			});
		} catch (error) {
			if (isObject(error) && (error.code === 'delivery_budget_exceeded' || error.code === 'conflict')) {
				await aliases.updateOne(
					{ websiteId: payload.websiteId },
					{
						$set: {
							lastFailure: { code: error.code, detail: error.detail, errors: error.errors ?? [], at: new Date(ctx.now()) },
						},
					},
				);
				ctx.logger.warn('delivery compile refused', { websiteId: payload.websiteId, code: error.code });
				return { refused: error.code };
			}
			throw error;
		}
	};

	/**
	 * Flip the alias back to an earlier artefact of the website.
	 * @param {{ websiteId: string, merchantId?: string | null, version: unknown, actor: Actor, requestId?: string | null, ip?: string | null }} input
	 */
	const rollback = async ({ websiteId, merchantId = null, version, actor, requestId = null, ip = null }) => {
		const website = await loadWebsite(websiteId, merchantId);
		if (typeof version !== 'string' || !VERSION_PATTERN.test(version))
			fail('validation_failed', 'version must be a bundle version.', { errors: [{ path: '/version', message: 'invalid' }] });
		const aliasId = `${websiteId}:${website.env}`;
		const alias = (await aliases.findOne({ _id: aliasId })) ?? fail('not_found', 'The website has no compiled bundle.');
		const target =
			(await artefacts.findOne({ _id: `${websiteId}:${website.env}:${version}` })) ??
			fail('not_found', `No version ${version}.`);
		if (alias.version === version) return { changed: false, version, artefact: artefactView(target) };
		const at = new Date(ctx.now());
		const flipped = await aliases.findOneAndUpdate(
			{ _id: aliasId, version: alias.version },
			{
				$set: { version, flippedAt: at, previousVersion: alias.version },
				$push: { history: { $each: [{ version, at, by: actor.id, reason: 'rollback' }], $slice: -HISTORY } },
			},
		);
		if (!flipped) fail('conflict', 'The alias changed concurrently; retry.');
		await audit(
			actor,
			'delivery.rolled_back',
			{ type: 'website', id: websiteId, merchantId: website.merchantId, websiteId },
			{ before: { version: alias.version }, after: { version }, requestId, ip },
		);
		return { changed: true, version, previousVersion: alias.version, artefact: artefactView(target) };
	};

	/**
	 * Delivery state of a website for consoles.
	 * @param {{ websiteId: string, merchantId?: string | null }} input
	 */
	const status = async ({ websiteId, merchantId = null }) => {
		const website = await loadWebsite(websiteId, merchantId);
		const alias = await aliases.findOne({ _id: `${websiteId}:${website.env}` });
		const recent = await artefacts.find({ websiteId, env: website.env }).sort({ seq: -1 }).limit(HISTORY).toArray();
		return {
			websiteId,
			env: website.env,
			version: alias?.version ?? null,
			previousVersion: alias?.previousVersion ?? null,
			flippedAt: iso(alias?.flippedAt),
			requested: alias?.requested ?? 0,
			compiledRequest: alias?.compiledRequest ?? 0,
			lastFailure: alias?.lastFailure ? { ...alias.lastFailure, at: iso(alias.lastFailure.at) } : null,
			history: (alias?.history ?? []).map((/** @type {Record<string, any>} */ h) => ({ ...h, at: iso(h.at) })).reverse(),
			publicKeyId: alias?.publicKey?.keyId ?? null,
			aliasUrl: `${portalUrl}/w/${websiteId}/loader.js`,
			artefacts: recent.map(artefactView),
		};
	};

	/**
	 * The `<script>` tags for the merchant console.
	 * @param {{ websiteId: string, merchantId?: string | null }} input
	 */
	const snippet = async ({ websiteId, merchantId = null }) => {
		const website = await loadWebsite(websiteId, merchantId);
		const alias = await aliases.findOne({ _id: `${websiteId}:${website.env}` });
		if (!alias?.version) return fail('not_found', 'The website has no compiled bundle yet.');
		const artefact = /** @type {Record<string, any>} */ (
			await artefacts.findOne({ _id: `${websiteId}:${website.env}:${alias.version}` })
		);
		const immutableUrl = `${portalUrl}/w/${websiteId}/${alias.version}/loader.js`;
		const aliasUrl = `${portalUrl}/w/${websiteId}/loader.js`;
		return {
			websiteId,
			env: website.env,
			version: alias.version,
			immutable: {
				url: immutableUrl,
				integrity: artefact.integrity,
				tag: `<script src="${immutableUrl}" integrity="${artefact.integrity}" crossorigin="anonymous" defer></script>`,
				note: 'Pinned to this exact version (Subresource Integrity). Update the tag after every change to the website’s elements.',
			},
			alias: {
				url: aliasUrl,
				tag: `<script src="${aliasUrl}" crossorigin="anonymous" defer></script>`,
				note: 'Recommended: always serves the current version (cached up to 60 s, revalidated in the background). No integrity attribute, because the content changes when elements change; the response carries X-SS-Integrity for monitoring.',
			},
			csp: artefact.csp,
		};
	};

	// ------------------------------------------------------------------------------------------------------------
	// serving

	/**
	 * @param {{ ifNoneMatch?: string | null, etag: string }} input
	 */
	const notModified = ({ ifNoneMatch, etag }) =>
		typeof ifNoneMatch === 'string' &&
		ifNoneMatch
			.split(',')
			.map((s) => s.trim().replace(/^W\//, ''))
			.some((s) => s === etag || s === '*');

	/**
	 * `GET /w/<websiteId>/loader.js` (alias) and `GET /w/<websiteId>/<version>/loader.js|manifest.json` (immutable).
	 * @param {{ websiteId: string, version?: string | null, file?: 'loader.js' | 'manifest.json', ifNoneMatch?: string | null }} input
	 * @returns {Promise<Response>}
	 */
	const serveBundle = async ({ websiteId, version = null, file = 'loader.js', ifNoneMatch = null }) => {
		if (!isId(websiteId, 'web') || (version !== null && !VERSION_PATTERN.test(version)))
			return fail('not_found', 'No such bundle.');
		const pinned = version !== null;
		/** @type {string | null} */
		let current = version;
		if (!pinned) {
			const alias = await aliases.findOne({ websiteId });
			current = alias?.version ?? null;
		}
		if (current === null) return fail('not_found', 'No bundle is published for this website.');
		const artefact = (await artefacts.findOne({ websiteId, version: current })) ?? fail('not_found', 'No such bundle.');
		const key = file === 'loader.js' ? artefact.loaderKey : artefact.manifestKey;
		const etag = `"${current}${file === 'manifest.json' ? '-m' : ''}"`;
		const headers = {
			...servedHeaders(),
			'content-type': file === 'loader.js' ? JS : 'application/json',
			'cache-control': pinned ? IMMUTABLE : ALIAS_CACHE,
			etag,
			'x-ss-version': current,
			...(file === 'loader.js' ? { 'x-ss-integrity': artefact.integrity } : {}),
		};
		if (notModified({ ifNoneMatch, etag })) return new Response(null, { status: 304, headers });
		const object = (await store().get(String(key))) ?? fail('not_found', 'The bundle is missing from asset storage.');
		return new Response(/** @type {any} */ (object.body), { status: 200, headers });
	};

	/**
	 * `GET /w/packs/<appId>/<version>/<path>` (pack asset) and `GET /w/ui/<appId>/<version>/<path>` (service UI-bundle
	 * asset) — uploaded, hash-verified modules.
	 * @param {{ appId: string, version: string, path: string, ifNoneMatch?: string | null, bundle?: 'pack' | 'ui' }} input
	 * @returns {Promise<Response>}
	 */
	const serveAsset = async ({ appId, version, path, ifNoneMatch = null, bundle = 'pack' }) => {
		const n = Number(version);
		if (!isId(appId, 'app') || !Number.isSafeInteger(n) || n < 1 || !isAssetPath(path))
			return fail('not_found', 'No such asset.');
		const record =
			(await assets.findOne({ _id: `${bundle === 'ui' ? 'ui:' : ''}${appId}:${n}:${path}` })) ??
			fail('not_found', 'No such asset.');
		const etag = `"${record.sha256}"`;
		const headers = {
			...servedHeaders(),
			'content-type': record.contentType === 'text/javascript' ? JS : String(record.contentType),
			'cache-control': IMMUTABLE,
			etag,
		};
		if (notModified({ ifNoneMatch, etag })) return new Response(null, { status: 304, headers });
		const object =
			(await store().get(String(record.storageKey))) ?? fail('not_found', 'The asset is missing from asset storage.');
		return new Response(/** @type {any} */ (object.body), { status: 200, headers });
	};

	// ------------------------------------------------------------------------------------------------------------
	// preview

	/**
	 * Create a preview session with a candidate element set.
	 * @param {{ merchantId: string, websiteId: string, body: unknown, actor: Actor, requestId?: string | null, ip?: string | null }} input
	 */
	const createPreview = async ({ merchantId, websiteId, body, actor, requestId = null, ip = null }) => {
		const candidates = parseCandidates(body);
		const website = await loadWebsite(websiteId, merchantId);
		if (website.status !== 'active') fail('conflict', 'The website is not active.');
		const built = await build({ websiteId, merchantId, candidates });
		const previewId = createId('prv', { randomBytes: ctx.randomBytes });
		const now = ctx.now();
		const exp = now + PREVIEW_TTL_MS;
		const origin = `https://${website.domain}`;
		await previews.insertOne({
			_id: previewId,
			merchantId,
			websiteId,
			origin,
			path: candidates.path,
			candidates: candidates.elements.map((c) => ({ appId: c.appId, key: c.key })),
			base: candidates.base,
			version: built.version,
			bundle: built.text,
			connectOrigins: built.manifest.csp.connectSrc,
			createdBy: actor.id,
			expireAt: new Date(exp),
		});
		await audit(
			actor,
			'delivery.preview_created',
			{ type: 'website', id: websiteId, merchantId, websiteId },
			{ after: { previewId, version: built.version, candidates: candidates.elements.length }, requestId, ip },
		);
		const token = signPreviewToken(previewKey, { previewId, merchantId, websiteId, exp });
		return {
			previewId,
			url: `${previewOrigin ?? portalUrl}/p/${token}${candidates.path}`,
			expiresAt: new Date(exp).toISOString(),
			version: built.version,
			budget: built.manifest.budget,
			elements: built.manifest.elements,
			warnings: built.manifest.warnings,
		};
	};

	/**
	 * Rate-limit subject of a preview request: the merchant of a valid token, else the client.
	 * @param {string} token
	 * @param {string | null} ip
	 */
	const previewSubject = (token, ip) => {
		const claims = verifyPreviewToken(previewKey, token, ctx.now());
		return claims ? `merchant:${claims.merchantId}` : `ip:${ip ?? 'unknown'}`;
	};

	/**
	 * `GET /p/<token>/<path>`: the merchant's public page with the candidate bundle injected. With a dedicated preview
	 * origin, only requests to that host are served (the Portal host refuses previews).
	 * @param {{ token: string, path: string, search?: string, host?: string | null }} input
	 * @returns {Promise<Response>}
	 */
	const servePreview = async ({ token, path, search = '', host = null }) => {
		if (previewHost !== null && host !== previewHost)
			return fail('delivery_preview_refused', `Previews are served from ${previewOrigin} only.`);
		const claims = verifyPreviewToken(previewKey, token, ctx.now()) ?? fail('not_found', 'The preview has expired.');
		const session = await previews.findOne({ _id: claims.previewId, websiteId: claims.websiteId });
		if (!session || new Date(session.expireAt).getTime() <= ctx.now()) return fail('not_found', 'The preview has expired.');
		const url =
			targetUrl(String(session.origin), path, search) ?? fail('delivery_preview_refused', 'The path leaves the website.');
		/** @type {import('@ss/net').SafeResponse} */
		let response;
		try {
			response = await fetch(
				url.href,
				{ method: 'GET', headers: { accept: 'text/html,application/xhtml+xml;q=0.9' }, redirect: 'follow' },
				pagePolicy,
			);
		} catch (error) {
			if (!isNetError(error)) throw error;
			if (error.code === 'timeout') return fail('timeout', 'The website did not answer in time.');
			if (error.code === 'too_large') return fail('upstream_error', `The page is larger than ${MAX_PAGE_BYTES} bytes.`);
			if (error.code === 'network') return fail('upstream_error', 'The website could not be reached.');
			return fail('delivery_preview_refused', `The page cannot be previewed (${error.code}).`);
		}
		if (new URL(response.url).origin !== session.origin)
			return fail('delivery_preview_refused', 'The page redirects off the website.');
		if (response.status < 200 || response.status >= 300)
			return fail('upstream_error', `The website answered ${response.status}.`);
		if (!isHtml(response.headers['content-type'])) return fail('delivery_preview_refused', 'The page is not HTML.');
		const nonce = Buffer.from(ctx.randomBytes(16)).toString('base64');
		const html = injectPreview({
			html: decodePage(response.body, response.headers['content-type']),
			pageUrl: response.url,
			script: String(session.bundle),
			nonce,
		});
		return new Response(html, {
			status: 200,
			headers: previewHeaders({
				nonce,
				origin: String(session.origin),
				portalOrigin,
				connectOrigins: Array.isArray(session.connectOrigins) ? session.connectOrigins.map(String) : [],
				dedicated: previewHost !== null,
			}),
		});
	};

	return {
		// other modules
		requestCompile,
		compile,
		// consoles
		status,
		snippet,
		rollback,
		createPreview,
		listStringOverrides,
		setStringOverride,
		// developers / staff
		uploadAsset,
		// service products (F.16)
		submitUiBundle,
		uploadUiAsset,
		listUiBundles,
		// public serving
		serveBundle,
		serveAsset,
		servePreview,
		previewSubject,
		// jobs
		runCompileJob,
	};
};
/** @typedef {ReturnType<typeof createDeliveryService>} DeliveryService */
