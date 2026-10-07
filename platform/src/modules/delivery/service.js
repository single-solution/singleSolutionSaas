/**
 * Public service of the `delivery` module (PLAN §4): pack and widget asset storage, the website-bundle compiler with
 * immutable versioned artefacts and an atomically flipped alias, serving and snippets.
 *
 * - **Assets** (`uploadAsset`, one route for both app kinds): staff upload each file named by the descriptor of an
 *   `ss pack build` output; the bytes must match its SHA-256 and size. Packs: the descriptor of the catalog version
 *   (`catalog.versionDetail`); when the last asset lands the version becomes current (`catalog.versionReady`).
 *   Service products: the widget bundle `registerWidgets` stored; when the last asset lands it is `ready`. Either way
 *   every website subscribed to the app then recompiles. Stored at `packs/<appId>/<version>/<path>` in platform
 *   asset storage (our artefacts — never client data).
 * - **Compile** (`compile`, job `delivery.compile` via `requestCompile`): verified entitlement documents (commerce
 *   `documentFor`, checked with the Portal keys) × accepted manifests → `w/<websiteId>/<env>/<version>/loader.js` +
 *   `manifest.json`; the alias in `delivery_aliases` flips with a compare-and-set so an older compile never replaces
 *   a newer one. Pack elements ship the pack's modules; service elements the newest ready widget bundle's modules,
 *   with their element API client bound to the product's base URL.
 * - **Serve**: `/w/<websiteId>/loader.js` (alias, 60 s + stale-while-revalidate), `/w/<websiteId>/<version>/…` and
 *   `/w/packs/<appId>/<version>/<path>` (pack and widget modules), both immutable.
 * @module
 */
import { isId } from '@ss/contracts';
import { createOutboundPolicy, safeFetch as netFetch } from '@ss/net';
import { canonicalJson, verifyEntitlementDocument } from '@ss/protocol';
import { problem } from '../../infra/http.js';
import { afterResponse } from '../../infra/request-scope.js';
import { checkUpload, isAssetPath, sha256Hex } from './core/assets.js';
import {
	LANGUAGE_CATALOG,
	VERSION_PATTERN,
	bundleData,
	bundleManifest,
	compilePlacement,
	keyConflicts,
	parseModuleRef,
	selectElements,
	versionedLoader,
} from './core/compile.js';
import { checkStringOverride } from './core/strings.js';
import { RUNTIME_AUDIENCE, RUNTIME_CORE } from './runtime/generated.js';
import { ALIASES, ARTEFACTS, ASSETS, STRINGS, WIDGETS } from './schema.js';
import { createAssetStorage, withImmutableCache } from './storage.js';

/** @typedef {import('../../infra/modules.js').ModuleContext} ModuleContext */
/** @typedef {import('../../infra/rbac.js').Actor} Actor */
/** @typedef {import('./storage.js').AssetStorage} AssetStorage */
/** @typedef {import('./core/compile.js').Source} Source */
/** @typedef {import('./core/compile.js').ElementModules} ElementModules */
/** @typedef {import('./core/compile.js').Warning} Warning */
/** @typedef {{ path: string, sha256: string, size: number, contentType?: string }} DeclaredAsset */
/**
 * @typedef {(url: string, init: import('@ss/net').SafeFetchInit, policy: import('@ss/net').OutboundPolicy) =>
 *   Promise<import('@ss/net').SafeResponse>} SafeFetch
 */

/**
 * @typedef {object} DeliveryOptions
 * @property {AssetStorage | null} [storage] asset storage (default: from `STORAGE_*`)
 * @property {SafeFetch} [fetch] outbound HTTP client of the S3 adapter — default `@ss/net` `safeFetch`
 * @property {import('@ss/net').Resolver} [resolve] DNS resolver of the outbound policy (tests)
 * @property {ReadonlyArray<string>} [allowHosts] development allowlist (default `ctx.config.outbound.allowHosts`;
 *   always empty in production)
 * @property {{ core: string, audience: string }} [runtime] browser runtime (default: `runtime/generated.js`)
 */

