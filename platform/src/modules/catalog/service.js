/**
 * Public service of the `catalog` module: app registry for service products and element packs.
 *
 * - Service onboarding (Portal side of `@ss/protocol` connect): staff add a product with its URL and the deployer's
 *   connect secret; the Portal calls its `/.well-known/ss-connect` (HMAC both ways) and pins its base URL and key.
 * - Element-pack bundle uploads (signed descriptor: manifest + asset hashes).
 * - Manifest versions: refresh (staff; the served manifest must carry a valid
 *   `SS-Manifest-Signature` made with a registered app key, otherwise it is stored as `rejected` and alerted), diff,
 *   staff approval / rejection, `manifest.accepted@1`.
 * - Lifecycle (pending → active → deprecated → retired), environments, app keys (rotation overlap, revocation).
 * - Product calls: heartbeat, key rotation, online launch consumption.
 * - Launch issuance (`@ss/protocol` `issueLaunch` with the Portal signer) and the `appKeys` port.
 * - Catalog read models (active products, elements, plans, prices in millicredits).
 *
 * Errors are thrown as `http.js` problems (RFC 9457 codes from `@ss/contracts` plus this module's `catalog_*` codes).
 * @module
 */
import { createId, validateManifest } from '@ss/contracts';
import { checkUrl, createOutboundPolicy, isNetError, safeFetch as netFetch, textOf } from '@ss/net';
import {
	MANIFEST_SIGNATURE_HEADER,
	canonicalJson,
	canonicalUrl,
	createJwks,
	createConnectRequest,
	createKeyResolver,
	hashManifest,
	isProtocolError,
	issueLaunch as protocolIssueLaunch,
	thumbprint,
	toPublicJwk,
	isConnectSecret,
	verifyBundle,
	verifyConnectResponse,
	verifyManifest,
} from '@ss/protocol';
import { problem } from '../../infra/http.js';
import { checkBundleAssets, checkUiManifest, parseBundleUpload } from './core/bundle.js';
import { diffManifests } from './core/diff.js';
import { SEEN_EVERY_MS, STALE_AFTER_MS, healthView, parseHeartbeat } from './core/health.js';
import { launchRefusal, launchUrl } from './core/launch.js';
import { applyLifecycle, dueForRetirement, reviewRefusal } from './core/lifecycle.js';
import { catalogEntry } from './core/summary.js';
import { createCatalogRepo, keyId, versionId } from './repo.js';
import { APPS, KEYS, LAUNCHES, VERSIONS } from './schema.js';

/** @typedef {import('../../infra/modules.js').ModuleContext} ModuleContext */
/** @typedef {import('../../infra/rbac.js').Actor} Actor */
/** @typedef {import('@ss/contracts').Manifest} Manifest */
/** @typedef {import('@ss/protocol').KeyResolver} KeyResolver */
/** @typedef {import('./repo.js').AppDoc} AppDoc */
/** @typedef {import('./repo.js').VersionDoc} VersionDoc */
/** @typedef {import('./repo.js').KeyDoc} KeyDoc */
/** @typedef {import('@ss/net').OutboundPolicy} OutboundPolicy */
/**
 * Outbound HTTP client (the `@ss/net` `safeFetch` signature).
 * @typedef {(url: string, init: import('@ss/net').SafeFetchInit, policy: OutboundPolicy) =>
 *   Promise<import('@ss/net').SafeResponse>} SafeFetch
 */
/** @typedef {import('./core/launch.js').LaunchInput} LaunchInput */
/** @typedef {{ actor: Actor, requestId?: string | null, ip?: string | null }} Audited */

/** Old keys keep verifying for 7 days after the product announces a new one. */
export const KEY_OVERLAP_MS = 7 * 24 * 60 * 60_000;
/** Most keys an app may hold at once (active and inside their overlap window). */
export const MAX_ACTIVE_KEYS = 5;
export const WELL_KNOWN_APP = '/.well-known/ss-app.json';
const MANIFEST_MAX_BYTES = 256 * 1024;
const SYSTEM = /** @type {Actor} */ ({ type: 'system', id: 'catalog' });

/**
 * @typedef {object} CatalogOptions
 * @property {ReadonlyArray<string>} [allowHosts] development allowlist (hosts/IPs that may be private or plain http);
 *   default `ctx.config.outbound.allowHosts`; always empty in production
 * @property {import('@ss/net').Resolver} [resolve] DNS resolver of the outbound policy (tests)
 * @property {SafeFetch} [fetch] outbound HTTP client (default: `@ss/net` `safeFetch`)
 * @property {number} [staleAfterMs]
 */

/**
 * @param {string} code
 * @param {string} detail
 * @param {{ errors?: Array<{ path: string, message: string, keyword?: string }> }} [extra]
 * @returns {never}
 */
const fail = (code, detail, extra) => {
	throw problem(code, detail, extra);
};

/**
 * @param {string} text
 * @returns {unknown}
 */
const parseJson = (text) => {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
};

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Validate a manifest with `@ss/contracts` (schema + semantics) and its expected kind.
 * @param {unknown} manifest
 * @param {'service' | 'pack'} kind
 * @param {string} [pointer] JSON pointer prefix for errors
 * @returns {Manifest}
 */
const checkedManifest = (manifest, kind, pointer = '') => {
	const result = validateManifest(manifest);
	if (!result.ok) {
		fail('invalid_manifest', 'The manifest is invalid.', {
			errors: result.problems.map((p) => ({ path: `${pointer}${p.path}`, message: p.message, keyword: p.keyword })),
		});
	}
	const value = /** @type {Manifest} */ (/** @type {{ value: Manifest }} */ (result).value);
	if (value.product.kind !== kind)
		fail('invalid_manifest', `Expected a ${kind} manifest.`, {
			errors: [{ path: `${pointer}/product/kind`, message: `must be ${kind}` }],
		});
	return value;
};

/**
 * @param {ModuleContext} ctx
 * @param {CatalogOptions} [options]
 */
