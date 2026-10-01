/**
 * Validation of layer entries against a product manifest: keys must exist, element values are booleans, feature
 * values satisfy the feature schema's absolute bounds (`@ss/contracts` `validateFeatureConfig`), and locks are only
 * accepted on lockable features (`x-lock` not `false`). Plan maxima are NOT checked here: precedence and clamping
 * belong to `@ss/entitlements` (commerce). Pure.
 * @module
 */

/** @typedef {import('./targets.js').FieldError} FieldError */
/** @typedef {import('./state.js').LayerState} LayerState */
/** @typedef {import('@ss/contracts').Manifest} Manifest */
/** @typedef {import('@ss/contracts').FeatureSchema} FeatureSchema */
/** @typedef {import('@ss/contracts').FeatureNode} FeatureNode */
/**
 * @typedef {(schema: FeatureSchema, value: unknown) => { ok: boolean, problems?: ReadonlyArray<{ path: string, message: string }> }} FeatureValidator
 */

/** Kinds where `null` means unlimited (an `@ss/entitlements` extension the JSON Schema does not express). */
const UNLIMITED_KINDS = new Set(['quota', 'limit', 'rate']);

/**
 * @typedef {object} ManifestIndex
 * @property {string} version
 * @property {Map<string, { experiments: boolean, schema: FeatureSchema | null }>} elements
 */

/**
 * @param {Manifest} manifest
 * @returns {ManifestIndex}
 */
export const indexManifest = (manifest) => ({
	version: manifest.product.version,
	elements: new Map(
		manifest.elements.map((element) => [
			element.key,
			{ experiments: element.experiments === true, schema: element.features ?? null },
		]),
	),
});

/**
 * Split `<element>.<featurePath>` (element keys contain no dots).
 * @param {string} key
 * @returns {{ element: string, name: string } | null}
 */
export const splitFeatureKey = (key) => {
	const dot = key.indexOf('.');
	if (dot <= 0 || dot === key.length - 1) return null;
	return { element: key.slice(0, dot), name: key.slice(dot + 1) };
};

/**
 * Feature node of a key, or an error code.
 * @param {ManifestIndex} index
 * @param {string} key
 * @returns {{ ok: true, schema: FeatureSchema, node: FeatureNode, element: string, name: string } | { ok: false, code: string, message: string }}
 */
export const featureNode = (index, key) => {
	const parts = splitFeatureKey(key);
	if (!parts) return { ok: false, code: 'unknown_feature', message: 'feature keys are <element>.<feature>' };
	const element = index.elements.get(parts.element);
	if (!element) return { ok: false, code: 'unknown_element', message: `element ${parts.element} does not exist` };
	const node =
		element.schema && Object.hasOwn(element.schema.properties, parts.name) ? element.schema.properties[parts.name] : undefined;
	if (!element.schema || !node)
		return { ok: false, code: 'unknown_feature', message: `feature ${parts.name} does not exist on ${parts.element}` };
	return { ok: true, schema: element.schema, node, ...parts };
};

/**
 * Validate one feature value against the element's feature schema (absolute bounds only).
 * @param {{ schema: FeatureSchema, node: FeatureNode, name: string }} feature
 * @param {unknown} value
 * @param {FeatureValidator} validateFeatureConfig
 * @returns {string | null} message, or null when valid
 */
export const featureValueProblem = ({ schema, node, name }, value, validateFeatureConfig) => {
	if (value === null && UNLIMITED_KINDS.has(String(node['x-kind']))) return null;
	const defaults = Object.fromEntries(Object.entries(schema.properties).map(([key, n]) => [key, n.default]));
	const result = validateFeatureConfig(schema, { ...defaults, [name]: value });
	if (result.ok) return null;
	const mine = (result.problems ?? []).filter((p) => p.path === `/${name}` || p.path.startsWith(`/${name}/`));
	const first = mine[0] ?? (result.problems ?? [])[0];
	return first ? `${first.path.slice(name.length + 1) || ''} ${first.message}`.trim() : 'invalid value';
};

/**
 * Validate the entries of `state` named in `keys` against the manifest.
 * @param {object} input
 * @param {ManifestIndex} input.index
 * @param {LayerState} input.state
 * @param {{ elements: readonly string[], features: readonly string[] }} input.keys
 * @param {FeatureValidator} input.validateFeatureConfig
 * @returns {FieldError[]}
 */
export const validateEntries = ({ index, state, keys, validateFeatureConfig }) => {
	/** @type {FieldError[]} */
	const errors = [];
	for (const key of keys.elements) {
		const entry = state.elements[key];
		if (!entry) continue;
		if (!index.elements.has(key))
			errors.push({ path: `/elements/${key}`, message: `element ${key} does not exist`, code: 'unknown_element' });
	}
	for (const key of keys.features) {
		const entry = state.features[key];
		if (!entry) continue;
		const found = featureNode(index, key);
		if (!found.ok) {
			errors.push({ path: `/features/${key}`, message: found.message, code: found.code });
			continue;
		}
		const problem = featureValueProblem(found, entry.value, validateFeatureConfig);
		if (problem !== null) errors.push({ path: `/features/${key}`, message: problem, code: 'invalid_value' });
		if (entry.locked === true && found.node['x-lock'] === false)
			errors.push({
				path: `/features/${key}/locked`,
				message: 'this feature is not lockable (x-lock: false)',
				code: 'not_lockable',
			});
	}
	return errors;
};
