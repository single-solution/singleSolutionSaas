/**
 * Layer state and change operations. A layer state is exactly the `LayerInput` shape `@ss/entitlements`
 * `resolveEntitlement` reads: `{ elements: { key: { enabled, locked? } }, features: { 'element.name': { value, locked? } } }`.
 * Pure; inputs are never mutated.
 * @module
 */

/** @typedef {import('./targets.js').FieldError} FieldError */

/**
 * @typedef {{ enabled: boolean, locked?: true }} ElementEntry
 * @typedef {{ value: unknown, locked?: true }} FeatureEntry
 * @typedef {{ elements: Record<string, ElementEntry>, features: Record<string, FeatureEntry> }} LayerState
 */

/**
 * A change to one layer (all parts optional):
 * - `elements`: `{ key: boolean | { enabled, locked? } | null }` (null removes the override)
 * - `features`: `{ 'element.name': { value, locked? } | null }`
 * - `config`: `{ element: { name: value } }` — element config objects, expanded to feature values
 * - `locks`: `{ elements?: { key: boolean }, features?: { key: boolean } }` — lock/unlock existing entries
 * @typedef {object} ChangeOps
 * @property {Record<string, boolean | { enabled: boolean, locked?: boolean } | null>} [elements]
 * @property {Record<string, { value: unknown, locked?: boolean } | null>} [features]
 * @property {Record<string, Record<string, unknown>>} [config]
 * @property {{ elements?: Record<string, boolean>, features?: Record<string, boolean> }} [locks]
 */

export const OPS_KEYS = Object.freeze(['elements', 'features', 'config', 'locks']);
const KEY = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const MAX_ENTRIES = 500;

/** @param {unknown} value */
export const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** @returns {LayerState} */
export const emptyState = () => ({ elements: {}, features: {} });

/**
 * Deep-copied, normalised state (unknown fields dropped, `locked` only when true).
 * @param {unknown} input
 * @returns {LayerState}
 */
export const normaliseState = (input) => {
	const raw = isRecord(input) ? /** @type {Record<string, unknown>} */ (input) : {};
	/** @type {LayerState} */
	const out = emptyState();
	const elements = isRecord(raw.elements) ? /** @type {Record<string, any>} */ (raw.elements) : {};
	for (const [key, entry] of Object.entries(elements)) {
		if (!isRecord(entry) || typeof entry.enabled !== 'boolean') continue;
		out.elements[key] = { enabled: entry.enabled, ...(entry.locked === true ? { locked: true } : {}) };
	}
	const features = isRecord(raw.features) ? /** @type {Record<string, any>} */ (raw.features) : {};
	for (const [key, entry] of Object.entries(features)) {
		if (!isRecord(entry) || !Object.hasOwn(entry, 'value')) continue;
		out.features[key] = { value: structuredClone(entry.value), ...(entry.locked === true ? { locked: true } : {}) };
	}
	return out;
};

/**
 * Storage encoding: feature keys contain dots, so entries are stored as sorted arrays.
 * @param {LayerState} state
 */
export const encodeState = (state) => ({
	elements: Object.keys(state.elements)
		.sort()
		.map((key) => ({ key, .../** @type {ElementEntry} */ (state.elements[key]) })),
	features: Object.keys(state.features)
		.sort()
		.map((key) => ({ key, .../** @type {FeatureEntry} */ (state.features[key]) })),
});

/**
 * @param {unknown} stored
 * @returns {LayerState}
 */
export const decodeState = (stored) => {
	const raw = isRecord(stored) ? /** @type {Record<string, unknown>} */ (stored) : {};
	/** @param {unknown} list */
	const toRecord = (list) =>
		Object.fromEntries(
			(Array.isArray(list) ? list : [])
				.filter((item) => isRecord(item) && typeof item.key === 'string')
				.map(({ key, ...rest }) => [key, rest]),
		);
	return normaliseState({ elements: toRecord(raw.elements), features: toRecord(raw.features) });
};

/**
 * Parse and apply change operations to a state.
 * @param {LayerState} state
 * @param {unknown} ops
 * @returns {{ ok: true, next: LayerState } | { ok: false, errors: FieldError[] }}
 */
