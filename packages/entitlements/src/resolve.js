import { currentPriceBook, isNumericFeature, isValidFeatureValue, withinPlanMax } from './catalog.js';
import { sha256Hex, stableStringify } from './hash.js';
import { isoInstant, toMs, toMsOr } from './time.js';

/**
 * Entitlement resolution: product + subscription + configuration layers + runtime state → the
 * effective (unsigned) entitlement document payload. See README.md for the normative semantics.
 */

/** @typedef {import('./catalog.js').Product} Product */
/** @typedef {import('./catalog.js').FeatureDef} FeatureDef */
/** @typedef {import('./catalog.js').ElementDef} ElementDef */
/** @typedef {import('./time.js').Instant} Instant */

/** Configuration layers in precedence order (later wins unless a lock says otherwise). */
export const LAYERS = /** @type {const} */ (['product', 'plan', 'platform', 'website', 'admin']);

/** @typedef {typeof LAYERS[number]} Layer */
/** @typedef {'active' | 'paused' | 'suspended' | 'cancelled' | 'spend_cap'} RuntimeState */

/**
 * Authority used by lock semantics: a lock set by layer N binds every layer of lower authority.
 * The customer layer (website) has the lowest authority; admin the highest.
 * @type {Readonly<Record<Layer, number>>}
 */
export const AUTHORITY = { website: 1, product: 2, plan: 2, platform: 3, admin: 4 };

/** The layer authored by the customer: bounded by the plan and bound by locks. */
const CUSTOMER_LAYERS = new Set(['website']);

/**
 * @typedef {object} ElementEntry
 * @property {boolean} enabled
 * @property {boolean} [locked]
 * @property {Instant} [from] Entry applies from this instant (inclusive).
 * @property {Instant} [until] Entry applies until this instant (exclusive).
 */

/**
 * @typedef {object} FeatureEntry
 * @property {unknown} value
 * @property {boolean} [locked]
 * @property {Instant} [from]
 * @property {Instant} [until]
 */

/**
 * @typedef {object} LayerInput
 * @property {Readonly<Record<string, ElementEntry | boolean>>} [elements]
 * @property {Readonly<Record<string, FeatureEntry>>} [features]
 */

/**
 * @typedef {object} Subscription
 * @property {string} id
 * @property {string | null} [plan]
 * @property {string} [priceBookVersion] Pinned price-book version.
 * @property {'active' | 'trialing' | 'paused' | 'suspended' | 'cancelled'} [status]
 * @property {string} [websiteId]
 * @property {string} [merchantId]
 */

/**
 * @typedef {object} RuntimeInput
 * @property {'active' | 'paused' | 'suspended' | 'cancelled'} [state]
 * @property {boolean} [spendCap] A spend cap is reached (see spend.js).
 * @property {Readonly<Record<string, number>>} [usage] Period-to-date usage by quota feature key.
 * @property {Readonly<Record<string, string>> | readonly { kind: string, status: string }[]} [resources] Client resource status by kind
 *   (contracts `RESOURCE_STATUSES`; only `'connected'` is usable).
 */

/**
 * @typedef {object} ReportItem
 * @property {'element' | 'feature'} target
 * @property {string} key
 * @property {Layer} layer
 * @property {'ignored' | 'clamped'} kind
 * @property {string} reason `locked` | `invalid` | `unknown` | `lock_not_allowed` | `plan_max` | `min` | `max` | `not_in_plan`
 * @property {unknown} [attempted]
 * @property {unknown} [applied]
 * @property {Layer} [lockedBy]
 */

/**
 * @typedef {object} EffectiveElement
 * @property {boolean} enabled
 * @property {Layer} source Layer that supplied the configured on/off value.
 * @property {boolean} locked
 * @property {Layer | null} lockedBy
 * @property {string} reason Why the element is in this state: the source layer, `not_in_plan`, or a runtime reason
 *   (`cancelled` | `suspended` | `paused` | `spend_cap` | `resource_missing` | `dependency`).
 * @property {string[]} [missing] Resource kinds that are not connected (`resource_missing`).
 * @property {string[]} [blockedBy] Disabled dependencies (`dependency`).
 */

