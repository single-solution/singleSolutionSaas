import { currentPriceBook, isNumericFeature, isValidFeatureValue, withinPlanMax } from './catalog.js';
import { BUCKETS, bucketOf, sha256Hex, stableStringify } from './hash.js';
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
export const LAYERS = /** @type {const} */ (['product', 'plan', 'platform', 'merchant', 'website', 'admin']);

/** @typedef {typeof LAYERS[number]} Layer */
/** @typedef {'active' | 'paused' | 'suspended' | 'cancelled' | 'spend_cap'} RuntimeState */

/**
 * Authority used by lock semantics: a lock set by layer N binds every layer of lower authority.
 * Customer layers (merchant, website) have the lowest authority; admin the highest.
 * @type {Readonly<Record<Layer, number>>}
 */
export const AUTHORITY = { website: 1, merchant: 2, product: 3, plan: 3, platform: 4, admin: 5 };

/** Layers authored by the customer: bounded by the plan and bound by locks. */
const CUSTOMER_LAYERS = new Set(['merchant', 'website']);

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
 * @typedef {object} Rollout
 * @property {string} id Rollout identity (part of the bucketing hash).
 * @property {number} [percent] 0–100 (two decimals), share of subscriptions included.
 * @property {string} [rule] Rule source evaluated with the injected `evaluateRule`; must return `true`.
 */

/**
 * @typedef {object} ExperimentVariant
 * @property {string} key
 * @property {number} weight Positive integer.
 * @property {Readonly<Record<string, unknown>>} [values] Feature values by feature name (within the element).
 */

/**
 * @typedef {object} Experiment
 * @property {string} id
 * @property {string} element
 * @property {readonly ExperimentVariant[]} variants
 */

/**
 * @typedef {object} RuntimeInput
 * @property {'active' | 'paused' | 'suspended' | 'cancelled'} [state]
 * @property {boolean} [spendCap] A spend cap is reached (see spend.js).
 * @property {Readonly<Record<string, number>>} [usage] Period-to-date usage by quota feature key.
 * @property {Readonly<Record<string, string>> | readonly { kind: string, status: string }[]} [resources] Client resource status by kind
 *   (contracts `RESOURCE_STATUSES`; only `'connected'` is usable).
 * @property {Readonly<Record<string, Rollout>>} [rollouts] Rollouts by element key.
 * @property {readonly Experiment[]} [experiments]
 * @property {Readonly<Record<string, unknown>>} [context] Extra context passed to `evaluateRule`.
 */

/** @typedef {(ruleSource: string, context: Readonly<Record<string, unknown>>) => unknown} EvaluateRule */

/**
 * @typedef {object} ReportItem
 * @property {'element' | 'feature'} target
 * @property {string} key
 * @property {Layer | 'experiment'} layer
 * @property {'ignored' | 'clamped'} kind
 * @property {string} reason `locked` | `invalid` | `unknown` | `lock_not_allowed` | `not_experimentable` | `plan_max` | `min` | `max` | `not_in_plan`
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
 *   (`cancelled` | `suspended` | `paused` | `spend_cap` | `resource_missing` | `rollout` | `dependency`).
 * @property {string[]} [missing] Resource kinds that are not connected (`resource_missing`).
 * @property {string[]} [blockedBy] Disabled dependencies (`dependency`).
 */

/**
 * @typedef {object} EffectiveFeature
 * @property {unknown} value
 * @property {Layer | 'experiment'} source
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
 * @property {Record<string, { element: string, variant: string }>} experiments
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
 * @param {Layer | 'experiment'} layer
 * @param {unknown} value
 * @param {import('./catalog.js').PlanMax | undefined} planMax
 * @returns {{ value: unknown, reason: string | null }}
 */