export const createCatalogService = (ctx, options = {}) => {
	const stored = createCatalogRepo({
		apps: ctx.collection(APPS),
		versions: ctx.collection(VERSIONS),
		keys: ctx.collection(KEYS),
		launches: ctx.collection(LAUNCHES),
	});
	/**
	 * Retirement on read (F.19: no timer): a deprecated app whose sunset has passed is retired the first time it is
	 * read after the sunset (compare-and-set, audited once).
	 * @template {AppDoc | null} A
	 * @param {A} app
	 * @returns {Promise<A>}
	 */
	const current = async (app) => {
		if (!app || !dueForRetirement(app, ctx.now())) return app;
		const retired = await stored.updateApp(app._id, { status: 'deprecated' }, { $set: { status: 'retired' } });
		if (retired)
			await audit({
				actor: SYSTEM,
				action: 'catalog.app_retired',
				app: app._id,
				before: { status: 'deprecated' },
				after: { status: 'retired' },
				reason: 'sunset reached',
			});
		return /** @type {A} */ (retired ?? (await stored.app(app._id)) ?? app);
	};
	/** @type {typeof stored} */
	const repo = Object.freeze({
		...stored,
		app: async (appId) => current(await stored.app(appId)),
		appBySlug: async (slug) => current(await stored.appBySlug(slug)),
		listApps: async (query) => {
			/** @type {AppDoc[]} */
			const out = [];
			for (const app of await stored.listApps(query)) {
				const now = await current(app);
				if (!query.status || query.status.includes(now.status)) out.push(now);
			}
			return out;
		},
	});
	/** @type {OutboundPolicy} */
	const policy = createOutboundPolicy({
		allowHosts: ctx.config.isProduction ? [] : [...(options.allowHosts ?? ctx.config.outbound.allowHosts)],
		userAgent: 'ss-portal-catalog/1',
		...(options.resolve ? { resolve: options.resolve } : {}),
	});
	/** @type {SafeFetch} */
	const safeFetch = options.fetch ?? netFetch;
	const staleAfterMs = options.staleAfterMs ?? STALE_AFTER_MS;

	// ------------------------------------------------------------------------------------------------------------
	// helpers

	/**
	 * Canonical, SSRF-checked base URL (before any request).
	 * @param {string} value
	 * @param {string} path field name for errors
	 */
	const baseUrlOf = (value, path) => {
		/** @type {string} */
		let canonical;
		try {
			canonical = canonicalUrl(value);
		} catch {
			return fail('validation_failed', `${path} is not a valid URL.`, {
				errors: [{ path, message: 'must be a plain http(s) URL' }],
			});
		}
		const checked = checkUrl(canonical, policy);
		if (!checked.ok) fail('catalog_target_refused', `${path}: destination refused (${checked.reason}).`);
		return canonical;
	};

	/**
	 * Outbound call (`@ss/net`: URL policy, DNS-pinned guarded lookup, same-origin redirects, deadline, size cap) with
	 * network errors mapped to problems.
	 * @param {string} url
	 * @param {import('@ss/net').SafeFetchInit} init
	 */
	const outbound = async (url, init) => {
		try {
			const res = await safeFetch(url, init, policy);
			return { status: res.status, headers: res.headers, text: textOf(res) };
		} catch (error) {
			if (!isNetError(error)) throw error;
			switch (error.code) {
				case 'bad_url':
				case 'ssrf_blocked':
				case 'redirect_refused':
					return fail('catalog_target_refused', `The product address was refused (${error.reason}).`);
				case 'timeout':
					return fail('timeout', 'The product did not answer in time.');
				case 'too_large':
					return fail('upstream_error', 'The product response is too large.');
				default:
					return fail('upstream_error', `The product could not be reached (${error.reason}).`);
			}
		}
	};

	/**
	 * `GET <base>/.well-known/ss-app.json` (the manifest the product advertises) and its `SS-Manifest-Signature`.
	 * @param {string} base
	 * @returns {Promise<{ json: Record<string, any>, signature: string | null }>}
	 */
	const fetchAdvertised = async (base) => {
		const res = await outbound(`${base}${WELL_KNOWN_APP}`, {
			method: 'GET',
			headers: { accept: 'application/json' },
			maxBytes: MANIFEST_MAX_BYTES,
		});
		if (res.status !== 200) fail('upstream_error', `${WELL_KNOWN_APP} answered ${res.status}.`);
		const json = parseJson(res.text);
		if (!isObject(json)) return fail('invalid_manifest', `${WELL_KNOWN_APP} is not a JSON object.`);
		const signature = res.headers[MANIFEST_SIGNATURE_HEADER.toLowerCase()];
		return { json, signature: typeof signature === 'string' && signature !== '' ? signature : null };
	};

	/** @param {VersionDoc} doc @returns {Manifest} */
	const manifestOf = (doc) => /** @type {Manifest} */ (JSON.parse(doc.manifestJson));

	/** @param {string} appId */
	const appDoc = async (appId) => (await repo.app(appId)) ?? fail('not_found', `No app ${appId}.`);

	/** @param {AppDoc} app */
	const currentManifest = async (app) => {
		const doc = await repo.version(app._id, app.currentVersion);
		if (!doc) return fail('internal_error', `App ${app._id} has no current manifest.`);
		return manifestOf(doc);
	};

	/**
	 * @param {AppDoc} app
	 * @param {Manifest | null} manifest
	 */
	const appView = (app, manifest) => ({
		appId: app._id,
		slug: app.slug,
		kind: app.kind,
		status: app.status,
		sunsetAt: app.sunsetAt instanceof Date ? app.sunsetAt.toISOString() : null,
		name: manifest?.product.name ?? null,
		productVersion: manifest?.product.version ?? null,
		endpoints: manifest?.endpoints ?? null,
		environments: {
			production: app.environments.production?.baseUrl ?? null,
			staging: app.environments.staging?.baseUrl ?? null,
		},
		currentVersion: app.currentVersion,
		pendingVersion: app.pendingVersion ?? null,
		health: app.kind === 'service' ? healthView(app.health, ctx.now(), staleAfterMs) : null,
		createdAt: app.createdAt instanceof Date ? app.createdAt.toISOString() : null,
	});

	/** @param {Omit<VersionDoc, 'manifestJson'> & { manifestJson?: string }} doc */
	const versionView = (doc) => ({
		appId: doc.appId,
		version: doc.version,
		status: doc.status,
		source: doc.source,
		productVersion: doc.productVersion,
		manifestHash: doc.manifestHash,
		breaking: doc.breaking,
		diff: doc.diff,
		assets: doc.assets ?? null,
		submittedBy: doc.submittedBy,
		review: doc.review
			? {
					by: doc.review.by,
					at: doc.review.at instanceof Date ? doc.review.at.toISOString() : doc.review.at,
					reason: doc.review.reason,
				}
			: null,
		createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : null,
		...(doc.manifestJson ? { manifest: JSON.parse(doc.manifestJson) } : {}),
	});

	/** @param {KeyDoc} doc */
	const keyView = (doc) => ({
		kid: doc.kid,
		status: doc.status,
		thumbprint: doc.thumbprint,
		source: doc.source,
		notAfter: doc.notAfter instanceof Date ? doc.notAfter.toISOString() : null,
		usable: doc.status === 'active' && (doc.notAfter === null || doc.notAfter.getTime() > ctx.now()),
		revoked: doc.revoked ? { at: doc.revoked.at.toISOString(), by: doc.revoked.by, reason: doc.revoked.reason } : null,
		createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : null,
	});

	/**
	 * Keys an app may currently sign with (active, inside any overlap window).
	 * @param {string} appId
	 */
	const usableKeys = async (appId) =>
		(await repo.keys(appId)).filter((k) => k.status === 'active' && (k.notAfter === null || k.notAfter.getTime() > ctx.now()));

	/**
	 * @param {{ actor: Actor | { type: string, id: string }, action: string, app: { _id: string } | string, before?: unknown,
	 *   after?: unknown, reason?: string | null, requestId?: string | null, ip?: string | null, merchantId?: string | null }} entry
	 */
	const audit = ({ actor, action, app, before, after, reason = null, requestId = null, ip = null, merchantId = null }) =>
		ctx.audit.record({
			actor: /** @type {any} */ (actor),
			action,
			target: { type: 'app', id: typeof app === 'string' ? app : app._id, merchantId },
			...(before === undefined ? {} : { before }),
			...(after === undefined ? {} : { after }),
			reason,
			requestId,
			ip,
		});

	/**
	 * `manifest.accepted@1` through the integration module (skipped when it is not registered).
	 * @param {AppDoc} app
	 * @param {VersionDoc} version
	 */
	const emitAccepted = async (app, version) => {
		if (!ctx.moduleNames().includes('integration')) return;
		try {
			const integration = ctx.service('integration');
			if (typeof integration.emitControl !== 'function') return;
			await integration.emitControl(
				'manifest.accepted@1',
				{
					appId: app._id,
					slug: app.slug,
					kind: app.kind,
					version: version.version,
					productVersion: version.productVersion,
					manifestHash: version.manifestHash,
					breaking: version.breaking,
				},
				{ appIds: [app._id] },
			);
		} catch (error) {
			ctx.logger.error('manifest.accepted emission failed', { error, appId: app._id, version: version.version });
		}
	};

	/**
	 * Store a candidate as the pending version (superseding an older pending one).
	 * @param {{ app: AppDoc, manifest: Manifest, source: 'refresh' | 'upload', submittedBy: string,
	 *   assets?: VersionDoc['assets'], signature?: VersionDoc['signature'] }} input
	 */
	const storePending = async ({ app, manifest, source, submittedBy, assets = null, signature = null }) => {
		const accepted = await currentManifest(app);
		const diff = diffManifests(accepted, manifest);
		const version = /** @type {number} */ (await repo.nextVersion(app._id));
		/** @type {VersionDoc} */
		const doc = {
			_id: versionId(app._id, version),
			appId: app._id,
			version,
			manifestJson: canonicalJson(manifest),
			manifestHash: hashManifest(manifest),
			productVersion: manifest.product.version,
			status: 'pending',
			source,
			diff,
			breaking: diff.isBreaking,
			assets,
			signature,
			submittedBy,
			review: null,
		};
		await repo.insertVersion(doc);
		const updated = await repo.updateApp(app._id, {}, { $set: { pendingVersion: version } });
		if (app.pendingVersion && app.pendingVersion !== version)
			await repo.setVersionStatus(app._id, app.pendingVersion, 'pending', { status: 'superseded' });
		return { app: /** @type {AppDoc} */ (updated), version: doc };
	};

	/**
	 * Is this candidate identical to the current or the pending version?
	 * @param {AppDoc} app
	 * @param {string} hash
	 * @returns {Promise<VersionDoc | null>}
	 */
	const sameAsKnown = async (app, hash) => {
		const refs = [{ appId: app._id, version: app.currentVersion }];
		if (app.pendingVersion) refs.push({ appId: app._id, version: app.pendingVersion });
		const docs = await repo.versionsByRef(refs);
		return docs.find((d) => d.manifestHash === hash) ?? null;
	};

	// ------------------------------------------------------------------------------------------------------------
	// onboarding with the product's connect secret (service products)

	/**
	 * Admin → Apps → Add product: `POST <url>/.well-known/ss-connect`, HMAC-signed with the deployer's `CONNECT_SECRET`
	 * (`@ss/protocol` `createConnectRequest`; the secret itself is never sent nor stored). The product answers its public
	 * key and manifest, HMAC-signed with the same secret; the app is then stored with its base URL and key pinned.
	 * Connecting again (same slug) replaces the binding: the key and the address move, the old keys are revoked.
	 * @param {{ url: unknown, secret: unknown } & Audited} input
	 */
	const connectProduct = async ({ url, secret, actor, requestId = null, ip = null }) => {
		if (!isConnectSecret(secret))
			fail('validation_failed', 'The connect secret must be at least 32 characters.', {
				errors: [{ path: '/secret', message: 'must be at least 32 characters' }],
			});
		const base = baseUrlOf(String(url ?? ''), '/url');
		// the advertised (unsigned) manifest only picks the app to replace; the signed answer is what is stored
		const advertised = await fetchAdvertised(base);
		const slug = isObject(advertised.json.product) ? advertised.json.product.slug : undefined;
		const existing = typeof slug === 'string' ? await repo.appBySlug(slug) : null;
		if (existing && existing.kind !== 'service') fail('conflict', `${existing.slug} is not a service product.`);
		const appId = existing?._id ?? createId('app', { randomBytes: ctx.randomBytes });
		const request = createConnectRequest({
			secret,
			productUrl: base,
			portalUrl: ctx.config.portalUrl,
			jwks: ctx.keys.publishedJwks(),
			appId,
			now: ctx.now,
			randomBytes: ctx.randomBytes,
		});
		const res = await outbound(request.url, {
			method: 'POST',
			headers: request.headers,
			body: request.body,
			maxBytes: MANIFEST_MAX_BYTES,
		});
		if (res.status === 401) fail('unauthorized', 'The product refused the connect secret.');
		if (res.status === 503) fail('upstream_error', 'The product refuses connections: its CONNECT_SECRET is not set.');
		if (res.status !== 200) fail('upstream_error', `The product answered ${res.status}.`);
		/** @type {Awaited<ReturnType<typeof verifyConnectResponse>>} */
		let verified;
		try {
			verified = await verifyConnectResponse({
				secret,
				headers: res.headers,
				body: res.text,
				nonce: request.nonce,
				appId,
				now: ctx.now,
			});
		} catch (error) {
			ctx.logger.warn('product connection answer refused', { reason: isProtocolError(error) ? error.code : 'invalid' });
			return fail('upstream_error', 'The product answer does not verify.');
		}
		const manifest = checkedManifest(verified.manifest, 'service', '/manifest');
		if (existing && existing.slug !== manifest.product.slug)
			fail('conflict', `The product answered ${manifest.product.slug}, not ${existing.slug}.`);
		const key = {
			_id: keyId(appId, verified.publicJwk.kid),
			appId,
			kid: verified.publicJwk.kid,
			publicJwk: verified.publicJwk,
			thumbprint: verified.thumbprint,
			status: /** @type {const} */ ('active'),
			notAfter: null,
			source: 'connection',
			revoked: null,
		};
		if (existing) {
			const at = new Date(ctx.now());
			for (const old of await repo.keys(appId))
				if (old.status === 'active' && old.kid !== key.kid)
					await repo.revokeKey(appId, old.kid, { at, by: actor.id, reason: 'reconnected' });
			if (!(await repo.keys(appId)).some((k) => k.kid === key.kid && k.status === 'active')) await repo.insertKey(key);
			await repo.updateApp(appId, {}, { $set: { 'environments.production': { baseUrl: base } } });
			if (!(await sameAsKnown(existing, hashManifest(manifest))))
				await storePending({ app: existing, manifest, source: 'refresh', submittedBy: actor.id });
			await audit({
				actor,
				action: 'catalog.app_reconnected',
				app: appId,
				after: { baseUrl: base, kid: key.kid },
				requestId,
				ip,
			});
		} else {
			/** @type {AppDoc} */
			const app = {
				_id: appId,
				slug: manifest.product.slug,
				kind: 'service',
				status: 'pending',
				sunsetAt: null,
				environments: { production: { baseUrl: base }, staging: null },
				currentVersion: 1,
				pendingVersion: null,
				latestVersion: 1,
				health: null,
				createdBy: actor.id,
			};
			if (!(await repo.insertApp(app))) fail('conflict', `An app with slug ${manifest.product.slug} exists.`);
			/** @type {VersionDoc} */
			const version = {
				_id: versionId(appId, 1),
				appId,
				version: 1,
				manifestJson: canonicalJson(manifest),
				manifestHash: hashManifest(manifest),
				productVersion: manifest.product.version,
				status: 'accepted',
				source: 'connection',
				diff: diffManifests(null, manifest),
				breaking: false,
				assets: null,
				signature: null,
				submittedBy: actor.id,
				review: { by: actor.id, at: new Date(ctx.now()), reason: 'connection' },
			};
			await repo.insertVersion(version);
			await repo.insertKey(key);
			await audit({
				actor,
				action: 'catalog.app_connected',
				app: appId,
				after: { slug: app.slug, kind: 'service', baseUrl: base, kid: key.kid, manifestHash: version.manifestHash },
				requestId,
				ip,
			});
		}
		return { appId, slug: manifest.product.slug, baseUrl: base, kid: key.kid, reconnected: Boolean(existing) };
	};

	// ------------------------------------------------------------------------------------------------------------
	// packs

	/**
	 * Upload a signed pack bundle descriptor: a new pack (pins `publicJwk`) or a new pending version of an existing one.
	 * @param {{ body: unknown } & Audited} input
	 */
	const uploadPack = async ({ body, actor, requestId = null, ip = null }) => {
		const parsed = parseBundleUpload(body);
		if (!parsed.ok) return fail('catalog_bundle_invalid', 'The bundle upload is invalid.', { errors: parsed.errors });
		const { descriptor, signature, publicJwk } = parsed.value;
		const manifest = checkedManifest(descriptor.manifest, 'pack', '/descriptor/manifest');
		const assetErrors = checkBundleAssets(manifest, descriptor.assets);
		if (assetErrors.length > 0)
			fail('catalog_bundle_invalid', 'The bundle does not contain the modules it declares.', { errors: assetErrors });
		const hash = hashManifest(manifest);
		const assets = descriptor.assets.map((a) => ({
			path: a.path,
			sha256: a.sha256,
			size: a.size,
			...(a.contentType ? { contentType: a.contentType } : {}),
		}));
		const existing = await repo.appBySlug(manifest.product.slug);

		if (existing) {
			if (existing.kind !== 'pack') fail('conflict', `${manifest.product.slug} is a service product.`);
			if (existing.status === 'retired') fail('conflict', `${manifest.product.slug} is retired.`);
			const keys = await usableKeys(existing._id);
			if (publicJwk !== undefined && !keys.some((k) => isObject(publicJwk) && k.kid === publicJwk.kid))
				fail('catalog_bundle_invalid', 'New signing keys cannot be introduced by an upload; sign with a registered key.');
			if (!(await verifyBundle({ descriptor, signature, keys: keys.map((k) => k.publicJwk) })))
				fail('catalog_bundle_invalid', 'The bundle signature does not verify under the pack keys.');
			const known = await sameAsKnown(existing, hash);
			if (known)
				return { app: appView(existing, await currentManifest(existing)), version: versionView(known), changed: false };
			const stored = await storePending({
				app: existing,
				manifest,
				source: 'upload',
				submittedBy: actor.id,
				assets,
				signature,
			});
			await audit({
				actor,
				action: 'catalog.pack_uploaded',
				app: existing._id,
				after: { version: stored.version.version, manifestHash: hash, breaking: stored.version.breaking },
				requestId,
				ip,
			});
			return {
				app: appView(stored.app, await currentManifest(stored.app)),
				version: versionView(stored.version),
				changed: true,
			};
		}

		/** @type {import('@ss/protocol').PublicJwk} */
		let jwk;
		try {
			jwk = toPublicJwk(publicJwk);
		} catch {
			return fail('catalog_bundle_invalid', 'A new pack needs the developer publicJwk (Ed25519).', {
				errors: [{ path: '/publicJwk', message: 'must be an Ed25519 public JWK' }],
			});
		}
		if (jwk.kid !== signature.kid) fail('catalog_bundle_invalid', 'signature.kid must be the kid of publicJwk.');
		if (!(await verifyBundle({ descriptor, signature, keys: [jwk] })))
			fail('catalog_bundle_invalid', 'The bundle signature does not verify under publicJwk.');
		const appId = createId('app', { randomBytes: ctx.randomBytes });
		/** @type {AppDoc} */
		const app = {
			_id: appId,
			slug: manifest.product.slug,
			kind: 'pack',
			status: 'pending',
			sunsetAt: null,
			environments: { production: null, staging: null },
			currentVersion: 1,
			pendingVersion: null,
			latestVersion: 1,
			health: null,
			createdBy: actor.id,
		};
		if (!(await repo.insertApp(app))) fail('conflict', `An app with slug ${manifest.product.slug} already exists.`);
		/** @type {VersionDoc} */
		const version = {
			_id: versionId(appId, 1),
			appId,
			version: 1,
			manifestJson: canonicalJson(manifest),
			manifestHash: hash,
			productVersion: manifest.product.version,
			status: 'accepted',
			source: 'upload',
			diff: diffManifests(null, manifest),
			breaking: false,
			assets,
			signature,
			submittedBy: actor.id,
			review: { by: actor.id, at: new Date(ctx.now()), reason: 'first upload' },
		};
		await repo.insertVersion(version);
		await repo.insertKey({
			_id: keyId(appId, jwk.kid),
			appId,
			kid: jwk.kid,
			publicJwk: jwk,
			thumbprint: await thumbprint(jwk),
			status: 'active',
			notAfter: null,
			source: 'upload',
			revoked: null,
		});
		await audit({
			actor,
			action: 'catalog.pack_created',
			app: appId,
			after: { slug: app.slug, kid: jwk.kid, manifestHash: hash, assets: assets.length },
			requestId,
			ip,
		});
		return { app: appView(app, manifest), version: versionView(version), changed: true };
	};

	// ------------------------------------------------------------------------------------------------------------
	// manifest versions

	/**
	 * Why a refreshed manifest's `SS-Manifest-Signature` is not acceptable (`null` when it verifies under one of the
	 * app's registered keys, for this appId, over exactly this manifest, and is at most 24 h old).
	 * @param {AppDoc} app
	 * @param {Manifest} manifest
	 * @param {string | null} signature
	 * @returns {Promise<string | null>}
	 */
	const signatureRefusal = async (app, manifest, signature) => {
		if (signature === null) return 'manifest_signature_missing';
		const keyResolver = await appKeys(app._id);
		if (!keyResolver) return 'manifest_signature_no_keys';
		try {
			await verifyManifest({ manifest, jws: signature, keyResolver, expectedAppId: app._id, now: ctx.now });
			return null;
		} catch (error) {
			return `manifest_signature_${isProtocolError(error) ? error.code : 'invalid'}`;
		}
	};

	/**
	 * Store a refreshed manifest whose signature failed as a `rejected` version (once per hash and reason), audit it
	 * and raise an alert. Nothing about the app changes.
	 * @param {{ app: AppDoc, manifest: Manifest, reason: string, actor: Actor | { type: string, id: string },
	 *   requestId: string | null, ip: string | null }} input
	 */
	const rejectRefresh = async ({ app, manifest, reason, actor, requestId, ip }) => {
		const hash = hashManifest(manifest);
		const latest = await repo.version(app._id, app.latestVersion);
		if (latest && latest.status === 'rejected' && latest.manifestHash === hash && latest.review?.reason === reason)
			return { changed: false, rejected: true, reason, version: versionView(latest) };
		const diff = diffManifests(await currentManifest(app), manifest);
		const version = /** @type {number} */ (await repo.nextVersion(app._id));
		/** @type {VersionDoc} */
		const doc = {
			_id: versionId(app._id, version),
			appId: app._id,
			version,
			manifestJson: canonicalJson(manifest),
			manifestHash: hash,
			productVersion: manifest.product.version,
			status: 'rejected',
			source: 'refresh',
			diff,
			breaking: diff.isBreaking,
			assets: null,
			signature: null,
			submittedBy: actor.id,
			review: { by: SYSTEM.id, at: new Date(ctx.now()), reason },
		};
		await repo.insertVersion(doc);
		await audit({
			actor,
			action: 'catalog.manifest_signature_rejected',
			app: app._id,
			after: { version, manifestHash: hash },
			reason,
			requestId,
			ip,
		});
		ctx.logger.error('catalog alert: refreshed manifest refused', { appId: app._id, version, reason });
		return { changed: false, rejected: true, reason, version: versionView(doc) };
	};

	/**
	 * Fetch the product's advertised manifest and store it as a pending version when it changed. The manifest must
	 * carry a valid `SS-Manifest-Signature` (`@ss/protocol` `verifyManifest` with the app's registered keys); an
	 * unsigned or invalid one is stored as `rejected` with the reason and alerted (`rejectRefresh`).
	 * @param {{ appId: string } & Partial<Audited>} input
	 */
	const refreshManifest = async ({ appId, actor = SYSTEM, requestId = null, ip = null }) => {
		const app = await appDoc(appId);
		if (app.kind !== 'service') fail('conflict', 'Packs are updated by uploading a new signed bundle.');
		if (app.status === 'retired') fail('conflict', 'The app is retired.');
		const base = app.environments.production?.baseUrl ?? fail('conflict', 'The app has no production environment.');
		baseUrlOf(base, '/environments/production');
		const advertised = await fetchAdvertised(base);
		const manifest = checkedManifest(advertised.json, 'service');
		if (manifest.product.slug !== app.slug)
			fail('invalid_manifest', `The manifest slug changed from ${app.slug} to ${manifest.product.slug}.`);
		const refusal = await signatureRefusal(app, manifest, advertised.signature);
		if (refusal) return rejectRefresh({ app, manifest, reason: refusal, actor, requestId, ip });
		const known = await sameAsKnown(app, hashManifest(manifest));
		if (known) return { changed: false, version: versionView(known) };
		const stored = await storePending({ app, manifest, source: 'refresh', submittedBy: actor.id });
		await audit({
			actor,
			action: 'catalog.manifest_refreshed',
			app: appId,
			after: { version: stored.version.version, manifestHash: stored.version.manifestHash, breaking: stored.version.breaking },
			requestId,
			ip,
		});
		return { changed: true, version: versionView(stored.version) };
	};

	/**
	 * Approve or reject a pending version. Approval makes it current and emits `manifest.accepted@1` for live apps.
	 * @param {{ appId: string, version: number, action: 'approve' | 'reject', reason?: string | null } & Audited} input
	 */
	const reviewVersion = async ({ appId, version, action, reason = null, actor, requestId = null, ip = null }) => {
		const app = await appDoc(appId);
		const doc = (await repo.version(appId, version)) ?? fail('not_found', `No version ${version} of ${appId}.`);
		const refusal = reviewRefusal({ versionStatus: doc.status, appStatus: app.status, action });
		if (refusal) fail('conflict', refusal);
		const review = { by: actor.id, at: new Date(ctx.now()), reason };
		if (action === 'reject') {
			if (!(await repo.setVersionStatus(appId, version, 'pending', { status: 'rejected', review })))
				fail('conflict', 'The version changed concurrently.');
			if (app.pendingVersion === version)
				await repo.updateApp(appId, { pendingVersion: version }, { $set: { pendingVersion: null } });
			await audit({ actor, action: 'catalog.version_rejected', app: appId, after: { version }, reason, requestId, ip });
			return versionView({ ...doc, status: 'rejected', review });
		}
		const updated = await repo.updateApp(
			appId,
			{ currentVersion: app.currentVersion, pendingVersion: app.pendingVersion },
			{ $set: { currentVersion: version, pendingVersion: app.pendingVersion === version ? null : app.pendingVersion } },
		);
		if (!updated) fail('conflict', 'The app changed concurrently; reload and retry.');
		await repo.setVersionStatus(appId, version, 'pending', { status: 'accepted', review });
		await repo.setVersionStatus(appId, app.currentVersion, 'accepted', { status: 'superseded' });
		const accepted = { ...doc, status: /** @type {const} */ ('accepted'), review };
		await audit({
			actor,
			action: 'catalog.version_approved',
			app: appId,
			before: { currentVersion: app.currentVersion },
			after: { currentVersion: version, breaking: doc.breaking },
			reason,
			requestId,
			ip,
		});
		if (updated.status === 'active' || updated.status === 'deprecated') await emitAccepted(updated, accepted);
		return versionView(accepted);
	};

	// ------------------------------------------------------------------------------------------------------------
	// lifecycle, environments, keys

	/**
	 * @param {{ appId: string, action: 'activate' | 'deprecate' | 'retire', sunsetAt?: string | null, reason?: string | null,
	 *   force?: boolean } & Audited} input
	 */
	const setLifecycle = async ({
		appId,
		action,
		sunsetAt = null,
		reason = null,
		force = false,
		actor,
		requestId = null,
		ip = null,
	}) => {
		const app = await appDoc(appId);
		const next = applyLifecycle({ status: app.status, action, now: ctx.now(), sunsetAt, currentSunsetAt: app.sunsetAt, force });
		if (!next.ok) return fail('conflict', next.reason);
		const updated =
			(await repo.updateApp(appId, { status: app.status }, { $set: { status: next.status, sunsetAt: next.sunsetAt } })) ??
			fail('conflict', 'The app changed concurrently; reload and retry.');
		await audit({
			actor,
			action: `catalog.app_${action === 'activate' ? 'activated' : action === 'deprecate' ? 'deprecated' : 'retired'}`,
			app: appId,
			before: { status: app.status, sunsetAt: app.sunsetAt },
			after: { status: next.status, sunsetAt: next.sunsetAt },
			reason,
			requestId,
			ip,
		});
		if (action === 'activate' && app.status === 'pending') {
			const current = await repo.version(appId, updated.currentVersion);
			if (current) await emitAccepted(updated, current);
		}
		return appView(updated, await currentManifest(updated));
	};

	/**
	 * @param {{ appId: string, production?: string, staging?: string | null } & Audited} input
	 */
	const setEnvironments = async ({ appId, production, staging, actor, requestId = null, ip = null }) => {
		const app = await appDoc(appId);
		if (app.kind !== 'service') fail('conflict', 'Packs have no environments.');
		/** @type {Record<string, unknown>} */
		const set = {};
		if (production !== undefined) set['environments.production'] = { baseUrl: baseUrlOf(production, '/production') };
		if (staging === null) set['environments.staging'] = null;
		else if (staging !== undefined) set['environments.staging'] = { baseUrl: baseUrlOf(staging, '/staging') };
		const updated = /** @type {AppDoc} */ (await repo.updateApp(appId, {}, { $set: set }));
		await audit({
			actor,
			action: 'catalog.environments_set',
			app: appId,
			before: app.environments,
			after: updated.environments,
			requestId,
			ip,
		});
		return appView(updated, await currentManifest(updated));
	};

	/**
	 * @param {{ appId: string, kid: string, reason: string } & Audited} input
	 */
	const revokeKey = async ({ appId, kid, reason, actor, requestId = null, ip = null }) => {
		await appDoc(appId);
		const revoked = { at: new Date(ctx.now()), by: actor.id, reason };
		if (!(await repo.revokeKey(appId, kid, revoked))) fail('not_found', `No active key ${kid}.`);
		await audit({ actor, action: 'catalog.key_revoked', app: appId, after: { kid }, reason, requestId, ip });
		return { kid, status: 'revoked', keys: (await repo.keys(appId)).map(keyView) };
	};

	// ------------------------------------------------------------------------------------------------------------
	// product calls (F.9)

	/**
	 * `POST /v1/product/heartbeat`
	 * @param {{ appId: string, body: unknown }} input
	 */
	const recordHeartbeat = async ({ appId, body }) => {
		const parsed = parseHeartbeat(body);
		if (!parsed.ok) return fail('validation_failed', 'The heartbeat is invalid.', { errors: parsed.errors });
		const at = new Date(ctx.now());
		const updated = await repo.updateApp(
			appId,
			{ kind: 'service' },
			{ $set: { health: { lastHeartbeatAt: at, lastSeenAt: at, ...parsed.value } } },
		);
		if (!updated) fail('not_found', 'Unknown app.');
		return { ok: true, serverTime: at.toISOString() };
	};

	/**
	 * `POST /v1/product/keys/rotate` — the product announces its next key; current keys stay valid for the overlap.
	 * @param {{ appId: string, publicJwk: unknown, requestId?: string | null }} input
	 */
	const rotateKey = async ({ appId, publicJwk, requestId = null }) => {
		/** @type {import('@ss/protocol').PublicJwk} */
		let jwk;
		try {
			jwk = toPublicJwk(publicJwk);
		} catch {
			return fail('validation_failed', 'publicJwk must be an Ed25519 public JWK.', {
				errors: [{ path: '/publicJwk', message: 'must be an Ed25519 public JWK' }],
			});
		}
		if (jwk.nbf !== undefined || jwk.exp !== undefined) jwk = toPublicJwk({ ...jwk, nbf: undefined, exp: undefined });
		const app = await appDoc(appId);
		if (app.kind !== 'service') fail('conflict', 'Only service products rotate keys this way.');
		const all = await repo.keys(appId);
		const jkt = await thumbprint(jwk);
		if (all.some((k) => k.kid === jwk.kid || k.thumbprint === jkt)) fail('conflict', 'This key is already registered.');
		const usable = all.filter((k) => k.status === 'active' && (k.notAfter === null || k.notAfter.getTime() > ctx.now()));
		if (usable.length >= MAX_ACTIVE_KEYS) fail('conflict', `An app may hold at most ${MAX_ACTIVE_KEYS} keys at once.`);
		const until = new Date(ctx.now() + KEY_OVERLAP_MS);
		await repo.limitActiveKeys(appId, until);
		await repo.insertKey({
			_id: keyId(appId, jwk.kid),
			appId,
			kid: jwk.kid,
			publicJwk: jwk,
			thumbprint: jkt,
			status: 'active',
			notAfter: null,
			source: 'rotation',
			revoked: null,
		});
		await audit({
			actor: { type: 'product', id: appId },
			action: 'catalog.key_rotated',
			app: appId,
			after: { kid: jwk.kid },
			requestId,
		});
		const kids = (await usableKeys(appId)).map((k) => k.kid);
		return { kid: jwk.kid, kids, previousValidUntil: until.toISOString() };
	};

	/**
	 * `POST /v1/product/launch/consume` — single use through the shared replay store.
	 * @param {{ appId: string, jti: string }} input
	 */
	const consumeLaunch = async ({ appId, jti }) => {
		const launch = await repo.launch(appId, jti);
		const expireAt = launch?.expireAt instanceof Date ? launch.expireAt.getTime() : 0;
		if (!launch || expireAt <= ctx.now()) return { consumed: false };
		const seen = await ctx.replayStore.seen(`catalog-launch|${appId}|${jti}`, expireAt);
		return { consumed: !seen };
	};

	// ------------------------------------------------------------------------------------------------------------
	// launches and keys port

	/**
	 * Issue an SSO launch (INTERFACES.md): `{ url, token }` with `url = <product>/sso?launch=<token>`.
	 * @param {LaunchInput & { requestId?: string | null, ip?: string | null }} input
	 */
	const issueLaunch = async (input) => {
		const app = await appDoc(input.appId);
		const manifest = await currentManifest(app);
		const refusal = launchRefusal({ input, app, manifest });
		if (refusal) fail('catalog_launch_refused', refusal);
		const environment = input.environment ?? 'production';
		const base =
			app.environments[environment]?.baseUrl ?? fail('catalog_launch_refused', `The app has no ${environment} environment.`);
		/** @type {Awaited<ReturnType<typeof protocolIssueLaunch>>} */
		let issued;
		try {
			issued = await protocolIssueLaunch({
				signer: ctx.keys.signer,
				issuer: ctx.config.portalUrl,
				audience: app._id,
				subject: input.subject,
				kind: input.kind,
				user: input.user,
				scope: input.scope ?? {},
				...(input.subscriptions === undefined ? {} : { subscriptions: input.subscriptions }),
				...(input.kind === 'impersonate' ? { actor: input.actor } : {}),
				...(input.impersonationSeconds === undefined ? {} : { impersonationSeconds: input.impersonationSeconds }),
				now: ctx.now,
				randomBytes: ctx.randomBytes,
			});
		} catch (error) {
			if (isProtocolError(error)) return fail('catalog_launch_refused', error.message);
			throw error;
		}
		const { token, claims } = issued;
		await repo.insertLaunch({
			_id: claims.jti,
			appId: app._id,
			kind: claims.kind,
			subject: claims.sub,
			merchantId: claims.scope.merchantId ?? null,
			actor: input.actor ?? null,
			expireAt: new Date((claims.exp + 5) * 1000),
		});
		if (input.actor) {
			await audit({
				actor: { type: 'staff', id: input.actor },
				action: 'catalog.launch_issued',
				app: app._id,
				merchantId: claims.scope.merchantId ?? null,
				after: {
					kind: claims.kind,
					subject: claims.sub,
					jti: claims.jti,
					environment,
					...(claims.scope.all === true ? { scope: 'all' } : {}),
					...(claims.impExp ? { impExp: claims.impExp } : {}),
				},
				requestId: input.requestId ?? null,
				ip: input.ip ?? null,
			});
		}
		return { url: launchUrl(base, token), token, jti: claims.jti, expiresAt: new Date(claims.exp * 1000).toISOString() };
	};

	/**
	 * Port `appKeys(appId)`: resolver over the app's usable keys (revoked keys excluded, overlap ends as JWK `exp`).
	 * Packs and retired apps never authenticate.
	 * @param {string} appId
	 * @returns {Promise<KeyResolver | null>}
	 */
	const appKeys = async (appId) => {
		if (typeof appId !== 'string' || appId.length === 0 || appId.length > 128) return null;
		const app = await repo.app(appId);
		if (!app || app.kind !== 'service' || app.status === 'retired') return null;
		// a product calling the Portal is how the Portal knows it is alive (no periodic heartbeat, F.19)
		const seen = app.health?.lastSeenAt instanceof Date ? app.health.lastSeenAt.getTime() : 0;
		if (ctx.now() - seen >= SEEN_EVERY_MS)
			await stored
				.updateApp(
					appId,
					{ kind: 'service' },
					{
						$set: {
							health: {
								...(app.health ?? { lastHeartbeatAt: null, version: null, status: null, queues: null }),
								lastSeenAt: new Date(ctx.now()),
							},
						},
					},
				)
				.catch(() => null);
		const keys = await usableKeys(appId);
		if (keys.length === 0) return null;
		const jwks = createJwks(
			keys.map((k) => ({ ...k.publicJwk, ...(k.notAfter ? { exp: Math.floor(k.notAfter.getTime() / 1000) } : {}) })),
		);
		return createKeyResolver({ jwks, now: ctx.now });
	};

	/**
	 * Verify a service product's signed **UI bundle** descriptor (F.16; delivery stores and serves it): the same
	 * `ss-pack-bundle@1` descriptor and detached signature as packs, signed with one of the product's registered,
	 * non-revoked keys (no key can be introduced this way). `manifest` is the UI subset checked by `checkUiManifest`.
	 * @param {{ appId: string, body: unknown }} input
	 * @returns {Promise<{ descriptor: import('./core/bundle.js').Descriptor, signature: import('./core/bundle.js').BundleSignature,
	 *   slug: string, elements: Array<{ key: string, headless: string, renderer: string, strings?: string }> }>}
	 */
	const verifyUiBundle = async ({ appId, body }) => {
		const app = await appDoc(appId);
		if (app.kind !== 'service') fail('conflict', 'Only service products publish UI bundles; packs upload pack bundles.');
		if (app.status === 'retired') fail('conflict', `${app.slug} is retired.`);
		const parsed = parseBundleUpload(body);
		if (!parsed.ok) return fail('catalog_bundle_invalid', 'The UI bundle upload is invalid.', { errors: parsed.errors });
		const { descriptor, signature, publicJwk } = parsed.value;
		if (publicJwk !== undefined)
			fail('catalog_bundle_invalid', 'UI bundles are signed with a registered product key; publicJwk is not accepted.', {
				errors: [{ path: '/publicJwk', message: 'unknown property' }],
			});
		const errors = checkUiManifest(descriptor.manifest, app.slug);
		if (errors.length === 0)
			errors.push(
				...checkBundleAssets(/** @type {import('@ss/contracts').Manifest} */ (descriptor.manifest), descriptor.assets),
			);
		if (errors.length > 0) fail('catalog_bundle_invalid', 'The UI bundle descriptor is invalid.', { errors });
		const resolver = await appKeys(appId);
		if (!resolver || !(await verifyBundle({ descriptor, signature, keyResolver: resolver })))
			fail('catalog_bundle_invalid', 'The UI bundle signature does not verify under the product keys.');
		const manifest = /** @type {{ elements: Array<{ key: string, headless: string, renderer: string, strings?: string }> }} */ (
			descriptor.manifest
		);
		return { descriptor, signature, slug: app.slug, elements: manifest.elements.map((e) => ({ ...e })) };
	};

	// ------------------------------------------------------------------------------------------------------------
	// reads

	/** @param {string} appId */
	const getApp = async (appId) => {
		const app = await appDoc(appId);
		return appView(app, await currentManifest(app));
	};

	/** @param {string} slug */
	const appBySlug = async (slug) => {
		const app = (await repo.appBySlug(String(slug))) ?? fail('not_found', `No app ${slug}.`);
		return appView(app, await currentManifest(app));
	};

	/**
	 * @param {string} appId
	 * @param {number} [version] default: the current accepted version
	 * @returns {Promise<Manifest>}
	 */
	const getManifest = async (appId, version) => {
		const app = await appDoc(appId);
		const doc =
			(await repo.version(appId, version ?? app.currentVersion)) ?? fail('not_found', `No version ${version} of ${appId}.`);
		return manifestOf(doc);
	};

	/**
	 * Catalog listing (merchant and public consoles): active and deprecated apps with their accepted manifests.
	 * @param {{ kind?: 'service' | 'pack', includeDeprecated?: boolean }} [filter]
	 */
	const activeProducts = async ({ kind, includeDeprecated = true } = {}) => {
		/** @type {AppDoc[]} */
		const apps = [];
		let after = null;
		for (;;) {
			const page = await repo.listApps({
				status: includeDeprecated ? ['active', 'deprecated'] : ['active'],
				...(kind ? { kind } : {}),
				after,
				limit: 200,
			});
			apps.push(...page);
			if (page.length < 200) break;
			after = /** @type {AppDoc} */ (page[page.length - 1])._id;
		}
		const versions = await repo.versionsByRef(apps.map((a) => ({ appId: a._id, version: a.currentVersion })));
		const byId = new Map(versions.map((v) => [v.appId, v]));
		return apps.flatMap((app) => {
			const doc = byId.get(app._id);
			return doc ? [catalogEntry({ ...app, appId: app._id }, manifestOf(doc))] : [];
		});
	};

	/**
	 * Catalog detail by slug (includes feature schemas). Only listed (active/deprecated) apps.
	 * @param {string} slug
	 */
	const productDetail = async (slug) => {
		const app = await repo.appBySlug(String(slug));
		if (!app || (app.status !== 'active' && app.status !== 'deprecated')) return fail('not_found', `No product ${slug}.`);
		return catalogEntry({ ...app, appId: app._id }, await currentManifest(app), { detail: true });
	};

	/**
	 * Staff listing.
	 * @param {{ status?: string[], kind?: string, after?: string | null, limit: number }} query
	 */
	const listApps = async (query) => {
		const apps = await repo.listApps(query);
		const versions = await repo.versionsByRef(apps.map((a) => ({ appId: a._id, version: a.currentVersion })));
		const byId = new Map(versions.map((v) => [v.appId, manifestOf(v)]));
		return apps.map((app) => appView(app, byId.get(app._id) ?? null));
	};

	/** @param {string} appId */
	const appDetail = async (appId) => {
		const app = await appDoc(appId);
		return { ...appView(app, await currentManifest(app)), keys: (await repo.keys(appId)).map(keyView) };
	};

	/**
	 * @param {string} appId
	 * @param {{ before?: number | null, limit: number }} page
	 */
	const listVersions = async (appId, page) => {
		await appDoc(appId);
		return (await repo.listVersions(appId, page)).map((doc) => versionView(doc));
	};

	/** @param {string} appId @param {number} version */
	const versionDetail = async (appId, version) => {
		const doc = (await repo.version(appId, version)) ?? fail('not_found', `No version ${version} of ${appId}.`);
		return versionView(doc);
	};

	return {
		// INTERFACES.md
		getApp,
		appBySlug,
		getManifest,
		activeProducts,
		issueLaunch,
		appKeys,
		// catalog
		productDetail,
		// staff
		connectProduct,
		uploadPack,
		refreshManifest,
		reviewVersion,
		setLifecycle,
		setEnvironments,
		revokeKey,
		listApps,
		appDetail,
		listVersions,
		versionDetail,
		// products
		recordHeartbeat,
		rotateKey,
		consumeLaunch,
		verifyUiBundle,
	};
};
/** @typedef {ReturnType<typeof createCatalogService>} CatalogService */
