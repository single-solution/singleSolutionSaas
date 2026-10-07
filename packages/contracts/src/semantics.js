/**
 * Semantic rules that JSON Schema cannot express: unique keys, dependencies, URLs, real timestamps and the keyword fit
 * of settings schemas. Each check is pure and returns `ValidationProblem[]` (empty when valid); it assumes the value
 * already passed its JSON Schema.
 * @module
 */
import { isPathOrServiceUrl, isPlainObject, isServiceUrl, isUtcTimestamp, pointer } from './util.js';

/** @typedef {import('./types.js').ValidationProblem} ValidationProblem */
/** @typedef {import('./types.js').Manifest} Manifest */
/** @typedef {import('./types.js').PriceList} PriceList */
/** @typedef {import('./types.js').StatusResponse} StatusResponse */
/** @typedef {import('./types.js').SettingNode} SettingNode */

/** Rule ids used as the `keyword` of semantic problems. */
export const RULES = Object.freeze({
	duplicateKey: 'duplicateKey',
	unknownDependency: 'unknownDependency',
	selfDependency: 'selfDependency',
	dependencyCycle: 'dependencyCycle',
	unknownFeature: 'unknownFeature',
	widgetScriptUrl: 'widgetScriptUrl',
	url: 'url',
	timestamp: 'timestamp',
	graceEndsAt: 'graceEndsAt',
	settingKeyword: 'settingKeyword',
	settingRange: 'settingRange',
	settingItems: 'settingItems',
	settingDefault: 'settingDefault',
	settingEnum: 'settingEnum',
	settingsSchema: 'settingsSchema',
});

/**
 * @param {ReadonlyArray<string | number>} tokens
 * @param {string} keyword
 * @param {string} message
 * @returns {ValidationProblem}
 */
export const at = (tokens, keyword, message) => Object.freeze({ path: pointer(tokens), keyword, message });

/**
 * Detect dependency cycles; returns each cycle once as a list of keys (first key repeated at the end).
 * @param {ReadonlyMap<string, ReadonlyArray<string>>} graph
 * @returns {string[][]}
 */
export const findCycles = (graph) => {
	/** @type {Map<string, 'visiting' | 'done'>} */
	const state = new Map();
	/** @type {string[][]} */
	const cycles = [];
	/** @type {string[]} */
	const stack = [];
	/** @param {string} key */
	const visit = (key) => {
		state.set(key, 'visiting');
		stack.push(key);
		for (const next of graph.get(key) ?? []) {
			if (!graph.has(next)) continue;
			const seen = state.get(next);
			if (seen === 'visiting') cycles.push([...stack.slice(stack.indexOf(next)), next]);
			else if (seen === undefined) visit(next);
		}
		stack.pop();
		state.set(key, 'done');
	};
	for (const key of graph.keys()) if (!state.has(key)) visit(key);
	return cycles;
};

/**
 * Report duplicate `key` members of a list.
 * @param {ReadonlyArray<{ key: string }>} list
 * @param {string} member list member name in the path
 * @param {string} label
 * @param {ValidationProblem[]} out
 */
const uniqueKeys = (list, member, label, out) => {
	/** @type {Set<string>} */
	const seen = new Set();
	for (const [index, entry] of list.entries()) {
		if (seen.has(entry.key))
			out.push(at([member, index, 'key'], RULES.duplicateKey, `${label} '${entry.key}' is listed twice`));
		seen.add(entry.key);
	}
};

/**
 * Dependency rules of a feature list (manifest or price list): every `dependsOn` key exists, no feature depends on
 * itself, no cycles.
 * @param {ReadonlyArray<{ key: string, dependsOn: ReadonlyArray<string> }>} features
 * @param {ValidationProblem[]} out
 */
const checkDependencies = (features, out) => {
	const keys = new Set(features.map((feature) => feature.key));
	for (const [index, feature] of features.entries()) {
		for (const [position, dependency] of feature.dependsOn.entries()) {
			const path = ['features', index, 'dependsOn', position];
			if (dependency === feature.key) out.push(at(path, RULES.selfDependency, 'a feature cannot depend on itself'));
			else if (!keys.has(dependency)) out.push(at(path, RULES.unknownDependency, `unknown feature '${dependency}'`));
		}
	}
	const graph = new Map(features.map((feature) => [feature.key, feature.dependsOn.filter((key) => key !== feature.key)]));
	for (const cycle of findCycles(graph)) {
		const index = features.findIndex((feature) => feature.key === cycle[0]);
		out.push(at(['features', index, 'dependsOn'], RULES.dependencyCycle, `dependency cycle: ${cycle.join(' → ')}`));
	}
};

/**
 * Semantic rules of a manifest (PLAN 0.4.13): unique feature, permission and widget keys; `dependsOn` keys exist with
 * no self-dependency or cycle; every permission and widget names an existing feature; `widgetScriptUrl` is null
 * exactly when there are no widgets; `endpoints.base` is an https address (http only on local hosts);
 * `endpoints.dashboard`, `docsUrl` and `widgetScriptUrl` are paths or such addresses. Settings schemas are checked
 * separately.
 * @param {Manifest} manifest
 * @returns {ValidationProblem[]}
 */
