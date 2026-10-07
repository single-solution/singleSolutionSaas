/**
 * Pack / widget bundle descriptors (pure validation). `ss pack build` writes `descriptor.json` — the manifest plus the
 * SHA-256, size and type of every asset — and staff upload it (`POST /v1/admin/packs` `{ descriptor }`); the assets
 * follow one by one to delivery, which checks each against these hashes.
 *
 * ```json
 * { "descriptor": { "format": "ss-pack-bundle@1", "manifest": { … },
 *                   "assets": [{ "path": "ui/bar.js", "sha256": "<64 hex>", "size": 2048, "contentType": "text/javascript" }] } }
 * ```
 * @module
 */

export const BUNDLE_FORMAT = 'ss-pack-bundle@1';
const MAX_ASSETS = 500;
const MAX_ASSET_BYTES = 5 * 1024 * 1024;

const PATH = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*(\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CONTENT_TYPE = /^[a-z]+\/[a-z0-9.+-]+(;\s*charset=[a-z0-9-]+)?$/;

/** @typedef {{ path: string, sha256: string, size: number, contentType?: string }} Asset */
/** @typedef {{ format: typeof BUNDLE_FORMAT, manifest: unknown, assets: Asset[], createdAt?: string }} Descriptor */
/** @typedef {{ path: string, message: string }} FieldError */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Validate the upload shape (the manifest itself is validated with `@ss/contracts` by the service).
 * @param {unknown} body
 * @returns {{ ok: true, value: { descriptor: Descriptor } } | { ok: false, errors: FieldError[] }}
 */
export const parseBundleUpload = (body) => {
	/** @type {FieldError[]} */
	const errors = [];
	if (!isObject(body)) return { ok: false, errors: [{ path: '', message: 'body must be { descriptor }' }] };
	const { descriptor, ...rest } = body;
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
	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		value: { descriptor: /** @type {Descriptor} */ (descriptor) },
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

/**
 * Widget upload of a service product: every mode-A element of the descriptor's manifest that ships browser modules
 * (`headless` / `renderer`) must be declared mode A in the product's current manifest, under the product's slug, and
 * ship both modules. Elements without mode A (e.g. a headless-only core for mode B) are bundled but not widgets.
 * @param {unknown} manifest the descriptor's manifest
 * @param {import('@ss/contracts').Manifest} current the app's current manifest
 * @returns {FieldError[]}
 */
export const checkWidgetManifest = (manifest, current) => {
	const at = '/descriptor/manifest';
	if (!isObject(manifest) || !Array.isArray(manifest.elements))
		return [{ path: `${at}/elements`, message: 'must list elements' }];
	/** @type {FieldError[]} */
	const errors = [];
	if (!isObject(manifest.product) || manifest.product.slug !== current.product.slug)
		errors.push({ path: `${at}/product/slug`, message: `must be the product's slug ${current.product.slug}` });
	const modeA = new Set(current.elements.filter((e) => e.modes.includes('A')).map((e) => e.key));
	let widgets = 0;
	manifest.elements.forEach((element, i) => {
		if (!isObject(element) || (typeof element.headless !== 'string' && typeof element.renderer !== 'string')) return;
		if (!Array.isArray(element.modes) || !element.modes.includes('A')) return;
		widgets += 1;
		if (typeof element.key !== 'string' || !modeA.has(element.key))
			errors.push({
				path: `${at}/elements/${i}/key`,
				message: `${String(element.key)} is not a mode A element of the product`,
			});
		for (const field of /** @type {const} */ (['headless', 'renderer']))
			if (typeof element[field] !== 'string')
				errors.push({ path: `${at}/elements/${i}/${field}`, message: `${field} must be a module reference file.js#export` });
	});
	if (widgets === 0 && errors.length === 0) errors.push({ path: `${at}/elements`, message: 'no element ships browser modules' });
	return errors;
};
