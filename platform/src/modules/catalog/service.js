/**
 * Public service of the `catalog` module: app registry for service products and element packs.
 *
 * - Service onboarding (Portal side of `@ss/protocol` connect): staff add a product with its URL and the deployer's
 *   connect secret; the Portal calls its `/.well-known/ss-connect` (HMAC both ways) and pins its base URL and key.
 *   Connecting again replaces the binding; a changed manifest becomes the current version immediately.
 * - Pack / widget uploads (`ss pack build` descriptor: manifest + asset hashes). Pack versions are `uploading` until
 *   delivery has every asset (`versionReady`); widget uploads of service products are handed to delivery.
 * - Status (`active` | `inactive`, staff switch), launch issuance (`@ss/protocol` `issueLaunch` with the Portal
 *   signer), online launch consumption and the `appKeys` port.
 * - Catalog read models (active products, elements, plans, prices in millicredits).
 *
 * Errors are thrown as `http.js` problems (RFC 9457 codes from `@ss/contracts` plus this module's `catalog_*` codes).
 * @module
 */
import { createId, validateManifest } from '@ss/contracts';
import { checkUrl, createOutboundPolicy, isNetError, safeFetch as netFetch, textOf } from '@ss/net';
import {
	canonicalJson,
	canonicalUrl,
	createJwks,
	createConnectRequest,
	createKeyResolver,
	hashManifest,
	isConnectSecret,
	isProtocolError,
	issueLaunch as protocolIssueLaunch,
	verifyConnectResponse,
} from '@ss/protocol';
import { problem } from '../../infra/http.js';
import { checkBundleAssets, checkWidgetManifest, parseBundleUpload } from './core/bundle.js';
import { launchRefusal, launchUrl } from './core/launch.js';
import { catalogEntry, priceChanges } from './core/summary.js';
import { createCatalogRepo, keyId, versionId } from './repo.js';
import { APPS, KEYS, LAUNCHES, VERSIONS } from './schema.js';

/** @typedef {import('../../infra/modules.js').ModuleContext} ModuleContext */
/** @typedef {import('../../infra/rbac.js').Actor} Actor */
/** @typedef {import('@ss/contracts').Manifest} Manifest */
/** @typedef {import('@ss/protocol').KeyResolver} KeyResolver */
/** @typedef {import('./repo.js').AppDoc} AppDoc */
/** @typedef {import('./repo.js').VersionDoc} VersionDoc */
/** @typedef {import('@ss/net').OutboundPolicy} OutboundPolicy */
/**
 * Outbound HTTP client (the `@ss/net` `safeFetch` signature).
 * @typedef {(url: string, init: import('@ss/net').SafeFetchInit, policy: OutboundPolicy) =>
 *   Promise<import('@ss/net').SafeResponse>} SafeFetch
 */
/** @typedef {import('./core/launch.js').LaunchInput} LaunchInput */
/** @typedef {{ actor: Actor, requestId?: string | null, ip?: string | null }} Audited */

const WELL_KNOWN_APP = '/.well-known/ss-app.json';
const MANIFEST_MAX_BYTES = 256 * 1024;
const SYSTEM = /** @type {Actor} */ ({ type: 'system', id: 'catalog' });

/**
 * @typedef {object} CatalogOptions
 * @property {ReadonlyArray<string>} [allowHosts] development allowlist (hosts/IPs that may be private or plain http);
 *   default `ctx.config.outbound.allowHosts`; always empty in production
 * @property {import('@ss/net').Resolver} [resolve] DNS resolver of the outbound policy (tests)
 * @property {SafeFetch} [fetch] outbound HTTP client (default: `@ss/net` `safeFetch`)
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
 * The reason a product gives in an error answer: its `problems` (a misconfigured product answers
 * `{ status: 'misconfigured', problems }`), else its problem `detail`; at most 5 short sentences, or null.
 * @param {string} text the response body
 * @returns {string | null}
 */