export const checkManifest = (manifest) => {
	/** @type {ValidationProblem[]} */
	const out = [];
	uniqueKeys(manifest.features, 'features', 'feature', out);
	checkDependencies(manifest.features, out);
	const features = new Set(manifest.features.map((feature) => feature.key));
	uniqueKeys(manifest.permissions, 'permissions', 'permission', out);
	uniqueKeys(manifest.widgets, 'widgets', 'widget', out);
	for (const member of /** @type {const} */ (['permissions', 'widgets'])) {
		for (const [index, entry] of manifest[member].entries()) {
			if (!features.has(entry.feature))
				out.push(at([member, index, 'feature'], RULES.unknownFeature, `unknown feature '${entry.feature}'`));
		}
	}
	if (!isServiceUrl(manifest.endpoints.base))
		out.push(at(['endpoints', 'base'], RULES.url, 'must be an https URL (http only on localhost)'));
	if (!isPathOrServiceUrl(manifest.endpoints.dashboard))
		out.push(at(['endpoints', 'dashboard'], RULES.url, 'must be a path or an https URL'));
	if (!isPathOrServiceUrl(manifest.docsUrl)) out.push(at(['docsUrl'], RULES.url, 'must be a path or an https URL'));
	if ((manifest.widgetScriptUrl === null) !== (manifest.widgets.length === 0))
		out.push(at(['widgetScriptUrl'], RULES.widgetScriptUrl, 'must be null exactly when there are no widgets'));
	else if (manifest.widgetScriptUrl !== null && !isPathOrServiceUrl(manifest.widgetScriptUrl))
		out.push(at(['widgetScriptUrl'], RULES.url, 'must be a path or an https URL'));
	return out;
};

/**
 * Price-list version 1 built from a manifest at first connect: every feature at 0 millicredits per hour.
 * @param {Manifest} manifest
 * @returns {PriceList}
 */
export const manifestPriceList = (manifest) => ({
	version: 1,
	features: manifest.features.map(({ key, name, description, dependsOn }) => ({
		key,
		name,
		description,
		dependsOn: [...dependsOn],
		millicreditsPerHour: 0,
	})),
});

/**
 * Semantic rules of a price report: unique keys, dependencies exist, no self-dependency or cycle.
 * @param {PriceList} report
 * @returns {ValidationProblem[]}
 */
export const checkPriceReport = (report) => {
	/** @type {ValidationProblem[]} */
	const out = [];
	uniqueKeys(report.features, 'features', 'feature', out);
	checkDependencies(report.features, out);
	return out;
};

/**
 * Semantic rules of a status response: real UTC timestamps; `graceEndsAt` set exactly when the status is `grace`.
 * @param {StatusResponse} status
 * @returns {ValidationProblem[]}
 */
export const checkStatusResponse = (status) => {
	/** @type {ValidationProblem[]} */
	const out = [];
	if (!isUtcTimestamp(status.validUntil)) out.push(at(['validUntil'], RULES.timestamp, 'is not a real UTC time'));
	if (status.graceEndsAt !== null && !isUtcTimestamp(status.graceEndsAt))
		out.push(at(['graceEndsAt'], RULES.timestamp, 'is not a real UTC time'));
	if ((status.status === 'grace') !== (status.graceEndsAt !== null))
		out.push(at(['graceEndsAt'], RULES.graceEndsAt, 'is set exactly while the status is grace'));
	return out;
};

/**
 * @param {import('./types.js').Directory} directory
 * @returns {ValidationProblem[]}
 */
export const checkDirectory = (directory) =>
	isServiceUrl(directory.baseUrl) ? [] : [at(['baseUrl'], RULES.url, 'must be an https URL (http only on localhost)')];

/**
 * @param {import('./types.js').ActivityCopy} copy
 * @returns {ValidationProblem[]}
 */
export const checkActivityCopy = (copy) =>
	isUtcTimestamp(copy.at) ? [] : [at(['at'], RULES.timestamp, 'is not a real UTC time')];

/** Keywords that only fit some setting types. */
const TYPE_KEYWORDS = Object.freeze({
	minimum: ['integer', 'number'],
	maximum: ['integer', 'number'],
	maxLength: ['string'],
	format: ['string'],
	enum: ['string', 'integer', 'number'],
	items: ['array'],
});

/**
 * Keyword fit and ranges of one setting or list-item node.
 * @param {SettingNode | import('./types.js').SettingItem} node
 * @param {Array<string | number>} path
 * @param {ValidationProblem[]} out
 */
const checkNode = (node, path, out) => {
	for (const [keyword, types] of Object.entries(TYPE_KEYWORDS)) {
		if (keyword in node && !types.includes(node.type))
			out.push(at([...path, keyword], RULES.settingKeyword, `'${keyword}' does not fit a ${node.type} setting`));
	}
	if (typeof node.minimum === 'number' && typeof node.maximum === 'number' && node.minimum > node.maximum)
		out.push(at([...path, 'minimum'], RULES.settingRange, 'minimum must not exceed maximum'));
	if (node.type === 'array') {
		if (!('items' in node) || node.items === undefined)
			out.push(at([...path, 'items'], RULES.settingItems, 'list settings need items'));
		else checkNode(node.items, [...path, 'items'], out);
	}
};

/**
 * Keyword fit of a settings schema that passed the settings meta-schema: `minimum`/`maximum` only on numbers,
 * `maxLength`/`format` only on strings, `enum` not on booleans or lists, `items` required on lists and only there,
 * `minimum` ≤ `maximum`. Defaults and enum values are checked by the validator.
 * @param {import('./types.js').SettingsSchema} schema
 * @param {Array<string | number>} [path] pointer tokens of the schema
 * @returns {ValidationProblem[]}
 */
export const checkSettingsRules = (schema, path = []) => {
	/** @type {ValidationProblem[]} */
	const out = [];
	for (const [key, node] of Object.entries(schema.properties)) {
		if (isPlainObject(node)) checkNode(node, [...path, 'properties', key], out);
	}
	return out;
};