const clampFeature = (feature, layer, value, planMax) => {
	const customer = CUSTOMER_LAYERS.has(layer) || layer === 'experiment';
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
 * True when a customer/experiment value exceeds the plan max of a feature that cannot be clamped
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
	for (const layer of /** @type {const} */ (['platform', 'merchant', 'website', 'admin'])) {
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
 * Deterministic variant selection: `bucketOf([subscriptionId, element, experimentId])` mapped onto
 * cumulative weights of the variants sorted by key.
 * @param {{ subscriptionId: string, experiment: Experiment }} input
 * @returns {ExperimentVariant}
 */
export const selectVariant = ({ subscriptionId, experiment }) => {
	const variants = [...experiment.variants].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	if (variants.length === 0) throw resolveError('invalid_experiment', `experiment ${experiment.id} has no variants`);
	for (const v of variants) {
		if (!Number.isSafeInteger(v.weight) || v.weight <= 0)
			throw resolveError('invalid_experiment', `variant ${v.key} weight must be a positive integer`);
	}
	const total = variants.reduce((sum, v) => sum + v.weight, 0);
	const bucket = bucketOf([subscriptionId, experiment.element, experiment.id]);
	let cumulative = 0;
	for (const variant of variants) {
		cumulative += variant.weight;
		if (bucket < Math.floor((cumulative * BUCKETS) / total)) return variant;
	}
	/* c8 ignore next */
	return /** @type {ExperimentVariant} */ (variants.at(-1));
};

/**
 * Whether a subscription is inside a rollout audience. Percent uses
 * `bucketOf([subscriptionId, element, rollout.id]) < round(percent × 100)`; a rule must evaluate to
 * exactly `true`. Missing evaluator or evaluation errors fail closed.
 * @param {{ subscriptionId: string, element: string, rollout: Rollout, evaluateRule?: EvaluateRule, context: Readonly<Record<string, unknown>> }} input
 * @returns {boolean}
 */
export const inRollout = ({ subscriptionId, element, rollout, evaluateRule, context }) => {
	if (rollout.percent !== undefined) {
		const threshold = Math.round(Math.min(100, Math.max(0, rollout.percent)) * 100);
		if (bucketOf([subscriptionId, element, rollout.id]) >= threshold) return false;
	}
	if (rollout.rule !== undefined) {
		if (!evaluateRule) return false;
		try {
			return evaluateRule(rollout.rule, context) === true;
		} catch {
			return false;
		}
	}
	return true;
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
 * @param {Readonly<Partial<Record<'platform' | 'merchant' | 'website' | 'admin', LayerInput>>>} [input.layers]
 * @param {RuntimeInput} [input.runtime]
 * @param {Instant} input.now
 * @param {EvaluateRule} [input.evaluateRule] Injected rule evaluator (e.g. from `@ss/rules`).
 * @param {(text: string) => string} [input.hash] Hasher for `contentHash` (default SHA-256 hex).
 * @returns {EntitlementPayload}
 */
export const resolveEntitlement = ({ product, subscription, layers = {}, runtime = {}, now, evaluateRule, hash = sha256Hex }) => {
	const nowMs = toMs(now, 'now');
	const planCode = subscription.plan ?? null;
	const plan = planCode === null ? null : (product.plans[planCode] ?? null);
	if (planCode !== null && plan === null)
		throw resolveError('unknown_plan', `subscription plan ${planCode} is not defined by ${product.slug}`);
	/** @type {ReportItem[]} */
	const report = [];

	for (const layer of /** @type {const} */ (['platform', 'merchant', 'website', 'admin'])) {
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

	// 2. Runtime state, resources, rollouts, then dependency cascade (topological order).
	const state = runtimeState(subscription, runtime);
	/** @type {Record<string, string>} */
	const resourceStatus = Array.isArray(runtime.resources)
		? Object.fromEntries(runtime.resources.map((r) => [r.kind, r.status]))
		: { ...(runtime.resources ?? {}) };
	const context = {
		...(runtime.context ?? {}),
		subscriptionId: subscription.id,
		websiteId: subscription.websiteId ?? null,
		merchantId: subscription.merchantId ?? null,
		plan: planCode,
		now: isoInstant(nowMs),
	};
	for (const key of product.elementOrder) {
		const current = /** @type {EffectiveElement} */ (elements[key]);
		if (!current.enabled) continue;
		const el = /** @type {ElementDef} */ (product.elements[key]);
		const missing = el.requires.filter((kind) => resourceStatus[kind] !== 'connected');
		const rollout = runtime.rollouts?.[key];
		const blockedBy = el.dependsOn.filter((dep) => elements[dep]?.enabled !== true);
		if (state !== 'active') elements[key] = { ...current, enabled: false, reason: state };
		else if (missing.length > 0) elements[key] = { ...current, enabled: false, reason: 'resource_missing', missing };
		else if (
			rollout &&
			!inRollout({
				subscriptionId: subscription.id,
				element: key,
				rollout,
				evaluateRule,
				context: { ...context, element: key },
			})
		) {
			elements[key] = { ...current, enabled: false, reason: 'rollout' };
		} else if (blockedBy.length > 0) elements[key] = { ...current, enabled: false, reason: 'dependency', blockedBy };
	}

	// 3. Features (layers + locks + clamping), experiments, quota hard stops.
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

	/** @type {Record<string, { element: string, variant: string }>} */
	const experiments = {};
	const sortedExperiments = [...(runtime.experiments ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	for (const experiment of sortedExperiments) {
		if (!product.elements[experiment.element])
			throw resolveError('invalid_experiment', `experiment ${experiment.id} targets unknown element ${experiment.element}`);
		if (experiments[experiment.id]) throw resolveError('invalid_experiment', `duplicate experiment id ${experiment.id}`);
		if (Object.values(experiments).some((e) => e.element === experiment.element)) {
			throw resolveError('invalid_experiment', `element ${experiment.element} already has a running experiment`);
		}
		const variant = selectVariant({ subscriptionId: subscription.id, experiment });
		experiments[experiment.id] = { element: experiment.element, variant: variant.key };
		for (const [name, value] of Object.entries(variant.values ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
			const key = `${experiment.element}.${name}`;
			const feature = product.features[key];
			const current = features[key];
			if (!feature || !current) {
				report.push({ target: 'feature', key, layer: 'experiment', kind: 'ignored', reason: 'unknown' });
			} else if (!feature.experiment) {
				report.push({
					target: 'feature',
					key,
					layer: 'experiment',
					kind: 'ignored',
					reason: 'not_experimentable',
					attempted: value,
				});
			} else if (current.locked) {
				report.push({
					target: 'feature',
					key,
					layer: 'experiment',
					kind: 'ignored',
					reason: 'locked',
					attempted: value,
					lockedBy: current.lockedBy ?? undefined,
				});
			} else if (!isValidFeatureValue(feature, value)) {
				report.push({ target: 'feature', key, layer: 'experiment', kind: 'ignored', reason: 'invalid', attempted: value });
			} else if (exceedsUnclampable(feature, value, plan?.max[key])) {
				report.push({ target: 'feature', key, layer: 'experiment', kind: 'ignored', reason: 'plan_max', attempted: value });
			} else {
				const clamped = clampFeature(feature, 'experiment', value, plan?.max[key]);
				if (clamped.reason) {
					report.push({
						target: 'feature',
						key,
						layer: 'experiment',
						kind: 'clamped',
						reason: clamped.reason,
						attempted: value,
						applied: clamped.value,
					});
				}
				features[key] = { ...current, value: clamped.value, source: 'experiment', reason: clamped.reason ? 'clamped' : null };
			}
		}
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
		experiments: sortKeys(experiments),
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

const LAYER_RANK = { product: 0, plan: 1, platform: 2, merchant: 3, website: 4, admin: 5, experiment: 6 };

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
	'experiments',
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