const productReason = (text) => {
	const json = parseJson(text);
	if (!isObject(json)) return null;
	const listed = Array.isArray(json.problems) ? json.problems.filter((p) => typeof p === 'string' && p.trim() !== '') : [];
	const reasons = listed.length > 0 ? listed : typeof json.detail === 'string' && json.detail.trim() !== '' ? [json.detail] : [];
	const joined = reasons
		.slice(0, 5)
		.map((reason) => reason.trim().slice(0, 300))
		.join(' ');
	return joined === '' ? null : joined;
};

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

/** @param {Date | undefined} at */
const iso = (at) => (at instanceof Date ? at.toISOString() : null);

/**
 * @param {ModuleContext} ctx
 * @param {CatalogOptions} [options]
 */
export const createCatalogService = (ctx, options = {}) => {
	const repo = createCatalogRepo({
		apps: ctx.collection(APPS),
		versions: ctx.collection(VERSIONS),
		keys: ctx.collection(KEYS),
		launches: ctx.collection(LAUNCHES),
	});
	/** @type {OutboundPolicy} */
	const policy = createOutboundPolicy({
		allowHosts: ctx.config.isProduction ? [] : [...(options.allowHosts ?? ctx.config.outbound.allowHosts)],
		userAgent: 'ss-portal-catalog/1',
		...(options.resolve ? { resolve: options.resolve } : {}),
	});
	/** @type {SafeFetch} */
	const safeFetch = options.fetch ?? netFetch;

	// ------------------------------------------------------------------------------------------------------------
	// helpers

	/**
	 * Canonical, SSRF-checked base URL (before any request).
	 * @param {string} value
	 */
	const baseUrlOf = (value) => {
		/** @type {string} */
		let canonical;
		try {
			canonical = canonicalUrl(value);
		} catch {
			return fail('validation_failed', '/url is not a valid URL.', {
				errors: [{ path: '/url', message: 'must be a plain http(s) URL' }],
			});
		}
		const checked = checkUrl(canonical, policy);
		if (!checked.ok) fail('catalog_target_refused', `/url: destination refused (${checked.reason}).`);
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
	 * `GET <base>/.well-known/ss-app.json` (the manifest the product advertises; only its slug is used).
	 * @param {string} base
	 * @returns {Promise<Record<string, any>>}
	 */
	const fetchAdvertised = async (base) => {
		const res = await outbound(`${base}${WELL_KNOWN_APP}`, {
			method: 'GET',
			headers: { accept: 'application/json' },
			maxBytes: MANIFEST_MAX_BYTES,
		});
		if (res.status !== 200) {
			const reason = productReason(res.text);
			fail(
				'upstream_error',
				reason
					? `The product cannot serve (${WELL_KNOWN_APP} answered ${res.status}): ${reason}`
					: `${WELL_KNOWN_APP} answered ${res.status}.`,
			);
		}
		const json = parseJson(res.text);
		return isObject(json) ? json : fail('invalid_manifest', `${WELL_KNOWN_APP} is not a JSON object.`);
	};

	/** @param {VersionDoc} doc @returns {Manifest} */
	const manifestOf = (doc) => /** @type {Manifest} */ (JSON.parse(doc.manifestJson));

	/** @param {string} appId */
	const appDoc = async (appId) => (await repo.app(appId)) ?? fail('not_found', `No app ${appId}.`);

	/** @param {AppDoc} app */
	const currentManifest = async (app) => {
		const doc = app.currentVersion === null ? null : await repo.version(app._id, app.currentVersion);
		return doc ? manifestOf(doc) : fail('conflict', `${app.slug} has no ready version yet.`);
	};

	/**
	 * The manifest to describe an app with: the current one, else (a pack still uploading) the latest.
	 * @param {AppDoc} app
	 */
	const describingManifest = async (app) => {
		const doc = await repo.version(app._id, app.currentVersion ?? app.latestVersion);
		return doc ? manifestOf(doc) : null;
	};

	/**
	 * The app view (INTERFACES.md `getApp`).
	 * @param {AppDoc} app
	 * @param {Manifest | null} manifest
	 */
	const appView = (app, manifest) => ({
		appId: app._id,
		slug: app.slug,
		kind: app.kind,
		status: app.status,
		name: manifest?.product.name ?? null,
		productVersion: manifest?.product.version ?? null,
		endpoints: manifest?.endpoints ?? null,
		baseUrl: app.kind === 'service' ? app.baseUrl : null,
		currentVersion: app.currentVersion,
		createdAt: iso(app.createdAt),
	});

	/** @param {VersionDoc} doc */
	const versionView = (doc) => ({
		appId: doc.appId,
		version: doc.version,
		status: doc.status,
		source: doc.source,
		productVersion: doc.productVersion,
		manifestHash: doc.manifestHash,
		assets: doc.assets ?? null,
		submittedBy: doc.submittedBy,
		createdAt: iso(doc.createdAt),
		manifest: JSON.parse(doc.manifestJson),
	});

	/**
	 * @param {{ actor: Actor | { type: string, id: string }, action: string, app: string, before?: unknown,
	 *   after?: unknown, requestId?: string | null, ip?: string | null, merchantId?: string | null }} entry
	 */
	const audit = ({ actor, action, app, before, after, requestId = null, ip = null, merchantId = null }) =>
		ctx.audit.record({
			actor: /** @type {any} */ (actor),
			action,
			target: { type: 'app', id: app, merchantId },
			...(before === undefined ? {} : { before }),
			...(after === undefined ? {} : { after }),
			reason: null,
			requestId,
			ip,
		});

	/**
	 * A new current version: `manifest.accepted@1` (integration) and re-signed entitlements (commerce); both optional
	 * and failure-tolerant (logged).
	 * @param {AppDoc} app
	 * @param {VersionDoc} version
	 */
	const announce = async (app, version) => {
		const names = ctx.moduleNames();
		if (names.includes('integration')) {
			try {
				await ctx.service('integration').emitControl(
					'manifest.accepted@1',
					{
						appId: app._id,
						slug: app.slug,
						kind: app.kind,
						version: version.version,
						productVersion: version.productVersion,
						manifestHash: version.manifestHash,
					},
					{ appIds: [app._id] },
				);
			} catch (error) {
				ctx.logger.error('manifest.accepted emission failed', { error, appId: app._id, version: version.version });
			}
		}
		if (names.includes('commerce')) {
			try {
				await ctx.service('commerce').invalidateApp(app._id);
			} catch (error) {
				ctx.logger.error('entitlement refresh after a new manifest failed', { error, appId: app._id });
			}
		}
	};

	/**
	 * Make a stored version the app's current one (the previous current version is superseded) and announce it.
	 * @param {AppDoc} app
	 * @param {VersionDoc} doc
	 */
	const makeCurrent = async (app, doc) => {
		const updated =
			(await repo.updateApp(app._id, { currentVersion: app.currentVersion }, { $set: { currentVersion: doc.version } })) ??
			fail('conflict', 'The app changed concurrently; retry.');
		if (app.currentVersion !== null) await repo.setVersionStatus(app._id, app.currentVersion, 'accepted', 'superseded');
		await announce(updated, doc);
		return updated;
	};

	/**
	 * @param {{ appId: string, manifest: Manifest, status: VersionDoc['status'], source: VersionDoc['source'],
	 *   submittedBy: string, assets?: VersionDoc['assets'], version?: number }} input
	 * @returns {Promise<VersionDoc>}
	 */
	const storeVersion = async ({ appId, manifest, status, source, submittedBy, assets = null, version }) => {
		const n = version ?? (await repo.nextVersion(appId));
		/** @type {VersionDoc} */
		const doc = {
			_id: versionId(appId, n),
			appId,
			version: n,
			manifestJson: canonicalJson(manifest),
			manifestHash: hashManifest(manifest),
			productVersion: manifest.product.version,
			status,
			source,
			assets,
			submittedBy,
		};
		await repo.insertVersion(doc);
		return doc;
	};

	// ------------------------------------------------------------------------------------------------------------
	// onboarding with the product's connect secret (service products)

	/**
	 * Admin → Apps → Add product: `POST <url>/.well-known/ss-connect`, HMAC-signed with the deployer's `CONNECT_SECRET`
	 * (`@ss/protocol` `createConnectRequest`; the secret itself is never sent nor stored). The product answers its public
	 * key and manifest, HMAC-signed with the same secret; the app is then stored (inactive) with its base URL and key.
	 * Connecting again (same slug) replaces the binding: address and key move, and a changed manifest becomes the current
	 * version at once (`priceChanges` lists the element prices that changed).
	 * @param {{ url: unknown, secret: unknown } & Audited} input
	 */
	const connectProduct = async ({ url, secret, actor, requestId = null, ip = null }) => {
		if (!isConnectSecret(secret))
			fail('validation_failed', 'The connect secret must be at least 32 characters.', {
				errors: [{ path: '/secret', message: 'must be at least 32 characters' }],
			});
		const base = baseUrlOf(String(url ?? ''));
		// the advertised (unsigned) manifest only picks the app to replace; the signed answer is what is stored
		const advertised = await fetchAdvertised(base);
		const slug = isObject(advertised.product) ? advertised.product.slug : undefined;
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
		if (res.status === 503)
			fail('upstream_error', productReason(res.text) ?? 'The product refuses connections: its CONNECT_SECRET is not set.');
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
		const kid = verified.publicJwk.kid;
		const key = { _id: keyId(appId, kid), appId, kid, publicJwk: verified.publicJwk, thumbprint: verified.thumbprint };

		if (!existing) {
			/** @type {AppDoc} */
			const app = {
				_id: appId,
				slug: manifest.product.slug,
				kind: 'service',
				status: 'inactive',
				baseUrl: base,
				currentVersion: 1,
				latestVersion: 1,
				createdBy: actor.id,
			};
			if (!(await repo.insertApp(app))) fail('conflict', `An app with slug ${manifest.product.slug} exists.`);
			const version = await storeVersion({
				appId,
				manifest,
				status: 'accepted',
				source: 'connection',
				submittedBy: actor.id,
				version: 1,
			});
			await repo.insertKey(key);
			await audit({
				actor,
				action: 'catalog.app_connected',
				app: appId,
				after: { slug: app.slug, kind: 'service', baseUrl: base, kid, manifestHash: version.manifestHash },
				requestId,
				ip,
			});
			return { appId, slug: app.slug, baseUrl: base, kid, reconnected: false, version: 1 };
		}

		await repo.insertKey(key);
		await repo.dropOtherKeys(appId, kid);
		const app = /** @type {AppDoc} */ (await repo.updateApp(appId, {}, { $set: { baseUrl: base } }));
		const before = await currentManifest(app);
		/** @type {ReturnType<typeof priceChanges>} */
		let changes = [];
		let version = /** @type {number} */ (app.currentVersion);
		if (hashManifest(before) !== hashManifest(manifest)) {
			const doc = await storeVersion({ appId, manifest, status: 'accepted', source: 'connection', submittedBy: actor.id });
			await makeCurrent(app, doc);
			changes = priceChanges(before, manifest);
			version = doc.version;
		}
		await audit({
			actor,
			action: 'catalog.app_reconnected',
			app: appId,
			before: { baseUrl: existing.baseUrl, currentVersion: existing.currentVersion },
			after: { baseUrl: base, kid, currentVersion: version },
			requestId,
			ip,
		});
		return {
			appId,
			slug: app.slug,
			baseUrl: base,
			kid,
			reconnected: true,
			version,
			...(changes.length > 0 ? { priceChanges: changes } : {}),
		};
	};

	// ------------------------------------------------------------------------------------------------------------
	// packs and widgets

	/**
	 * `POST /v1/admin/packs` `{ descriptor }` (`ss pack build`): a new pack (inactive, version 1 uploading), a new
	 * uploading version of an existing pack (no change when manifest and assets are the same as its latest version), or
	 * the widgets of a connected service product (handed to delivery `registerWidgets`; their elements must be mode A in
	 * the product's current manifest). Assets then go to the returned `uploadPath` one by one (delivery).
	 * @param {{ body: unknown } & Audited} input
	 */
	const uploadPack = async ({ body, actor, requestId = null, ip = null }) => {
		const parsed = parseBundleUpload(body);
		if (!parsed.ok) return fail('catalog_bundle_invalid', 'The bundle upload is invalid.', { errors: parsed.errors });
		const { descriptor } = parsed.value;
		const declared = /** @type {Record<string, any>} */ (descriptor.manifest);
		const existing = isObject(declared.product) ? await repo.appBySlug(String(declared.product.slug)) : null;

		if (existing?.kind === 'service') {
			const errors = checkWidgetManifest(declared, await currentManifest(existing));
			if (errors.length === 0) errors.push(...checkBundleAssets(/** @type {Manifest} */ (declared), descriptor.assets));
			if (errors.length > 0) fail('catalog_bundle_invalid', 'The widget bundle does not match the product.', { errors });
			const registered = await ctx.service('delivery').registerWidgets({ appId: existing._id, descriptor, actor });
			return { appId: existing._id, slug: existing.slug, kind: /** @type {const} */ ('service'), ...registered };
		}

		const manifest = checkedManifest(declared, 'pack', '/descriptor/manifest');
		const assetErrors = checkBundleAssets(manifest, descriptor.assets);
		if (assetErrors.length > 0)
			fail('catalog_bundle_invalid', 'The bundle does not contain the modules it declares.', { errors: assetErrors });
		const assets = descriptor.assets.map((a) => ({
			path: a.path,
			sha256: a.sha256,
			size: a.size,
			...(a.contentType ? { contentType: a.contentType } : {}),
		}));
		/** @param {AppDoc} app @param {VersionDoc} doc @param {boolean} changed */
		const answer = (app, doc, changed) => ({
			appId: app._id,
			slug: app.slug,
			kind: /** @type {const} */ ('pack'),
			version: doc.version,
			status: doc.status === 'uploading' ? 'uploading' : 'ready',
			missing: doc.status === 'uploading' ? (doc.assets ?? []).map((a) => a.path) : [],
			uploadPath: `/v1/admin/packs/${app._id}/versions/${doc.version}/assets/`,
			changed,
		});

		if (existing) {
			const latest = await repo.version(existing._id, existing.latestVersion);
			if (
				latest &&
				latest.status !== 'superseded' &&
				latest.manifestHash === hashManifest(manifest) &&
				canonicalJson(latest.assets ?? []) === canonicalJson(assets)
			)
				return answer(existing, latest, false);
			const doc = await storeVersion({
				appId: existing._id,
				manifest,
				status: 'uploading',
				source: 'upload',
				submittedBy: actor.id,
				assets,
			});
			await repo.supersedeUploads(existing._id, doc.version);
			await audit({
				actor,
				action: 'catalog.pack_uploaded',
				app: existing._id,
				after: { version: doc.version, manifestHash: doc.manifestHash, assets: assets.length },
				requestId,
				ip,
			});
			return answer(existing, doc, true);
		}

		const appId = createId('app', { randomBytes: ctx.randomBytes });
		/** @type {AppDoc} */
		const app = {
			_id: appId,
			slug: manifest.product.slug,
			kind: 'pack',
			status: 'inactive',
			baseUrl: null,
			currentVersion: null,
			latestVersion: 1,
			createdBy: actor.id,
		};
		if (!(await repo.insertApp(app))) fail('conflict', `An app with slug ${manifest.product.slug} already exists.`);
		const doc = await storeVersion({
			appId,
			manifest,
			status: 'uploading',
			source: 'upload',
			submittedBy: actor.id,
			assets,
			version: 1,
		});
		await audit({
			actor,
			action: 'catalog.pack_created',
			app: appId,
			after: { slug: app.slug, manifestHash: doc.manifestHash, assets: assets.length },
			requestId,
			ip,
		});
		return answer(app, doc, true);
	};

	/**
	 * Delivery has every asset of an uploading pack version: it becomes the current version (the previous one is
	 * superseded; an upload older than the latest one is superseded already), `manifest.accepted@1` is emitted and
	 * entitlements re-signed. Idempotent.
	 * @param {{ appId: string, version: number }} input
	 */
	const versionReady = async ({ appId, version }) => {
		const app = await appDoc(appId);
		const doc = (await repo.version(appId, version)) ?? fail('not_found', `No version ${version} of ${appId}.`);
		if (doc.status === 'uploading' && (await repo.setVersionStatus(appId, version, 'uploading', 'accepted'))) {
			await makeCurrent(app, { ...doc, status: 'accepted' });
			await audit({ actor: SYSTEM, action: 'catalog.version_ready', app: appId, after: { version } });
		}
		const fresh = await appDoc(appId);
		return appView(fresh, await describingManifest(fresh));
	};

	// ------------------------------------------------------------------------------------------------------------
	// status

	/**
	 * `POST /v1/admin/apps/:appId/status`: inactive apps are not listed nor newly subscribable, and merchants cannot
	 * open them; existing subscriptions keep working.
	 * @param {{ appId: string, status: 'active' | 'inactive' } & Audited} input
	 */
	const setStatus = async ({ appId, status, actor, requestId = null, ip = null }) => {
		const app = await appDoc(appId);
		if (app.status === status) return appView(app, await describingManifest(app));
		if (status === 'active' && app.currentVersion === null)
			fail('conflict', `${app.slug} has no ready version yet; upload its assets first.`);
		const updated =
			(await repo.updateApp(appId, { status: app.status }, { $set: { status } })) ??
			fail('conflict', 'The app changed concurrently; reload and retry.');
		await audit({
			actor,
			action: status === 'active' ? 'catalog.app_activated' : 'catalog.app_deactivated',
			app: appId,
			before: { status: app.status },
			after: { status },
			requestId,
			ip,
		});
		return appView(updated, await describingManifest(updated));
	};

	// ------------------------------------------------------------------------------------------------------------
	// launches and the keys port

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

	/**
	 * Issue an SSO launch (INTERFACES.md): `{ url, token }` with `url = <baseUrl>/sso?launch=<token>`.
	 * @param {LaunchInput & { requestId?: string | null, ip?: string | null }} input
	 */
	const issueLaunch = async (input) => {
		const app = await appDoc(input.appId);
		const refusal =
			app.kind === 'service'
				? launchRefusal({ input, app, manifest: await currentManifest(app) })
				: 'element packs have no dashboard to launch';
		if (refusal) fail('catalog_launch_refused', refusal);
		const base = app.baseUrl ?? fail('catalog_launch_refused', 'The app has no connected address.');
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
				actor: { type: 'admin', id: input.actor },
				action: 'catalog.launch_issued',
				app: app._id,
				merchantId: claims.scope.merchantId ?? null,
				after: {
					kind: claims.kind,
					subject: claims.sub,
					jti: claims.jti,
					...(claims.scope.all === true ? { scope: 'all' } : {}),
				},
				requestId: input.requestId ?? null,
				ip: input.ip ?? null,
			});
		}
		return { url: launchUrl(base, token), token, jti: claims.jti, expiresAt: new Date(claims.exp * 1000).toISOString() };
	};

	/**
	 * Port `appKeys(appId)`: resolver over the connected service product's key. Packs never authenticate.
	 * @param {string} appId
	 * @returns {Promise<KeyResolver | null>}
	 */
	const appKeys = async (appId) => {
		if (typeof appId !== 'string' || appId.length === 0 || appId.length > 128) return null;
		const app = await repo.app(appId);
		if (!app || app.kind !== 'service') return null;
		const keys = await repo.keys(appId);
		if (keys.length === 0) return null;
		return createKeyResolver({ jwks: createJwks(keys.map((k) => k.publicJwk)), now: ctx.now });
	};

	// ------------------------------------------------------------------------------------------------------------
	// reads

	/** @param {string} appId */
	const getApp = async (appId) => {
		const app = await appDoc(appId);
		return appView(app, await describingManifest(app));
	};

	/** @param {string} slug */
	const appBySlug = async (slug) => {
		const app = (await repo.appBySlug(String(slug))) ?? fail('not_found', `No app ${slug}.`);
		return appView(app, await describingManifest(app));
	};

	/**
	 * @param {string} appId
	 * @param {number} [version] default: the current version
	 * @returns {Promise<Manifest>}
	 */
	const getManifest = async (appId, version) => {
		const app = await appDoc(appId);
		if (version === undefined) return currentManifest(app);
		const doc = (await repo.version(appId, version)) ?? fail('not_found', `No version ${version} of ${appId}.`);
		return manifestOf(doc);
	};

	/**
	 * A stored version with its manifest and asset list (delivery checks pack asset uploads against it).
	 * @param {string} appId
	 * @param {number} version
	 */
	const versionDetail = async (appId, version) => {
		const doc = (await repo.version(appId, version)) ?? fail('not_found', `No version ${version} of ${appId}.`);
		return versionView(doc);
	};

	/**
	 * Catalog listing (merchant and public consoles): active apps with their current manifests.
	 * @param {{ kind?: 'service' | 'pack' }} [filter]
	 */
	const activeProducts = async ({ kind } = {}) => {
		/** @type {AppDoc[]} */
		const apps = [];
		let after = null;
		for (;;) {
			const page = await repo.listApps({ status: ['active'], ...(kind ? { kind } : {}), after, limit: 200 });
			apps.push(...page);
			if (page.length < 200) break;
			after = /** @type {AppDoc} */ (page[page.length - 1])._id;
		}
		const listed = apps.filter((a) => a.currentVersion !== null);
		const versions = await repo.versionsByRef(
			listed.map((a) => ({ appId: a._id, version: /** @type {number} */ (a.currentVersion) })),
		);
		const byId = new Map(versions.map((v) => [v.appId, v]));
		return listed.flatMap((app) => {
			const doc = byId.get(app._id);
			return doc
				? [
						catalogEntry(
							{ ...app, appId: app._id, currentVersion: /** @type {number} */ (app.currentVersion) },
							manifestOf(doc),
						),
					]
				: [];
		});
	};

	/**
	 * Catalog detail by slug (includes feature schemas). Only active apps.
	 * @param {string} slug
	 */
	const productDetail = async (slug) => {
		const app = await repo.appBySlug(String(slug));
		if (!app || app.status !== 'active' || app.currentVersion === null) return fail('not_found', `No product ${slug}.`);
		return catalogEntry({ ...app, appId: app._id, currentVersion: app.currentVersion }, await currentManifest(app), {
			detail: true,
		});
	};

	/**
	 * Staff listing.
	 * @param {{ status?: string[], kind?: string, after?: string | null, limit: number }} query
	 */
	const listApps = async (query) => {
		const apps = await repo.listApps(query);
		const versions = await repo.versionsByRef(
			apps.map((a) => ({ appId: a._id, version: a.currentVersion ?? a.latestVersion })),
		);
		const byId = new Map(versions.map((v) => [v.appId, manifestOf(v)]));
		return apps.map((app) => appView(app, byId.get(app._id) ?? null));
	};

	/**
	 * Staff detail: the app view, its last 50 versions (summary) and the product's key.
	 * @param {string} appId
	 */
	const appDetail = async (appId) => {
		const app = await appDoc(appId);
		return {
			...appView(app, await describingManifest(app)),
			versions: (await repo.listVersions(appId, 50)).map((v) => ({
				version: v.version,
				productVersion: v.productVersion,
				status: v.status,
				createdAt: iso(v.createdAt),
			})),
			keys: (await repo.keys(appId)).map((k) => ({ kid: k.kid, thumbprint: k.thumbprint, createdAt: iso(k.createdAt) })),
		};
	};

	return {
		// INTERFACES.md
		getApp,
		appBySlug,
		getManifest,
		versionDetail,
		versionReady,
		activeProducts,
		issueLaunch,
		appKeys,
		// catalog
		productDetail,
		// staff
		connectProduct,
		uploadPack,
		setStatus,
		listApps,
		appDetail,
		// products
		consumeLaunch,
	};
};
/** @typedef {ReturnType<typeof createCatalogService>} CatalogService */