/**
 * @typedef {object} EffectiveFeature
 * @property {unknown} value
 * @property {Layer} source
 * @property {boolean} locked
 * @property {Layer | null} lockedBy
 * @property {'clamped' | 'quota_exhausted' | null} reason
 * @property {boolean} blocked Hard-stop quota exhausted.
 */

/**
 * @typedef {object} EntitlementPayload
 * @property {'entitlement@1'} schema
 * @property {string} subscriptionId
 * @property {string} productSlug
 * @property {string} productVersion
 * @property {string | null} plan
 * @property {string | null} priceBookVersion
 * @property {RuntimeState} state
 * @property {Record<string, EffectiveElement>} elements
 * @property {Record<string, EffectiveFeature>} features
 * @property {Record<string, Record<string, unknown>>} config Effective feature values grouped by element.
 * @property {string} contentHash SHA-256 of the effective content (everything above); see {@link contentHash}.
 * @property {string} resolvedAt
 * @property {ReportItem[]} report Clamped values and ignored attempts (diagnostic; not part of `contentHash`).
 */

/**
 * @typedef {object} Candidate
 * @property {Layer} layer
 * @property {unknown} value
 * @property {boolean} locked
 */

/**
 * @param {string} reason
 * @param {string} message
 * @returns {Error & { code: string }}
 */
const resolveError = (reason, message) => Object.assign(new Error(message), { code: `resolve/${reason}` });

/**
 * Whether a scheduled entry applies at `now`.
 * @param {{ from?: Instant, until?: Instant }} entry
 * @param {number} now
 * @returns {boolean}
 */
const activeAt = (entry, now) =>
	toMsOr(entry.from, Number.NEGATIVE_INFINITY, 'from') <= now && now < toMsOr(entry.until, Number.POSITIVE_INFINITY, 'until');

/**
 * Picks the effective candidate under lock semantics.
 * @param {readonly Candidate[]} candidates In precedence order, non-empty.
 * @returns {{ effective: Candidate, holder: Candidate | null, ignored: Candidate[] }}
 */
export const pickEffective = (candidates) => {
	/** @type {Candidate | null} */
	let holder = null;
	for (const candidate of candidates) {
		if (candidate.locked && (holder === null || AUTHORITY[candidate.layer] >= AUTHORITY[holder.layer])) holder = candidate;
	}
	const floor = holder ? AUTHORITY[holder.layer] : 0;
	const eligible = candidates.filter((c) => AUTHORITY[c.layer] >= floor);
	const ignored = candidates.filter((c) => AUTHORITY[c.layer] < floor && CUSTOMER_LAYERS.has(c.layer));
	const effective = /** @type {Candidate} */ (eligible.at(-1));
	return { effective, holder, ignored };
};

/**
 * Clamps a numeric value into absolute and (for customer layers) plan bounds.
 * @param {FeatureDef} feature
 * @param {Layer} layer
 * @param {unknown} value
 * @param {import('./catalog.js').PlanMax | undefined} planMax
 * @returns {{ value: unknown, reason: string | null }}
 */
const clampFeature = (feature, layer, value, planMax) => {
	const customer = CUSTOMER_LAYERS.has(layer);
	if (feature.jsonType === 'boolean') {
		return customer && !withinPlanMax(feature, value, planMax) ? { value: false, reason: 'plan_max' } : { value, reason: null };
	}
	if (!isNumericFeature(feature)) return { value, reason: null };
	/** @type {unknown} */
	let result = value;
	/** @type {string | null} */
	let reason = null;
	if (customer && !withinPlanMax(feature, result, planMax)) {
		result = planMax;
		reason = 'plan_max';
	}
	if (feature.min !== null && result !== null && /** @type {number} */ (result) < feature.min) {
		result = feature.min;
		reason = 'min';
	}
	if (feature.max !== null && (result === null || /** @type {number} */ (result) > feature.max)) {
		result = feature.max;
		reason = 'max';
	}
	return { value: result, reason };
};

