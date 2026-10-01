/**
 * Experiment definitions (PLAN Part D L8): A/B variants of an element's config with a traffic split and a success
 * metric. Pure validation and the mapping to `@ss/entitlements` `runtime.experiments`.
 * @module
 */
import { featureNode, featureValueProblem } from './validate.js';
import { isRecord } from './state.js';

/** @typedef {import('./targets.js').FieldError} FieldError */
/** @typedef {import('./validate.js').ManifestIndex} ManifestIndex */
/** @typedef {import('./validate.js').FeatureValidator} FeatureValidator */

export const EXPERIMENT_STATUSES = Object.freeze(['draft', 'running', 'stopped']);
export const MAX_VARIANTS = 10;
const VARIANT_KEY = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const EVENT_TYPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+(@[1-9][0-9]*)?$/;

/**
 * @typedef {object} ExperimentInput
 * @property {string} element
 * @property {Array<{ key: string, weight: number, config: Record<string, unknown> }>} variants
 * @property {string} metric event type whose occurrence counts as success (e.g. `order.placed@1`)
 * @property {string} [name]
 */

/**
 * Validate an experiment definition against the manifest.
 * @param {{ index: ManifestIndex, input: unknown, validateFeatureConfig: FeatureValidator }} args
 * @returns {{ ok: true, value: ExperimentInput } | { ok: false, errors: FieldError[] }}
 */
export const validateExperiment = ({ index, input, validateFeatureConfig }) => {
	/** @type {FieldError[]} */
	const errors = [];
	/**
	 * @param {string} path
	 * @param {string} message
	 * @param {string} [code]
	 */
	const fail = (path, message, code = 'invalid_experiment') => errors.push({ path, message, code });
	if (!isRecord(input))
		return { ok: false, errors: [{ path: '', message: 'experiment must be an object', code: 'invalid_experiment' }] };
	const raw = /** @type {Record<string, unknown>} */ (input);
	for (const key of Object.keys(raw))
		if (!['element', 'variants', 'metric', 'name'].includes(key)) fail(`/${key}`, 'unknown property');
	const element = typeof raw.element === 'string' ? index.elements.get(raw.element) : undefined;
	if (!element) fail('/element', 'element does not exist', 'unknown_element');
	else if (!element.experiments) fail('/element', 'this element does not allow experiments', 'not_experimentable');
	if (typeof raw.metric !== 'string' || !EVENT_TYPE.test(raw.metric))
		fail('/metric', 'metric must be an event type such as order.placed@1');
	if (raw.name !== undefined && (typeof raw.name !== 'string' || raw.name.length === 0 || raw.name.length > 120))
		fail('/name', 'name must be 1..120 characters');
	const variants = Array.isArray(raw.variants) ? raw.variants : null;
	if (!variants || variants.length < 2 || variants.length > MAX_VARIANTS) {
		fail('/variants', `variants must be an array of 2..${MAX_VARIANTS} variants`);
	} else {
		const seen = new Set();
		variants.forEach((variant, i) => {
			const path = `/variants/${i}`;
			if (!isRecord(variant)) {
				fail(path, 'variant must be an object');
				return;
			}
			const v = /** @type {Record<string, unknown>} */ (variant);
			for (const key of Object.keys(v))
				if (!['key', 'weight', 'config'].includes(key)) fail(`${path}/${key}`, 'unknown property');
			if (typeof v.key !== 'string' || !VARIANT_KEY.test(v.key))
				fail(`${path}/key`, 'key must match [a-z0-9][a-z0-9_-]{0,31}');
			else if (seen.has(v.key)) fail(`${path}/key`, 'duplicate variant key');
			else seen.add(v.key);
			if (!Number.isInteger(v.weight) || /** @type {number} */ (v.weight) < 1 || /** @type {number} */ (v.weight) > 10_000)
				fail(`${path}/weight`, 'weight must be an integer 1..10000');
			const config = v.config ?? {};
			if (!isRecord(config)) {
				fail(`${path}/config`, 'config must be an object of feature values');
				return;
			}
			if (!element || typeof raw.element !== 'string') return;
			for (const [name, value] of Object.entries(/** @type {Record<string, unknown>} */ (config))) {
				const found = featureNode(index, `${raw.element}.${name}`);
				if (!found.ok) {
					fail(`${path}/config/${name}`, found.message, found.code);
					continue;
				}
				if (found.node['x-experiment'] !== true) {
					fail(`${path}/config/${name}`, 'this feature cannot vary in experiments (x-experiment)', 'not_experimentable');
					continue;
				}
				const problem = featureValueProblem(found, value, validateFeatureConfig);
				if (problem !== null) fail(`${path}/config/${name}`, problem, 'invalid_value');
			}
		});
	}
	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		value: {
			element: /** @type {string} */ (raw.element),
			metric: /** @type {string} */ (raw.metric),
			...(raw.name === undefined ? {} : { name: /** @type {string} */ (raw.name) }),
			variants: /** @type {any[]} */ (variants).map((v) => ({
				key: v.key,
				weight: v.weight,
				config: structuredClone(v.config ?? {}),
			})),
		},
	};
};

/**
 * `@ss/entitlements` `runtime.experiments[]` entry of a stored experiment.
 * @param {{ experimentId: string, element: string, variants: ReadonlyArray<{ key: string, weight: number, config: Record<string, unknown> }> }} experiment
 * @returns {{ id: string, element: string, variants: Array<{ key: string, weight: number, values: Record<string, unknown> }> }}
 */
export const toRuntimeExperiment = (experiment) => ({
	id: experiment.experimentId,
	element: experiment.element,
	variants: experiment.variants.map((v) => ({ key: v.key, weight: v.weight, values: structuredClone(v.config) })),
});