export const applyOps = (state, ops) => {
	/** @type {FieldError[]} */
	const errors = [];
	/**
	 * @param {string} path
	 * @param {string} message
	 * @param {string} [code]
	 */
	const fail = (path, message, code = 'invalid_change') => errors.push({ path, message, code });
	if (!isRecord(ops)) return { ok: false, errors: [{ path: '', message: 'change must be an object', code: 'invalid_change' }] };
	const input = /** @type {Record<string, unknown>} */ (ops);
	for (const key of Object.keys(input)) if (!OPS_KEYS.includes(key)) fail(`/${key}`, 'unknown property');
	const next = normaliseState(state);
	let count = 0;
	/** @param {string} path @param {string} key */
	const checkKey = (path, key) => {
		count += 1;
		if (!KEY.test(key)) {
			fail(path, 'invalid key');
			return false;
		}
		return true;
	};
	/**
	 * @param {string} path
	 * @param {unknown} locked
	 * @returns {boolean | undefined}
	 */
	const lockFlag = (path, locked) => {
		if (locked === undefined) return undefined;
		if (typeof locked !== 'boolean') fail(`${path}/locked`, 'locked must be a boolean');
		return locked === true;
	};
	/**
	 * @template {object} T
	 * @param {T} entry
	 * @param {boolean | undefined} flag
	 * @param {boolean} previous
	 * @returns {T & { locked?: true }}
	 */
	const withLock = (entry, flag, previous) => ((flag ?? previous) ? { ...entry, locked: /** @type {true} */ (true) } : entry);

	if (input.elements !== undefined) {
		if (!isRecord(input.elements)) fail('/elements', 'elements must be an object');
		else
			for (const [key, raw] of Object.entries(/** @type {Record<string, unknown>} */ (input.elements))) {
				const path = `/elements/${key}`;
				if (!checkKey(path, key)) continue;
				if (raw === null) {
					delete next.elements[key];
					continue;
				}
				const previous = next.elements[key]?.locked === true;
				if (typeof raw === 'boolean') {
					next.elements[key] = withLock({ enabled: raw }, undefined, previous);
					continue;
				}
				if (!isRecord(raw)) {
					fail(path, 'element override must be a boolean, { enabled, locked? } or null');
					continue;
				}
				const entry = /** @type {Record<string, unknown>} */ (raw);
				for (const extra of Object.keys(entry))
					if (extra !== 'enabled' && extra !== 'locked') fail(`${path}/${extra}`, 'unknown property');
				if (typeof entry.enabled !== 'boolean') {
					fail(`${path}/enabled`, 'enabled must be a boolean');
					continue;
				}
				next.elements[key] = withLock({ enabled: entry.enabled }, lockFlag(path, entry.locked), previous);
			}
	}

	/**
	 * @param {string} key
	 * @param {unknown} value
	 * @param {boolean | undefined} flag
	 */
	const setFeature = (key, value, flag) => {
		const previous = next.features[key]?.locked === true;
		next.features[key] = withLock({ value: structuredClone(value) }, flag, previous);
	};

	if (input.features !== undefined) {
		if (!isRecord(input.features)) fail('/features', 'features must be an object');
		else
			for (const [key, raw] of Object.entries(/** @type {Record<string, unknown>} */ (input.features))) {
				const path = `/features/${key}`;
				if (!checkKey(path, key)) continue;
				if (raw === null) {
					delete next.features[key];
					continue;
				}
				if (!isRecord(raw) || !Object.hasOwn(/** @type {object} */ (raw), 'value')) {
					fail(path, 'feature override must be { value, locked? } or null');
					continue;
				}
				const entry = /** @type {Record<string, unknown>} */ (raw);
				for (const extra of Object.keys(entry))
					if (extra !== 'value' && extra !== 'locked') fail(`${path}/${extra}`, 'unknown property');
				if (entry.value === undefined) {
					fail(`${path}/value`, 'value is required');
					continue;
				}
				setFeature(key, entry.value, lockFlag(path, entry.locked));
			}
	}

	if (input.config !== undefined) {
		if (!isRecord(input.config)) fail('/config', 'config must be an object of element config objects');
		else
			for (const [element, values] of Object.entries(/** @type {Record<string, unknown>} */ (input.config))) {
				const path = `/config/${element}`;
				if (!checkKey(path, element)) continue;
				if (element.includes('.')) {
					fail(path, 'element keys cannot contain dots');
					continue;
				}
				if (!isRecord(values)) {
					fail(path, 'element config must be an object');
					continue;
				}
				for (const [name, value] of Object.entries(/** @type {Record<string, unknown>} */ (values))) {
					if (!checkKey(`${path}/${name}`, name)) continue;
					if (value === undefined) fail(`${path}/${name}`, 'value is required');
					else setFeature(`${element}.${name}`, value, undefined);
				}
			}
	}

	if (input.locks !== undefined) {
		if (!isRecord(input.locks)) fail('/locks', 'locks must be an object');
		else {
			const locks = /** @type {Record<string, unknown>} */ (input.locks);
			for (const key of Object.keys(locks))
				if (key !== 'elements' && key !== 'features') fail(`/locks/${key}`, 'unknown property');
			for (const kind of /** @type {const} */ (['elements', 'features'])) {
				const group = locks[kind];
				if (group === undefined) continue;
				if (!isRecord(group)) {
					fail(`/locks/${kind}`, `${kind} must be an object of booleans`);
					continue;
				}
				for (const [key, flag] of Object.entries(/** @type {Record<string, unknown>} */ (group))) {
					const path = `/locks/${kind}/${key}`;
					if (!checkKey(path, key)) continue;
					if (typeof flag !== 'boolean') {
						fail(path, 'lock must be a boolean');
						continue;
					}
					const table = /** @type {Record<string, { locked?: true }>} */ (next[kind]);
					const entry = table[key];
					if (!entry) {
						fail(path, 'a lock needs a value at this level: set the override first', 'lock_without_value');
						continue;
					}
					const { locked: _drop, ...rest } = entry;
					void _drop;
					table[key] = flag ? { ...rest, locked: true } : rest;
				}
			}
		}
	}
	if (count > MAX_ENTRIES) fail('', `a change may touch at most ${MAX_ENTRIES} entries`);
	return errors.length > 0 ? { ok: false, errors } : { ok: true, next };
};

/**
 * `LayerInput` for `@ss/entitlements` (`locked` only when true; deep copies).
 * @param {LayerState} state
 */
export const toLayerInput = (state) => normaliseState(state);
