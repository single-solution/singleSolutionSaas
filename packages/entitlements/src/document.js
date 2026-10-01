import { validateEntitlementDocument } from '@ss/contracts';

/**
 * Maps the resolver's internal payload onto the canonical `@ss/contracts` entitlement document
 * (payload only; signing belongs to `@ss/protocol`). The resolver's diagnostics (`lockedBy`, `blocked`,
 * `missing`, `blockedBy`, `report`) stay internal; the document carries them only as compact `reason`
 * strings. The result is validated with `validateEntitlementDocument` before it is returned.
 */

/** @typedef {import('./resolve.js').EntitlementPayload} EntitlementPayload */
/** @typedef {import('./resolve.js').Layer} Layer */

/** Resolver layer → contracts `FEATURE_SOURCES`. */
export const SOURCE_NAMES = Object.freeze(
	/** @type {const} */ ({
		product: 'product_default',
		plan: 'plan_default',
		platform: 'platform_policy',
		merchant: 'merchant_default',
		website: 'website_override',
		admin: 'admin_override',
		experiment: 'runtime',
	}),
);

/**
 * @typedef {object} DocumentMeta Fields the Portal supplies (identity, binding, validity, resources).
 * @property {string} [subscriptionId] Must equal the resolved one when given.
 * @property {string} websiteId
 * @property {string} merchantId
 * @property {string} domain
 * @property {boolean} allowSubdomains
 * @property {'live' | 'test'} env
 * @property {string} [productSlug] Must equal the resolved one when given.
 * @property {string | null} [planCode] Must equal the resolved plan when given.
 * @property {string} [priceBookVersion] Defaults to the resolved pin.
 * @property {number} version Integer document version assigned by the Portal (bumped when {@link import('./resolve.js').contentHash} changes).
 * @property {string} issuedAt
 * @property {string} validFrom
 * @property {string} validUntil
 * @property {readonly { kind: string, ref: string, status: string }[]} resources
 * @property {{ prefix: string }} dataScope
 * @property {import('@ss/contracts').IdentitySection | null} [identity] the website's own customer identity issuer
 *   (bring-your-own identity, PLAN §5.3); omitted from the document when absent
 * @property {import('@ss/contracts').WebsiteSection | null} [website] website defaults (`timeZone`, `language`,
 *   `currency`); omitted from the document when absent or empty
 */

/** @typedef {{ path: string, keyword: string, message: string }} Problem */

/**
 * @typedef {{ ok: true, document: import('@ss/contracts').EntitlementDocument }
 *   | { ok: false, reason: 'cancelled' }
 *   | { ok: false, problems: readonly Problem[] }} ToDocumentResult
 */

/**
 * Element reason string (contracts pattern `^[a-z][a-z0-9_.:-]*$`): the source name when configured,
 * the runtime reason otherwise, with details after `:` (`resource_missing:ai:database`, `dependency:codes`).
 * @param {import('./resolve.js').EffectiveElement} element
 * @returns {string}
 */
const elementReason = (element) => {
	if (element.reason === 'resource_missing') return ['resource_missing', ...(element.missing ?? [])].join(':');
	if (element.reason === 'dependency') return ['dependency', ...(element.blockedBy ?? [])].join(':');
	return element.reason in SOURCE_NAMES ? SOURCE_NAMES[/** @type {Layer} */ (element.reason)] : element.reason;
};

/**
 * Builds the canonical entitlement document.
 * @param {EntitlementPayload} resolved Output of `resolveEntitlement`.
 * @param {DocumentMeta} meta
 * @returns {ToDocumentResult}
 */
export const toDocument = (resolved, meta) => {
	if (resolved.state === 'cancelled') return { ok: false, reason: 'cancelled' };
	/** @type {Problem[]} */
	const mismatches = [];
	/**
	 * @param {'subscriptionId' | 'productSlug' | 'planCode'} key
	 * @param {unknown} actual
	 */
	const same = (key, actual) => {
		if (meta[key] !== undefined && meta[key] !== actual) {
			mismatches.push({ path: `/${key}`, keyword: 'mismatch', message: `${key} does not match the resolved entitlement` });
		}
	};
	same('subscriptionId', resolved.subscriptionId);
	same('productSlug', resolved.productSlug);
	same('planCode', resolved.plan);
	if (mismatches.length > 0) return { ok: false, problems: mismatches };

	/** @type {Record<string, { enabled: boolean, reason?: string }>} */
	const elements = {};
	for (const [key, element] of Object.entries(resolved.elements)) {
		elements[key] = element.enabled ? { enabled: true } : { enabled: false, reason: elementReason(element) };
	}
	/** @type {Record<string, { value: unknown, source: string, locked: boolean, reason?: string }>} */
	const features = {};
	for (const [key, feature] of Object.entries(resolved.features)) {
		features[key] = {
			value: feature.value,
			source: SOURCE_NAMES[feature.source],
			locked: feature.locked,
			...(feature.reason === null ? {} : { reason: feature.reason }),
		};
	}
	const document = {
		subscriptionId: resolved.subscriptionId,
		websiteId: meta.websiteId,
		merchantId: meta.merchantId,
		domain: meta.domain,
		allowSubdomains: meta.allowSubdomains,
		env: meta.env,
		productSlug: resolved.productSlug,
		...(resolved.plan === null ? {} : { planCode: resolved.plan }),
		priceBookVersion: meta.priceBookVersion ?? resolved.priceBookVersion,
		version: meta.version,
		issuedAt: meta.issuedAt,
		validFrom: meta.validFrom,
		validUntil: meta.validUntil,
		elements,
		features,
		config: resolved.config,
		runtime: resolved.state === 'active' ? { state: 'active' } : { state: resolved.state, reason: resolved.state },
		resources: meta.resources.map((r) => ({ kind: r.kind, ref: r.ref, status: r.status })),
		dataScope: { prefix: meta.dataScope.prefix },
		...(meta.identity ? { identity: meta.identity } : {}),
		...(meta.website && Object.keys(meta.website).length > 0 ? { website: { ...meta.website } } : {}),
		experiments: Object.values(resolved.experiments)
			.map((e) => ({ element: e.element, variant: e.variant }))
			.sort((a, b) => (a.element < b.element ? -1 : a.element > b.element ? 1 : 0)),
	};
	const result = validateEntitlementDocument(document);
	return result.ok ? { ok: true, document: result.value } : { ok: false, problems: result.problems };
};