export const COMPILE_JOB = 'delivery.compile';
/** Time budget of a compile retried after serving the website's loader. */
const COMPILE_RETRY_BUDGET_MS = 8_000;
/** @param {string} websiteId */
const compileGroup = (websiteId) => `delivery.website:${websiteId}`;
export const LOADER_SCOPES = Object.freeze(['events.write', 'elements.read']);
const SYSTEM = /** @type {Actor} */ ({ type: 'system', id: 'delivery' });
const JS = 'text/javascript; charset=utf-8';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const ALIAS_CACHE = 'public, max-age=60, stale-while-revalidate=600';
const ASSET_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";
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

/** @param {string} appId @param {number} version */
const uploadPath = (appId, version) => `/v1/admin/packs/${appId}/versions/${version}/assets/`;

/**
 * The widget elements of a service product's `ss pack build` descriptor: each manifest element with a headless and a
 * renderer module that the descriptor ships.
 * @param {unknown} descriptor
 * @returns {{ elements: ElementModules[], assets: DeclaredAsset[] }}
 */
const widgetsOf = (descriptor) => {
	const manifest = isObject(descriptor) && isObject(descriptor.manifest) ? descriptor.manifest : {};
	const listed = isObject(descriptor) && Array.isArray(descriptor.assets) ? descriptor.assets : [];
	/** @type {DeclaredAsset[]} */
	const assets = listed
		.filter((a) => isObject(a) && isAssetPath(a.path) && typeof a.sha256 === 'string' && Number.isSafeInteger(a.size))
		.map((a) => ({ path: a.path, sha256: a.sha256, size: a.size, ...(a.contentType ? { contentType: a.contentType } : {}) }));
	const paths = new Set(assets.map((a) => a.path));
	const shipped = (/** @type {unknown} */ ref) => {
		const parsed = parseModuleRef(ref);
		return parsed !== null && paths.has(parsed.path);
	};
	/** @type {ElementModules[]} */
	const elements = (Array.isArray(manifest.elements) ? manifest.elements : [])
		.filter((e) => isObject(e) && typeof e.key === 'string' && shipped(e.headless) && shipped(e.renderer))
		.map((e) => ({
			key: e.key,
			headless: e.headless,
			renderer: e.renderer,
			...(typeof e.strings === 'string' ? { strings: e.strings } : {}),
			...(Array.isArray(e.stringKeys) ? { stringKeys: e.stringKeys } : {}),
		}));
	if (assets.length !== listed.length || assets.length === 0 || elements.length === 0)
		fail('validation_failed', 'The descriptor ships no widget modules.', {
			errors: [
				{ path: '/descriptor', message: 'needs assets and mode-A elements with uploaded headless and renderer modules' },
			],
		});
	return { elements, assets };
};

/**
 * @param {ModuleContext} ctx
 * @param {DeliveryOptions} [options]
 */
