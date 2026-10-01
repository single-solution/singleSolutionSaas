/**
 * Element-pack bundle descriptors (pure validation). Packs have no backend and no registration handshake (F.3):
 * the developer publishes a **signed bundle descriptor** — the manifest plus the SHA-256 of every asset — and the
 * Portal stores the descriptor metadata (assets themselves will live on CDN storage; the Loader verifies them against
 * these hashes).
 *
 * Wire shape (`POST /v1/admin/packs`):
 *
 * ```json
 * { "descriptor": { "format": "ss-pack-bundle@1", "manifest": { … },
 *                   "assets": [{ "path": "ui/bar.js", "sha256": "<64 hex>", "size": 2048, "contentType": "text/javascript" }] },
 *   "signature": { "kid": "dev-key-1", "alg": "EdDSA", "sig": "<base64url Ed25519 signature>" },
 *   "publicJwk": { … }   // first upload of a new pack only: the developer key to pin
 * }
 * ```
 *
 * The signature covers `ss-pack-bundle.v1.<sha256hex(canonicalJson(descriptor))>` (domain-separated from every other
 * signed object); it is made and checked with `@ss/protocol` `signBundle` / `verifyBundle`.
 * @module
 */

export const BUNDLE_FORMAT = 'ss-pack-bundle@1';
export const MAX_ASSETS = 500;
export const MAX_ASSET_BYTES = 5 * 1024 * 1024;

const PATH = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*(\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const KID = /^[A-Za-z0-9._:-]{1,128}$/;
const SIG = /^[A-Za-z0-9_-]{86}$/;
const CONTENT_TYPE = /^[a-z]+\/[a-z0-9.+-]+(;\s*charset=[a-z0-9-]+)?$/;

/** @typedef {{ path: string, sha256: string, size: number, contentType?: string }} Asset */
/** @typedef {{ format: typeof BUNDLE_FORMAT, manifest: unknown, assets: Asset[], createdAt?: string }} Descriptor */
/** @typedef {{ kid: string, alg: 'EdDSA', sig: string }} BundleSignature */
/** @typedef {{ path: string, message: string }} FieldError */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Validate the upload shape (the manifest itself is validated with `@ss/contracts` by the service).
 * @param {unknown} body
 * @returns {{ ok: true, value: { descriptor: Descriptor, signature: BundleSignature, publicJwk: unknown } } | { ok: false, errors: FieldError[] }}
 */
export const parseBundleUpload = (body) => {
	/** @type {FieldError[]} */
	const errors = [];
	if (!isObject(body))
		return { ok: false, errors: [{ path: '', message: 'body must be { descriptor, signature, publicJwk? }' }] };
	const { descriptor, signature, publicJwk, ...rest } = body;
	for (const key of Object.keys(rest)) errors.push({ path: `/${key}`, message: 'unknown property' });
	if (!isObject(descriptor)) errors.push({ path: '/descriptor', message: 'descriptor must be an object' });
	else {
		const { format, manifest, assets, createdAt, ...extra } = descriptor;
		for (const key of Object.keys(extra)) errors.push({ path: `/descriptor/${key}`, message: 'unknown property' });
		if (format !== BUNDLE_FORMAT) errors.push({ path: '/descriptor/format', message: `format must be ${BUNDLE_FORMAT}` });
		if (!isObject(manifest)) errors.push({ path: '/descriptor/manifest', message: 'manifest must be an object' });
		if (createdAt !== undefined && (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))))
			errors.push({ path: '/descriptor/createdAt', message: 'createdAt must be an ISO-8601 timestamp' });
		if (!Array.isArray(assets) || assets.length === 0 || assets.length > MAX_ASSETS)
			errors.push({ path: '/descriptor/assets', message: `assets must list 1..${MAX_ASSETS} files` });
		else {
			const seen = new Set();
			assets.forEach((asset, i) => {
				const at = `/descriptor/assets/${i}`;
				if (!isObject(asset)) return void errors.push({ path: at, message: 'asset must be an object' });
				const { path, sha256, size, contentType, ...more } = asset;
				for (const key of Object.keys(more)) errors.push({ path: `${at}/${key}`, message: 'unknown property' });
				if (typeof path !== 'string' || path.length > 200 || !PATH.test(path) || path.split('/').includes('..'))
					errors.push({ path: `${at}/path`, message: 'path must be a relative file path' });
				else if (seen.has(path)) errors.push({ path: `${at}/path`, message: `duplicate asset ${path}` });
				else seen.add(path);
				if (typeof sha256 !== 'string' || !SHA256.test(sha256))
					errors.push({ path: `${at}/sha256`, message: 'sha256 must be 64 lower-case hex characters' });
				if (!Number.isSafeInteger(size) || /** @type {number} */ (size) < 0 || /** @type {number} */ (size) > MAX_ASSET_BYTES)
					errors.push({ path: `${at}/size`, message: `size must be 0..${MAX_ASSET_BYTES} bytes` });
				if (contentType !== undefined && (typeof contentType !== 'string' || !CONTENT_TYPE.test(contentType)))
					errors.push({ path: `${at}/contentType`, message: 'contentType must be a media type' });
			});
		}
	}
	if (!isObject(signature)) errors.push({ path: '/signature', message: 'signature must be { kid, alg, sig }' });
	else {
		if (typeof signature.kid !== 'string' || !KID.test(signature.kid))
			errors.push({ path: '/signature/kid', message: 'kid is invalid' });
		if (signature.alg !== 'EdDSA') errors.push({ path: '/signature/alg', message: 'alg must be EdDSA' });
		if (typeof signature.sig !== 'string' || !SIG.test(signature.sig))
			errors.push({ path: '/signature/sig', message: 'sig must be a base64url Ed25519 signature' });
	}
	if (publicJwk !== undefined && !isObject(publicJwk)) errors.push({ path: '/publicJwk', message: 'publicJwk must be a JWK' });
	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		value: {
			descriptor: /** @type {Descriptor} */ (descriptor),
			signature: /** @type {BundleSignature} */ (signature),
			publicJwk,
		},
	};
};

