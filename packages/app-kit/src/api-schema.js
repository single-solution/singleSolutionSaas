/**
 * The small JSON Schema subset of API descriptions (`schemas/api.json` of a product, `kit-api.json` of the kit): what
 * a request or an answer may hold. Build-time and test-time only: `ss app validate` checks the schemas themselves
 * (`schemaProblems`) and the products' tests check every answer against them (`validateValue`); no request in
 * production is validated with it.
 *
 * Keywords: `type` (one or a list, e.g. `["string", "null"]`), `properties`, `required`, `additionalProperties`,
 * `items`, `minItems`, `maxItems`, `maxProperties`, `propertyNames`, `enum`, `const`, `minimum`, `maximum`,
 * `minLength`, `maxLength`, `pattern`, `format` (`date-time`, `date`, `uri` and `email` are checked; others are notes),
 * `oneOf`, `anyOf` and `$ref` to `#/components/schemas/<Name>`, plus the notes `title`, `description`, `default` and
 * `examples`.
 * @module
 */
import { isDeepStrictEqual } from 'node:util';
import { isObject } from './util.js';

/**
 * @typedef {{ [keyword: string]: unknown }} Schema
 * @typedef {Readonly<Record<string, Schema>>} NamedSchemas shared schemas by name (`#/components/schemas/<Name>`)
 * @typedef {{ path: string, message: string }} SchemaProblem `path`: JSON Pointer into the value or the schema
 */