export const createDeliveryService = (ctx, options = {}) => {
	const allowHosts = ctx.config.isProduction ? [] : [...(options.allowHosts ?? ctx.config.outbound.allowHosts)];
	const resolve = options.resolve ? { resolve: options.resolve } : {};
	const policy = createOutboundPolicy({ allowHosts, ...resolve, maxBytes: 8 * 1024 * 1024, timeoutMs: 15_000 });
	const fetch = options.fetch ?? netFetch;
	const configured =
		options.storage === undefined
			? createAssetStorage(ctx.config.delivery.storage, { policy, fetch: /** @type {any} */ (fetch), now: ctx.now })
			: options.storage;
	const storage = configured ? withImmutableCache(configured) : null;
	const runtime = options.runtime ?? { core: RUNTIME_CORE, audience: RUNTIME_AUDIENCE };
	// the Portal's address is the current request's origin, so it is read when used
	// element modules: `packs/<appId>/<version>/<path>` below the asset base
	const assetBase = () => `${ctx.config.portalUrl}/w/`;

	const assets = ctx.collection(ASSETS);
	const artefacts = ctx.collection(ARTEFACTS);
	const aliases = ctx.collection(ALIASES);
	const widgets = ctx.collection(WIDGETS);
	const stringOverrides = ctx.collection(STRINGS);
	const identity = () => ctx.service('identity');
	const catalog = () => ctx.service('catalog');
	const commerce = () => ctx.service('commerce');

	const store = () => storage ?? fail('unavailable', 'Platform asset storage is not configured (STORAGE_BUCKET).');

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
	// pack and widget assets

	/** Recompile every website subscribed to an app (best effort; each request coalesces per website). */
	const recompileApp = async (/** @type {string} */ appId, /** @type {string} */ reason) => {
		/** @type {string[]} */
		let websiteIds = [];
		try {
			const listed = await commerce().websitesOfApp(appId);
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
	 * Declared paths whose stored asset is missing (or has another hash).
	 * @param {string} appId
	 * @param {number} version
	 * @param {ReadonlyArray<DeclaredAsset>} declared
	 */
	const missingAssets = async (appId, version, declared) => {
		/** @type {Array<Record<string, any>>} */
		const stored = await assets.find({ appId, version }).toArray();
		const have = new Map(stored.map((a) => [String(a.path), String(a.sha256)]));
		return declared.filter((a) => have.get(a.path) !== a.sha256).map((a) => a.path);
	};

	/**
	 * Mark a widget bundle ready when every declared asset is stored (idempotent), then recompile its websites.
	 * @param {Record<string, any>} bundle
	 * @param {Actor} actor
	 * @returns {Promise<{ status: 'uploading' | 'ready', missing: string[] }>}
	 */
	const settleWidgets = async (bundle, actor) => {
		const missing = await missingAssets(bundle.appId, bundle.version, bundle.assets ?? []);
		if (missing.length > 0) return { status: 'uploading', missing };
		const updated = await widgets.findOneAndUpdate(
			{ _id: bundle._id, status: 'uploading' },
			{ $set: { status: 'ready', readyAt: new Date(ctx.now()) } },
		);
		if (updated) {
			await audit(
				actor,
				'delivery.widgets_ready',
				{ type: 'app', id: bundle.appId },
				{ after: { version: bundle.version, elements: (bundle.elements ?? []).map((/** @type {any} */ e) => e.key) } },
			);
			await recompileApp(bundle.appId, 'widgets.ready');
		}
		return { status: 'ready', missing };
	};

	/**
	 * Store the widget bundle of a service product (called by catalog's `POST /v1/admin/packs` for a connected service
	 * app, after it checked the descriptor). The same descriptor is the same version; a new one gets the next version,
	 * `uploading` until its assets are uploaded with {@link uploadAsset}.
	 * @param {{ appId: string, descriptor: unknown, actor: Actor, requestId?: string | null, ip?: string | null }} input
	 * @returns {Promise<{ version: number, status: 'uploading' | 'ready', missing: string[], uploadPath: string,
	 *   changed: boolean }>} `changed`: a new version was stored
	 */
	const registerWidgets = async ({ appId, descriptor, actor, requestId = null, ip = null }) => {
		store();
		const { elements, assets: declared } = widgetsOf(descriptor);
		const descriptorHash = sha256Hex(Buffer.from(canonicalJson(/** @type {any} */ (descriptor)), 'utf8'));
		let doc = await widgets.findOne({ appId, descriptorHash });
		const changed = !doc;
		for (let attempt = 0; attempt < 5 && !doc; attempt += 1) {
			const [last] = await widgets.find({ appId }).sort({ version: -1 }).limit(1).toArray();
			const version = Number(last?.version ?? 0) + 1;
			const record = {
				_id: `${appId}:${version}`,
				appId,
				version,
				descriptorHash,
				elements,
				assets: declared,
				status: 'uploading',
				readyAt: null,
				createdBy: actor.id,
			};
			try {
				await widgets.insertOne(record);
				doc = record;
				await audit(
					actor,
					'delivery.widgets_registered',
					{ type: 'app', id: appId },
					{ after: { version, descriptorHash, elements: elements.map((e) => e.key) }, requestId, ip },
				);
			} catch (error) {
				doc = await widgets.findOne({ appId, descriptorHash });
				if (!doc && !(isObject(error) && error.code === 11000)) throw error;
			}
		}
		if (!doc) return fail('conflict', 'The widgets could not be stored concurrently; retry.');
		const settled = await settleWidgets(doc, actor);
		return { version: Number(doc.version), ...settled, uploadPath: uploadPath(appId, Number(doc.version)), changed };
	};

	/**
	 * `PUT /v1/admin/packs/:appId/versions/:version/assets/<path>`: one asset of a pack version or of a service
	 * product's widget bundle, verified against its descriptor. Completing a pack version makes it current
	 * (`catalog.versionReady`); completing a widget bundle makes it ready. Then the app's websites recompile.
	 * @param {{ appId: string, version: string | number, path: string, bytes: Uint8Array, contentType: string | null,
	 *   actor: Actor, requestId?: string | null, ip?: string | null }} input
	 */
	const uploadAsset = async ({ appId, version, path, bytes, contentType, actor, requestId = null, ip = null }) => {
		const n = Number(version);
		if (!isId(appId, 'app') || !Number.isSafeInteger(n) || n < 1) return fail('not_found', 'No such version.');
		if (!isAssetPath(path))
			fail('validation_failed', 'The asset path is invalid.', {
				errors: [{ path: '/path', message: 'must be a relative file path' }],
			});
		const app = await catalog().getApp(appId);
		/** @type {Record<string, any> | null} */
		const bundle =
			app.kind === 'pack'
				? null
				: ((await widgets.findOne({ _id: `${appId}:${n}` })) ?? fail('not_found', 'No such widget version.'));
		const detail = bundle ? null : await catalog().versionDetail(appId, n);
		if (detail?.status === 'superseded') fail('conflict', `Version ${n} is superseded; it accepts no assets.`);
		/** @type {DeclaredAsset[]} */
		const declaredAssets = (bundle ?? detail)?.assets ?? [];
		const declared = declaredAssets.find((a) => a.path === path);
		const checked = checkUpload({ path, bytes, contentType, declared });
		if (checked.errors.length > 0) {
			const first = /** @type {{ code: string }} */ (checked.errors[0]).code;
			const code =
				first === 'type_not_allowed' || first === 'content_type'
					? 'unsupported_media_type'
					: first === 'too_large'
						? 'payload_too_large'
						: 'delivery_asset_mismatch';
			fail(code, 'The asset does not match the uploaded descriptor.', { errors: checked.errors });
		}
		const sha256 = /** @type {DeclaredAsset} */ (declared).sha256;
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
		/** @type {{ status: 'uploading' | 'ready', missing: string[] }} */
		let settled;
		if (bundle) settled = await settleWidgets(bundle, actor);
		else {
			const missing = await missingAssets(appId, n, declaredAssets);
			settled = { status: missing.length > 0 ? 'uploading' : 'ready', missing };
			if (missing.length === 0 && detail?.status === 'uploading') {
				await catalog().versionReady({ appId, version: n });
				await recompileApp(appId, 'pack.ready');
			}
		}
		return {
			appId,
			version: n,
			path,
			sha256,
			size: bytes.byteLength,
			contentType: checked.contentType,
			url: `${assetBase()}packs/${appId}/${n}/${path}`,
			changed: !existing,
			...settled,
		};
	};

	// ------------------------------------------------------------------------------------------------------------
	// compiler

	/**
	 * Load the stored assets of one module directory: which files exist (path → hash) and the product string catalogs
	 * `strings/<lang>.json` plus any per-element catalog.
	 * @param {{ appId: string, version: number, elements: ReadonlyArray<ElementModules> }} input
	 * @param {Warning[]} warnings
	 */
	const loadModules = async ({ appId, version, elements }, warnings) => {
		/** @type {Array<Record<string, any>>} */
		const records = await assets.find({ appId, version }).toArray();
		/** @type {Map<string, { sha256: string, size: number }>} */
		const stored = new Map(records.map((r) => [String(r.path), { sha256: String(r.sha256), size: Number(r.size) }]));
		/** @type {Map<string, Record<string, unknown>>} */
		const strings = new Map();
		const catalogs = new Set(elements.map((element) => element.strings).filter((path) => typeof path === 'string'));
		for (const record of records) {
			const path = String(record.path);
			if (!LANGUAGE_CATALOG.test(path) && !catalogs.has(path)) continue;
			const object = await store().get(String(record.storageKey));
			try {
				if (object) strings.set(path, JSON.parse(Buffer.from(object.body).toString('utf8')));
			} catch {
				warnings.push({ code: 'strings_invalid', appId, detail: `${path} is not JSON` });
			}
		}
		return { stored, strings };
	};

	/**
	 * Inputs of one subscribed product for the compiler.
	 * @param {{ appId: string, manifestVersion: number, document: Record<string, any> }} input
	 * @param {Warning[]} warnings
	 * @returns {Promise<Source & { active: boolean }>}
	 */
	const sourceOf = async ({ appId, manifestVersion, document }, warnings) => {
		const app = await catalog().getApp(appId);
		const manifest = /** @type {import('@ss/contracts').Manifest} */ (await catalog().getManifest(appId, manifestVersion));
		const modeA = manifest.elements.filter((element) => element.modes.includes('A'));
		/** @type {import('./core/compile.js').Widgets | null} */
		let found = null;
		let loaded = { stored: new Map(), strings: new Map() };
		if (app.kind === 'pack') loaded = await loadModules({ appId, version: manifestVersion, elements: modeA }, warnings);
		else {
			const [bundle] = await widgets.find({ appId, status: 'ready' }).sort({ version: -1 }).limit(1).toArray();
			if (bundle) {
				const keys = new Set(modeA.map((e) => e.key));
				/** @type {ElementModules[]} */
				const elements = (bundle.elements ?? []).filter((/** @type {ElementModules} */ e) => keys.has(e.key));
				loaded = await loadModules({ appId, version: Number(bundle.version), elements }, warnings);
				found = { version: Number(bundle.version), elements: new Map(elements.map((e) => [e.key, e])) };
			}
		}
		const base = app.kind === 'service' ? (app.baseUrl ?? manifest.endpoints?.base ?? null) : null;
		return {
			appId,
			slug: manifest.product.slug,
			kind: /** @type {'pack' | 'service'} */ (app.kind),
			active: app.status === 'active',
			manifestVersion,
			manifest,
			document,
			apiBase: typeof base === 'string' ? base.replace(/\/+$/, '') : null,
			assets: loaded.stored,
			strings: loaded.strings,
			widgets: found,
		};
	};

	/**
	 * Every live subscription of the website with its verified document.
	 * @param {{ websiteId: string, domain: string, env: string }} website
	 * @param {Warning[]} warnings
	 */
	const gatherSources = async (website, warnings) => {
		/** @type {Array<Source & { active: boolean }>} */
		const sources = [];
		const subscriptions = /** @type {Array<{ appId: string, manifestVersion: number, cancelledAt: string | null }>} */ (
			await commerce().subscriptionsForWebsite(website.websiteId)
		).filter((s) => !s.cancelledAt);
		const seen = new Set();
		for (const sub of subscriptions) {
			if (seen.has(sub.appId)) continue;
			seen.add(sub.appId);
			/** @type {Record<string, any>} */
			let payload;
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
			sources.push(await sourceOf({ appId: sub.appId, manifestVersion: sub.manifestVersion, document: payload }, warnings));
		}
		return sources;
	};

	/**
	 * The alias record of a website, created on first use, with an active public key for the bundle. The key holds
	 * {@link LOADER_SCOPES} plus the product scopes the delivered elements need (the read scopes of the products pack
	 * elements read, `manifest.reads`; `<slug>.read` / `<slug>.write` of service products whose widgets are delivered);
	 * it is re-issued when it is no longer active or lacks a scope the bundle needs.
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
	 * Build (but do not store) the bundle of a website.
	 * @param {{ websiteId: string, merchantId?: string | null }} input
	 */
	const build = async ({ websiteId, merchantId = null }) => {
		store();
		const website = await loadWebsite(websiteId, merchantId);
		/** @type {Warning[]} */
		const warnings = [];
		const sources = website.status === 'active' ? await gatherSources(website, warnings) : [];
		const overrides = await overridesFor(website.websiteId);
		const selection = selectElements(sources, {
			language: typeof website.language === 'string' ? website.language : null,
			overrides,
		});
		warnings.push(...selection.warnings);
		const conflicts = keyConflicts(selection.selected);
		if (conflicts.length > 0) fail('conflict', 'A product delivers the same element twice.', { errors: conflicts });
		// product scopes are grantable only for active (listed) service products (identity's scope catalogue)
		const grantable = new Set(sources.filter((s) => s.kind === 'service' && s.active).map((s) => s.slug));
		const alias = await ensureAlias(
			website,
			selection.selected.flatMap((s) => s.readScopes).filter((scope) => grantable.has(scope.split('.')[0] ?? '')),
		);
		const prepared = [];
		for (const selected of selection.selected) {
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
			eventsUrl: `${ctx.config.portalUrl}/v1/events`,
			assetBase: assetBase(),
			elements: prepared,
		});
		const { version, text } = versionedLoader({ data, core: runtime.core, audience });
		const manifest = bundleManifest({
			websiteId,
			env: website.env,
			version,
			text,
			portalOrigin: ctx.config.portalOrigin,
			core: runtime.core,
			audience,
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
		elements: doc.elements,
		warnings: doc.warnings,
		reason: doc.reason ?? null,
		createdAt: iso(doc.createdAt),
		url: `${ctx.config.portalUrl}/w/${doc.websiteId}/${doc.version}/loader.js`,
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
				csp: manifest.csp,
				elements: manifest.elements.map((e) => ({
					appId: e.appId,
					slug: e.slug,
					key: e.key,
					kind: e.kind,
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
			group: compileGroup(websiteId),
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
			if (isObject(error) && error.code === 'conflict') {
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
			aliasUrl: `${ctx.config.portalUrl}/w/${websiteId}/loader.js`,
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
		const aliasUrl = `${ctx.config.portalUrl}/w/${websiteId}/loader.js`;
		const aliasTag = {
			url: aliasUrl,
			tag: `<script src="${aliasUrl}" crossorigin="anonymous" defer></script>`,
			note: 'Recommended: always serves the current version (cached up to 60 s, revalidated in the background). No integrity attribute, because the content changes when elements change; the response carries X-SS-Integrity for monitoring.',
		};
		// the alias URL never changes, so the install code is ready before the first compile
		if (!alias?.version) return { websiteId, env: website.env, version: null, immutable: null, alias: aliasTag, csp: null };
		const artefact = /** @type {Record<string, any>} */ (
			await artefacts.findOne({ _id: `${websiteId}:${website.env}:${alias.version}` })
		);
		const immutableUrl = `${ctx.config.portalUrl}/w/${websiteId}/${alias.version}/loader.js`;
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
			alias: aliasTag,
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
			// a requested compile that has not landed (it failed and waits for its retry): serving the website's loader
			// is the natural moment to retry it, after the response (F.19: no queue drain)
			if (alias && Number(alias.requested ?? 0) > Number(alias.compiledRequest ?? 0))
				afterResponse(() =>
					ctx.jobs.runBatch({
						handlers: { [COMPILE_JOB]: (payload) => runCompileJob(payload) },
						groups: [compileGroup(websiteId)],
						maxJobs: 1,
						deadlineMs: COMPILE_RETRY_BUDGET_MS,
						owner: 'delivery.serve',
						safetyMs: 1_000,
					}),
				);
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
	 * `GET /w/packs/<appId>/<version>/<path>`: an uploaded, hash-verified pack or widget asset.
	 * @param {{ appId: string, version: string, path: string, ifNoneMatch?: string | null }} input
	 * @returns {Promise<Response>}
	 */
	const serveAsset = async ({ appId, version, path, ifNoneMatch = null }) => {
		const n = Number(version);
		if (!isId(appId, 'app') || !Number.isSafeInteger(n) || n < 1 || !isAssetPath(path))
			return fail('not_found', 'No such asset.');
		const record = (await assets.findOne({ _id: `${appId}:${n}:${path}` })) ?? fail('not_found', 'No such asset.');
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

	return {
		// other modules
		requestCompile,
		compile,
		registerWidgets,
		// consoles
		status,
		snippet,
		listStringOverrides,
		setStringOverride,
		// staff
		uploadAsset,
		// public serving
		serveBundle,
		serveAsset,
		// jobs
		runCompileJob,
	};
};
/** @typedef {ReturnType<typeof createDeliveryService>} DeliveryService */