/**
 * True when a customer value exceeds the plan max of a feature that cannot be clamped
 * (strings and arrays: length / item count). Such values are ignored rather than truncated.
 * @param {FeatureDef} feature
 * @param {unknown} value
 * @param {import('./catalog.js').PlanMax | undefined} planMax
 * @returns {boolean}
 */
const exceedsUnclampable = (feature, value, planMax) =>
	!isNumericFeature(feature) && feature.jsonType !== 'boolean' && !withinPlanMax(feature, value, planMax);

/**
 * Collects the configured candidates for one key across all layers.
 * @param {object} input
 * @param {'element' | 'feature'} input.target
 * @param {string} input.key
 * @param {Candidate} input.productCandidate
 * @param {Candidate | null} input.planCandidate
 * @param {Readonly<Partial<Record<Layer, LayerInput>>>} input.layers
 * @param {number} input.now
 * @param {(value: unknown) => boolean} input.valid
 * @param {boolean} input.lockable
 * @param {(layer: Layer, value: unknown) => string | null} input.reject Returns a reason to ignore a layer value, or null.
 * @param {ReportItem[]} input.report Accumulator (local to one resolution).
 * @returns {Candidate[]}
 */
const collectCandidates = ({ target, key, productCandidate, planCandidate, layers, now, valid, lockable, reject, report }) => {
	/** @type {Candidate[]} */
	const candidates = [productCandidate];
	if (planCandidate) candidates.push(planCandidate);
	for (const layer of /** @type {const} */ (['platform', 'website', 'admin'])) {
		const source = target === 'element' ? layers[layer]?.elements : layers[layer]?.features;
		const raw = source?.[key];
		if (raw === undefined) continue;
		/** @type {{ value: unknown, locked?: boolean, from?: Instant, until?: Instant }} */
		const entry =
			target === 'element'
				? raw === null || typeof raw !== 'object'
					? { value: raw }
					: { .../** @type {ElementEntry} */ (raw), value: /** @type {ElementEntry} */ (raw).enabled }
				: /** @type {FeatureEntry} */ (raw);
		if (!activeAt(entry, now)) continue;
		if (!valid(entry.value)) {
			report.push({ target, key, layer, kind: 'ignored', reason: 'invalid', attempted: entry.value });
			continue;
		}
		const rejection = reject(layer, entry.value);
		if (rejection !== null) {
			report.push({ target, key, layer, kind: 'ignored', reason: rejection, attempted: entry.value });
			continue;
		}
		let locked = entry.locked === true;
		if (locked && !lockable && layer !== 'admin') {
			report.push({ target, key, layer, kind: 'ignored', reason: 'lock_not_allowed' });
			locked = false;
		}
		candidates.push({ layer, value: entry.value, locked });
	}
	return candidates;
};

/**
 * @param {Subscription} subscription
 * @param {RuntimeInput} runtime
 * @returns {RuntimeState}
 */
const runtimeState = (subscription, runtime) => {
	const states = [subscription.status, runtime.state];
	if (states.includes('cancelled')) return 'cancelled';
	if (states.includes('suspended')) return 'suspended';
	if (states.includes('paused')) return 'paused';
	if (runtime.spendCap === true) return 'spend_cap';
	return 'active';
};

/**
 * Resolves the effective entitlement for one subscription.
 * @param {object} input
 * @param {Product} input.product Normalised product (catalog.js).
 * @param {Subscription} input.subscription
 * @param {Readonly<Partial<Record<'platform' | 'website' | 'admin', LayerInput>>>} [input.layers]
 * @param {RuntimeInput} [input.runtime]
 * @param {Instant} input.now
 * @param {(text: string) => string} [input.hash] Hasher for `contentHash` (default SHA-256 hex).
 * @returns {EntitlementPayload}
 */