/**
 * Cross-check a schema-valid pack manifest against its assets: every `headless` / `renderer` module reference must
 * point at a listed asset.
 * @param {import('@ss/contracts').Manifest} manifest
 * @param {ReadonlyArray<Asset>} assets
 * @returns {FieldError[]}
 */
export const checkBundleAssets = (manifest, assets) => {
	const paths = new Set(assets.map((a) => a.path));
	/** @type {FieldError[]} */
	const errors = [];
	manifest.elements.forEach((element, i) => {
		for (const field of /** @type {const} */ (['headless', 'renderer'])) {
			const ref = element[field];
			if (typeof ref !== 'string') continue;
			const file = ref.split('#')[0] ?? '';
			if (!paths.has(file))
				errors.push({
					path: `/descriptor/manifest/elements/${i}/${field}`,
					message: `module ${file} is not in the bundle assets`,
				});
		}
		if (typeof element.strings === 'string' && !paths.has(element.strings))
			errors.push({
				path: `/descriptor/manifest/elements/${i}/strings`,
				message: `strings ${element.strings} are not in the bundle assets`,
			});
	});
	return errors;
};

const ELEMENT_KEY = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const MODULE_REF = /^((?!\/)(?!.*\.\.)[A-Za-z0-9_./-]+\.m?js)#([A-Za-z_$][A-Za-z0-9_$]*)$/;
const UI_ELEMENT_FIELDS = Object.freeze(['key', 'headless', 'renderer', 'strings']);

/**
 * Check the manifest part of a service product's **UI bundle** descriptor (F.16): the same `ss-pack-bundle@1`
 * descriptor as packs, but `manifest` is only `{ product: { slug, version }, elements: [{ key, headless, renderer,
 * strings? }] }` — the browser modules of the product's mode-A elements. Everything else about the elements comes
 * from the product's accepted manifest (the compiler only uses a UI bundle for elements that manifest enables).
 * @param {unknown} manifest
 * @param {string} slug the product's registered slug
 * @returns {FieldError[]}
 */
export const checkUiManifest = (manifest, slug) => {
	/** @type {FieldError[]} */
	const errors = [];
	const at = '/descriptor/manifest';
	if (!isObject(manifest)) return [{ path: at, message: 'manifest must be an object' }];
	const { product, elements, ...rest } = manifest;
	for (const key of Object.keys(rest)) errors.push({ path: `${at}/${key}`, message: 'unknown property' });
	if (!isObject(product) || product.slug !== slug)
		errors.push({ path: `${at}/product/slug`, message: `must be the product's slug ${slug}` });
	else if (typeof product.version !== 'string' || product.version.length === 0 || product.version.length > 64)
		errors.push({ path: `${at}/product/version`, message: 'version must be a string' });
	if (!Array.isArray(elements) || elements.length === 0 || elements.length > 200)
		return [...errors, { path: `${at}/elements`, message: 'elements must list 1..200 elements' }];
	const seen = new Set();
	elements.forEach((element, i) => {
		const p = `${at}/elements/${i}`;
		if (!isObject(element)) return void errors.push({ path: p, message: 'element must be an object' });
		for (const key of Object.keys(element))
			if (!UI_ELEMENT_FIELDS.includes(key)) errors.push({ path: `${p}/${key}`, message: 'unknown property' });
		if (typeof element.key !== 'string' || element.key.length > 40 || !ELEMENT_KEY.test(element.key))
			errors.push({ path: `${p}/key`, message: 'key must be an element key' });
		else if (seen.has(element.key)) errors.push({ path: `${p}/key`, message: `duplicate element ${element.key}` });
		else seen.add(element.key);
		for (const field of /** @type {const} */ (['headless', 'renderer']))
			if (typeof element[field] !== 'string' || !MODULE_REF.test(element[field]))
				errors.push({ path: `${p}/${field}`, message: `${field} must be a module reference file.js#export` });
		if (element.strings !== undefined && (typeof element.strings !== 'string' || !element.strings.endsWith('.json')))
			errors.push({ path: `${p}/strings`, message: 'strings must be the path of a JSON asset' });
	});
	return errors;
};