/** Types of the subset. */
const TYPES = Object.freeze(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
/** Keywords whose value is a schema. */
const SCHEMA_KEYWORDS = Object.freeze(['items', 'propertyNames']);
/** Keywords whose value is a whole number of at least 0. */
const COUNT_KEYWORDS = Object.freeze(['minLength', 'maxLength', 'minItems', 'maxItems', 'maxProperties']);
/** Keywords that only describe. */
const NOTE_KEYWORDS = Object.freeze(['title', 'description', 'default', 'examples', 'format']);
/** Every keyword of the subset. */
const SCHEMA_SUBSET = Object.freeze([
	'type',
	'properties',
	'required',
	'additionalProperties',
	'enum',
	'const',
	'minimum',
	'maximum',
	'pattern',
	'oneOf',
	'anyOf',
	'$ref',
	...SCHEMA_KEYWORDS,
	...COUNT_KEYWORDS,
	...NOTE_KEYWORDS,
]);
/** A shared schema reference; the name is group 1. */
export const SCHEMA_REF = /^#\/components\/schemas\/([A-Za-z][A-Za-z0-9_.-]{0,63})$/;
/** Nesting deeper than this (references included) is refused. */
const MAX_DEPTH = 64;

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** @param {string} token */
const escapeToken = (token) => token.replace(/~/g, '~0').replace(/\//g, '~1');

/** @param {unknown} value */
const isCount = (value) => Number.isInteger(value) && /** @type {number} */ (value) >= 0;

/**
 * The regular expression of a `pattern`, or null when it does not compile.
 * @param {unknown} pattern
 * @returns {RegExp | null}
 */
const regexOf = (pattern) => {
	if (typeof pattern !== 'string') return null;
	try {
		return new RegExp(pattern, 'u');
	} catch {
		return null;
	}
};

/**
 * What is wrong with a schema of the subset: unknown keywords, keyword values of the wrong kind, patterns that do not
 * compile and references to shared schemas that do not exist.
 * @param {unknown} schema
 * @param {{ schemas?: NamedSchemas, at?: string }} [options] `schemas`: the shared schemas references may name; `at`:
 *   the schema's own pointer (prefixed to every problem)
 * @returns {SchemaProblem[]}
 */
export const schemaProblems = (schema, { schemas = {}, at = '' } = {}) => {
	/** @type {SchemaProblem[]} */
	const out = [];
	/** @param {unknown} node @param {string} path @param {number} depth */
	const visit = (node, path, depth) => {
		/** @param {string} message @param {string} [where] */
		const fail = (message, where = path) => void out.push({ path: where, message });
		if (depth > MAX_DEPTH) return fail('nests too deeply');
		if (!isObject(node)) return fail('a schema is a JSON object');
		for (const [keyword, value] of Object.entries(node)) {
			const where = `${path}/${escapeToken(keyword)}`;
			if (!SCHEMA_SUBSET.includes(keyword))
				fail(`'${keyword}' is not a keyword of the subset (${SCHEMA_SUBSET.join(', ')})`, where);
			else if (keyword === 'type') {
				const list = [value].flat();
				if (list.length === 0 || new Set(list).size !== list.length || list.some((type) => !TYPES.includes(String(type))))
					fail(`type is one of ${TYPES.join(', ')}, or a list of them`, where);
			} else if (keyword === 'properties') {
				if (!isObject(value)) fail('properties maps names to schemas', where);
				else for (const [name, child] of Object.entries(value)) visit(child, `${where}/${escapeToken(name)}`, depth + 1);
			} else if (keyword === 'required') {
				const names = Array.isArray(value) ? value : [];
				if (!Array.isArray(value) || names.some((name) => typeof name !== 'string') || new Set(names).size !== names.length)
					fail('required lists property names once each', where);
				else if (isObject(node.properties)) {
					const known = /** @type {Record<string, unknown>} */ (node.properties);
					for (const name of names)
						if (!Object.hasOwn(known, name)) fail(`required names '${name}', which is not in properties`, where);
				}
			} else if (keyword === 'additionalProperties') {
				if (typeof value !== 'boolean') visit(value, where, depth + 1);
			} else if (SCHEMA_KEYWORDS.includes(keyword)) visit(value, where, depth + 1);
			else if (keyword === 'oneOf' || keyword === 'anyOf') {
				if (!Array.isArray(value) || value.length === 0) fail(`${keyword} lists schemas`, where);
				else value.forEach((child, index) => visit(child, `${where}/${index}`, depth + 1));
			} else if (keyword === 'enum') {
				if (!Array.isArray(value) || value.length === 0) fail('enum lists the allowed values', where);
			} else if (keyword === 'minimum' || keyword === 'maximum') {
				if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${keyword} is a number`, where);
			} else if (COUNT_KEYWORDS.includes(keyword)) {
				if (!isCount(value)) fail(`${keyword} is a whole number of at least 0`, where);
			} else if (keyword === 'pattern') {
				if (regexOf(value) === null) fail('pattern is a regular expression (Unicode mode)', where);
			} else if (keyword === '$ref') {
				const name = typeof value === 'string' ? SCHEMA_REF.exec(value)?.[1] : undefined;
				if (name === undefined) fail('$ref is #/components/schemas/<Name>', where);
				else if (!Object.hasOwn(schemas, name)) fail(`$ref names the shared schema '${name}', which does not exist`, where);
			} else if (['title', 'description', 'format'].includes(keyword) && typeof value !== 'string')
				fail(`${keyword} is a text`, where);
			else if (keyword === 'examples' && !Array.isArray(value)) fail('examples is a list', where);
		}
		return undefined;
	};
	visit(schema, at, 0);
	return out;
};

/**
 * The JSON type of a value as the subset names it (`integer` for whole numbers).
 * @param {unknown} value
 * @returns {string}
 */
const typeOf = (value) => {
	if (value === null) return 'null';
	if (Array.isArray(value)) return 'array';
	if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
	return typeof value;
};

/**
 * Whether a value has one of the types.
 * @param {unknown} value
 * @param {unknown[]} types
 */
const hasType = (value, types) => {
	const actual = typeOf(value);
	return types.includes(actual) || (actual === 'integer' && types.includes('number'));
};

/**
 * Why a text breaks its `format`, or null (formats other than `date-time`, `date`, `uri` and `email` are notes).
 * @param {string} format
 * @param {string} text
 * @returns {string | null}
 */
const formatViolation = (format, text) => {
	if (format === 'date-time')
		return DATE_TIME.test(text) && !Number.isNaN(Date.parse(text)) ? null : 'must be a date-time (ISO 8601 with a zone)';
	if (format === 'date') return DATE.test(text) && !Number.isNaN(Date.parse(text)) ? null : 'must be a date (YYYY-MM-DD)';
	if (format === 'uri') return URL.canParse(text) ? null : 'must be an absolute address (URI)';
	if (format === 'email') return EMAIL.test(text) ? null : 'must be an email address';
	return null;
};

/** @param {unknown} value */
const show = (value) => JSON.stringify(value);

/**
 * What is wrong with a value against a schema of the subset (an empty list when it fits). The schema is trusted: check
 * it with {@link schemaProblems} first.
 * @param {unknown} schema
 * @param {unknown} value
 * @param {{ schemas?: NamedSchemas }} [options] the shared schemas `$ref`s name
 * @returns {SchemaProblem[]}
 */
export const validateValue = (schema, value, { schemas = {} } = {}) => {
	/**
	 * Whether a value has the type a schema (or the shared schema it names) declares.
	 * @param {unknown} node
	 * @param {unknown} data
	 */
	const typeFits = (node, data) => {
		const name = isObject(node) && typeof node.$ref === 'string' ? (SCHEMA_REF.exec(node.$ref)?.[1] ?? '') : null;
		const target = name !== null && Object.hasOwn(schemas, name) ? schemas[name] : node;
		return !isObject(target) || target.type === undefined || hasType(data, [target.type].flat());
	};
	/**
	 * @param {unknown} node
	 * @param {unknown} data
	 * @param {string} path
	 * @param {number} depth
	 * @returns {SchemaProblem[]}
	 */
	const check = (node, data, path, depth) => {
		if (depth > MAX_DEPTH) return [{ path, message: 'nests too deeply' }];
		if (!isObject(node)) return [];
		/** @type {SchemaProblem[]} */
		const out = [];
		/** @param {string} message @param {string} [where] */
		const fail = (message, where = path) => void out.push({ path: where, message });
		if (typeof node.$ref === 'string') {
			const name = SCHEMA_REF.exec(node.$ref)?.[1] ?? '';
			out.push(...check(Object.hasOwn(schemas, name) ? schemas[name] : undefined, data, path, depth + 1));
		}
		if (node.type !== undefined) {
			const types = [node.type].flat();
			if (!hasType(data, types)) {
				fail(`must be ${types.join(' or ')} (is ${typeOf(data)})`);
				return out;
			}
		}
		if (Array.isArray(node.enum) && !node.enum.some((allowed) => isDeepStrictEqual(allowed, data)))
			fail(`must be one of ${node.enum.map(show).join(', ')} (is ${show(data)})`);
		if (Object.hasOwn(node, 'const') && !isDeepStrictEqual(node.const, data)) fail(`must be ${show(node.const)}`);
		if (typeof data === 'string') {
			const length = [...data].length;
			if (typeof node.minLength === 'number' && length < node.minLength) fail(`must be at least ${node.minLength} characters`);
			if (typeof node.maxLength === 'number' && length > node.maxLength) fail(`must be at most ${node.maxLength} characters`);
			const pattern = regexOf(node.pattern);
			if (pattern && !pattern.test(data)) fail(`must match ${String(node.pattern)}`);
			const wrong = typeof node.format === 'string' ? formatViolation(node.format, data) : null;
			if (wrong) fail(wrong);
		}
		if (typeof data === 'number') {
			if (typeof node.minimum === 'number' && data < node.minimum) fail(`must be at least ${node.minimum}`);
			if (typeof node.maximum === 'number' && data > node.maximum) fail(`must be at most ${node.maximum}`);
		}
		if (Array.isArray(data)) {
			if (typeof node.minItems === 'number' && data.length < node.minItems) fail(`must have at least ${node.minItems} items`);
			if (typeof node.maxItems === 'number' && data.length > node.maxItems) fail(`must have at most ${node.maxItems} items`);
			if (node.items !== undefined)
				data.forEach((item, index) => out.push(...check(node.items, item, `${path}/${index}`, depth + 1)));
		}
		if (isObject(data)) {
			const properties = isObject(node.properties) ? node.properties : {};
			for (const name of Array.isArray(node.required) ? node.required : [])
				if (!Object.hasOwn(data, String(name))) fail('is required', `${path}/${escapeToken(String(name))}`);
			if (typeof node.maxProperties === 'number' && Object.keys(data).length > node.maxProperties)
				fail(`must have at most ${node.maxProperties} members`);
			for (const [name, member] of Object.entries(data)) {
				const where = `${path}/${escapeToken(name)}`;
				if (node.propertyNames !== undefined && check(node.propertyNames, name, where, depth + 1).length > 0)
					fail('is not an allowed name', where);
				if (Object.hasOwn(properties, name)) out.push(...check(properties[name], member, where, depth + 1));
				else if (node.additionalProperties === false) fail('is not described (additionalProperties is false)', where);
				else if (isObject(node.additionalProperties)) out.push(...check(node.additionalProperties, member, where, depth + 1));
			}
		}
		for (const keyword of /** @type {const} */ (['oneOf', 'anyOf'])) {
			const branches = node[keyword];
			if (!Array.isArray(branches)) continue;
			const results = branches.map((branch) => check(branch, data, path, depth + 1));
			const matched = results.filter((problems) => problems.length === 0).length;
			if (keyword === 'oneOf' ? matched === 1 : matched > 0) continue;
			if (matched > 1) fail(`must match exactly one of the oneOf schemas (matches ${matched})`);
			else {
				// the closest branch says best what is wrong: one of the value's type, with the fewest problems
				const distance = (/** @type {number} */ index) =>
					(typeFits(branches[index], data) ? 0 : 1000) + /** @type {SchemaProblem[]} */ (results[index]).length;
				const closest = results.reduce((best, _, index) => (distance(index) < distance(best) ? index : best), 0);
				out.push(
					.../** @type {SchemaProblem[]} */ (results[closest]).map((problem) => ({
						...problem,
						message: `${problem.message} (no ${keyword} schema fits)`,
					})),
				);
			}
		}
		return out;
	};
	return check(schema, value, '', 0);
};