export const resolveEntitlement = ({ product, subscription, layers = {}, runtime = {}, now, hash = sha256Hex }) => {
	const nowMs = toMs(now, 'now');
	const planCode = subscription.plan ?? null;
	const plan = planCode === null ? null : (product.plans[planCode] ?? null);
	if (planCode !== null && plan === null)
		throw resolveError('unknown_plan', `subscription plan ${planCode} is not defined by ${product.slug}`);
	/** @type {ReportItem[]} */
	const report = [];

	for (const layer of /** @type {const} */ (['platform', 'website', 'admin'])) {
		for (const key of Object.keys(layers[layer]?.elements ?? {})) {
			if (!product.elements[key]) report.push({ target: 'element', key, layer, kind: 'ignored', reason: 'unknown' });
		}
		for (const key of Object.keys(layers[layer]?.features ?? {})) {
			if (!product.features[key]) report.push({ target: 'feature', key, layer, kind: 'ignored', reason: 'unknown' });
		}
	}

	// 1. Configured element state (layers + locks + plan bounds).
	/** @type {Record<string, EffectiveElement>} */
	const elements = {};
	for (const key of product.elementOrder) {
		const el = /** @type {ElementDef} */ (product.elements[key]);
		const available = plan === null || plan.available.includes(key);
		const candidates = collectCandidates({
			target: 'element',
			key,
			productCandidate: { layer: 'product', value: el.defaultEnabled, locked: false },
			planCandidate: plan ? { layer: 'plan', value: plan.elements.includes(key), locked: false } : null,
			layers,
			now: nowMs,
			valid: (value) => typeof value === 'boolean',
			lockable: true,
			reject: (layer, value) => (value === true && !available && CUSTOMER_LAYERS.has(layer) ? 'not_in_plan' : null),
			report,
		});
		const { effective, holder, ignored } = pickEffective(candidates);
		for (const c of ignored) {
			report.push({
				target: 'element',
				key,
				layer: c.layer,
				kind: 'ignored',
				reason: 'locked',
				attempted: c.value,
				lockedBy: holder?.layer,
			});
		}
		// Unavailable on the plan: only staff layers (platform, admin) can switch it on.
		const staffEnabled = effective.layer === 'platform' || effective.layer === 'admin';
		const enabled = effective.value === true && (available || staffEnabled);
		const reason = available || staffEnabled ? /** @type {string} */ (effective.layer) : 'not_in_plan';
		elements[key] = { enabled, source: effective.layer, locked: holder !== null, lockedBy: holder?.layer ?? null, reason };
	}

	// 2. Runtime state, resources, then dependency cascade (topological order).
	const state = runtimeState(subscription, runtime);
	/** @type {Record<string, string>} */
	const resourceStatus = Array.isArray(runtime.resources)
		? Object.fromEntries(runtime.resources.map((r) => [r.kind, r.status]))
		: { ...(runtime.resources ?? {}) };
	for (const key of product.elementOrder) {
		const current = /** @type {EffectiveElement} */ (elements[key]);
		if (!current.enabled) continue;
		const el = /** @type {ElementDef} */ (product.elements[key]);
		const missing = el.requires.filter((kind) => resourceStatus[kind] !== 'connected');
		const blockedBy = el.dependsOn.filter((dep) => elements[dep]?.enabled !== true);
		if (state !== 'active') elements[key] = { ...current, enabled: false, reason: state };
		else if (missing.length > 0) elements[key] = { ...current, enabled: false, reason: 'resource_missing', missing };
		else if (blockedBy.length > 0) elements[key] = { ...current, enabled: false, reason: 'dependency', blockedBy };
	}

	// 3. Features (layers + locks + clamping), quota hard stops.
	/** @type {Record<string, EffectiveFeature>} */
	const features = {};
	for (const key of Object.keys(product.features).sort()) {
		const feature = /** @type {FeatureDef} */ (product.features[key]);
		const candidates = collectCandidates({
			target: 'feature',
			key,
			productCandidate: { layer: 'product', value: feature.default, locked: false },
			planCandidate: plan && key in plan.defaults ? { layer: 'plan', value: plan.defaults[key], locked: false } : null,
			layers,
			now: nowMs,
			valid: (value) => isValidFeatureValue(feature, value),
			lockable: feature.lockable,
			reject: (layer, value) =>
				CUSTOMER_LAYERS.has(layer) && exceedsUnclampable(feature, value, plan?.max[key]) ? 'plan_max' : null,
			report,
		});
		const { effective, holder, ignored } = pickEffective(candidates);
		for (const c of ignored) {
			report.push({
				target: 'feature',
				key,
				layer: c.layer,
				kind: 'ignored',
				reason: 'locked',
				attempted: c.value,
				lockedBy: holder?.layer,
			});
		}
		const clamped = clampFeature(feature, effective.layer, effective.value, plan?.max[key]);
		if (clamped.reason) {
			report.push({
				target: 'feature',
				key,
				layer: effective.layer,
				kind: 'clamped',
				reason: clamped.reason,
				attempted: effective.value,
				applied: clamped.value,
			});
		}
		features[key] = {
			value: clamped.value,
			source: effective.layer,
			locked: holder !== null,
			lockedBy: holder?.layer ?? null,
			reason: clamped.reason ? 'clamped' : null,
			blocked: false,
		};
	}

	for (const key of Object.keys(runtime.usage ?? {})) {
		const feature = product.features[key];
		const current = features[key];
		const used = runtime.usage?.[key] ?? 0;
		if (
			feature?.kind === 'quota' &&
			current &&
			feature.hardStop &&
			current.value !== null &&
			used >= /** @type {number} */ (current.value)
		) {
			features[key] = { ...current, blocked: true, reason: 'quota_exhausted' };
		}
	}

	/** @type {Record<string, Record<string, unknown>>} */
	const config = {};
	for (const key of Object.keys(product.elements).sort()) config[key] = {};
	for (const [key, effective] of Object.entries(features)) {
		const feature = /** @type {FeatureDef} */ (product.features[key]);
		/** @type {Record<string, unknown>} */ (config[feature.element])[feature.name] = effective.value;
	}

	const content = {
		schema: /** @type {const} */ ('entitlement@1'),
		subscriptionId: subscription.id,
		productSlug: product.slug,
		productVersion: product.version,
		plan: planCode,
		priceBookVersion: subscription.priceBookVersion ?? currentPriceBook(product, nowMs)?.version ?? null,
		state,
		elements: sortKeys(elements),
		features,
		config,
	};
	return { ...content, contentHash: hash(stableStringify(content)), resolvedAt: isoInstant(nowMs), report: sortReport(report) };
};

/**
 * Copy of a record with keys in sorted order.
 * @template T
 * @param {Readonly<Record<string, T>>} record
 * @returns {Record<string, T>}
 */
const sortKeys = (record) => Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

const LAYER_RANK = { product: 0, plan: 1, platform: 2, website: 3, admin: 4 };

/**
 * Deterministic report order: target, key, layer precedence, kind, reason.
 * @param {readonly ReportItem[]} report
 * @returns {ReportItem[]}
 */
const sortReport = (report) =>
	[...report].sort(
		(a, b) =>
			a.target.localeCompare(b.target) ||
			(a.key < b.key ? -1 : a.key > b.key ? 1 : 0) ||
			LAYER_RANK[a.layer] - LAYER_RANK[b.layer] ||
			a.kind.localeCompare(b.kind) ||
			a.reason.localeCompare(b.reason),
	);

/** Keys of the resolver payload that make up its effective content. */
const CONTENT_KEYS = /** @type {const} */ ([
	'schema',
	'subscriptionId',
	'productSlug',
	'productVersion',
	'plan',
	'priceBookVersion',
	'state',
	'elements',
	'features',
	'config',
]);

/**
 * Hash of a resolved entitlement's effective content (excludes `contentHash`, `resolvedAt`, `report`).
 * The Portal compares it with the previous document's hash to decide whether to bump the integer
 * document `version`.
 * @param {Pick<EntitlementPayload, typeof CONTENT_KEYS[number]>} resolved
 * @param {(text: string) => string} [hash] Default SHA-256 hex.
 * @returns {string}
 */
export const contentHash = (resolved, hash = sha256Hex) =>
	hash(stableStringify(Object.fromEntries(CONTENT_KEYS.map((key) => [key, resolved[key]]))));
