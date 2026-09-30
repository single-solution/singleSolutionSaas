/**
 * The fixed, pure function library of rules@1: metadata (for editors and compile-time checks) and the eager
 * implementations. Lazy functions (`has`, `coalesce`, `any`, `all`, `filter`, `map`, `count` with a predicate) are
 * implemented by the evaluator because they control evaluation of their arguments.
 */

import { isPathNode } from './ast.js';
import { isValidTimeZone, parseClock, zonedParts, DAY_MS } from './time.js';
import { compareValues, isDate, isList, isMap, isNull, isNum, isStr, itemAt, mapKeys, readKey, toMs, kindOf } from './values.js';

/** Maximum length of a `like`/`ilike` pattern (longer patterns never match; literal ones are compile errors). */
export const MAX_PATTERN_LENGTH = 256;

/**
 * @typedef {object} FunctionSpec
 * @property {string} name
 * @property {number} min Minimum argument count.
 * @property {number} max Maximum argument count.
 * @property {number} [lambda] Index of the argument that is a predicate/projection evaluated per item with `it` bound.
 * @property {string} signature
 * @property {string} description
 */

/** @type {FunctionSpec[]} */
const SPECS = [
	{ name: 'has', min: 1, max: 1, signature: 'has(path)', description: 'True when the path exists and is not null.' },
	{
		name: 'count',
		min: 1,
		max: 2,
		lambda: 1,
		signature: 'count(list, predicate?)',
		description: 'Number of items (optionally only those matching the predicate, with `it` bound).',
	},
	{
		name: 'sum',
		min: 1,
		max: 2,
		signature: "sum(list, 'field'?)",
		description: 'Sum of the numeric items (or of item.field); non-numbers skipped; empty list → 0.',
	},
	{ name: 'min', min: 1, max: 50, signature: "min(list, 'field'?) | min(a, b, …)", description: 'Smallest comparable value.' },
	{ name: 'max', min: 1, max: 50, signature: "max(list, 'field'?) | max(a, b, …)", description: 'Largest comparable value.' },
	{ name: 'avg', min: 1, max: 2, signature: "avg(list, 'field'?)", description: 'Mean of the numeric items; empty → null.' },
	{ name: 'round', min: 1, max: 2, signature: 'round(x, digits?)', description: 'Round half away from zero; digits −10…10.' },
	{ name: 'floor', min: 1, max: 1, signature: 'floor(x)', description: 'Round down.' },
	{ name: 'ceil', min: 1, max: 1, signature: 'ceil(x)', description: 'Round up.' },
	{ name: 'abs', min: 1, max: 1, signature: 'abs(x)', description: 'Absolute value.' },
	{ name: 'lower', min: 1, max: 1, signature: 'lower(s)', description: 'Lower-case (locale-independent).' },
	{ name: 'upper', min: 1, max: 1, signature: 'upper(s)', description: 'Upper-case (locale-independent).' },
	{ name: 'trim', min: 1, max: 1, signature: 'trim(s)', description: 'Strip leading/trailing whitespace.' },
	{ name: 'startsWith', min: 2, max: 2, signature: 'startsWith(s, prefix)', description: 'Case-sensitive prefix test.' },
	{ name: 'endsWith', min: 2, max: 2, signature: 'endsWith(s, suffix)', description: 'Case-sensitive suffix test.' },
	{
		name: 'like',
		min: 2,
		max: 2,
		signature: "like(s, 'glob')",
		description: 'Case-sensitive glob match of the whole string: * any run, ? one character, \\ escapes.',
	},
	{ name: 'ilike', min: 2, max: 2, signature: "ilike(s, 'glob')", description: 'Case-insensitive `like`.' },
	{
		name: 'daysSince',
		min: 1,
		max: 1,
		signature: 'daysSince(date)',
		description: 'Whole days elapsed since date (negative if future).',
	},
	{ name: 'hoursSince', min: 1, max: 1, signature: 'hoursSince(date)', description: 'Whole hours elapsed since date.' },
	{ name: 'minutesSince', min: 1, max: 1, signature: 'minutesSince(date)', description: 'Whole minutes elapsed since date.' },
	{
		name: 'dateParts',
		min: 1,
		max: 2,
		signature: "dateParts(date, 'Zone/Name'?)",
		description: '{ year, month, day, hour, minute, second, weekday (1=Mon…7=Sun), weekdayName } in the zone.',
	},
	{
		name: 'between',
		min: 3,
		max: 4,
		signature: "between(time, 'HH:MM', 'HH:MM', 'Zone'?) | between(x, low, high)",
		description: 'Time-of-day window [start, end) in a zone (overnight windows allowed), or inclusive range.',
	},
	{
		name: 'inSegment',
		min: 1,
		max: 1,
		signature: "inSegment('name')",
		description: 'True when context.segments contains name.',
	},
	{ name: 'any', min: 2, max: 2, lambda: 1, signature: 'any(list, predicate)', description: 'Some item matches (`it` bound).' },
	{
		name: 'all',
		min: 2,
		max: 2,
		lambda: 1,
		signature: 'all(list, predicate)',
		description: 'Every item matches; empty → true.',
	},
	{
		name: 'filter',
		min: 2,
		max: 2,
		lambda: 1,
		signature: 'filter(list, predicate)',
		description: 'Items that match (`it` bound).',
	},
	{ name: 'map', min: 2, max: 2, lambda: 1, signature: 'map(list, expr)', description: 'expr for each item (`it` bound).' },
	{ name: 'coalesce', min: 1, max: 50, signature: 'coalesce(a, b, …)', description: 'First argument that is not null (lazy).' },
	{ name: 'len', min: 1, max: 1, signature: 'len(string | list | map)', description: 'Length in characters / items / keys.' },
	{ name: 'date', min: 1, max: 1, signature: 'date(x)', description: 'Date from an ISO string, epoch ms or date; else null.' },
	{ name: 'number', min: 1, max: 1, signature: 'number(x)', description: "Number from a decimal string ('12.5'); else null." },
	{ name: 'string', min: 1, max: 1, signature: 'string(x)', description: 'Text form of a scalar or date (ISO); else null.' },
];

/** @type {ReadonlyMap<string, FunctionSpec>} */
export const FUNCTIONS = new Map(SPECS.map((s) => [s.name, Object.freeze(s)]));

/** Public, frozen list of the function library for editors / builders. */
export const FUNCTION_LIST = Object.freeze(SPECS.map((s) => Object.freeze({ ...s })));

/**
 * Closest known function for an unknown name (case-insensitive), for "did you mean" messages.
 * @param {string} name
 * @returns {string | null}
 */
export function suggestFunction(name) {
	const lower = name.toLowerCase();
	for (const s of SPECS) if (s.name.toLowerCase() === lower) return s.name;
	return null;
}

/**
 * @param {import('./ast.js').Node | undefined} node
 * @returns {node is import('./ast.js').LiteralNode}
 */
const isLit = (node) => node !== undefined && node.type === 'literal';

/**
 * A literal that was meant as a clock (`7:00`, `25:00`) but is malformed — as opposed to an ordinary string bound.
 * @param {string} s
 */
const looksLikeClock = (s) => s.length <= 5 && /^\d{1,2}:\d{1,2}$/.test(s);

/**
 * Compile-time validation of a call (arity and literal arguments). Shared by the parser and the program validator.
 * @param {string} name
 * @param {import('./ast.js').Node[]} args
 * @returns {{ code: string, message: string } | null} Problem, or null when valid.
 */
export function checkCall(name, args) {
	const spec = FUNCTIONS.get(name);
	if (spec === undefined) return { code: 'unknown_function', message: `Unknown function '${name}'` };
	if (args.length < spec.min || args.length > spec.max) {
		const want = spec.min === spec.max ? `${spec.min}` : spec.max >= 50 ? `at least ${spec.min}` : `${spec.min}–${spec.max}`;
		return {
			code: 'arity',
			message: `${name}() takes ${want} argument${want === '1' ? '' : 's'} but got ${args.length}: ${spec.signature}`,
		};
	}
	const message = checkArgs(name, args);
	return message === null ? null : { code: 'invalid_argument', message };
}

/**
 * @param {string} name
 * @param {import('./ast.js').Node[]} args
 * @returns {string | null}
 */
function checkArgs(name, args) {
	const [a0, a1, a2, a3] = args;
	switch (name) {
		case 'has':
			if (a0 === undefined || !isPathNode(a0)) return 'has() expects a path such as has(customer.email)';
			break;
		case 'like':
		case 'ilike':
			if (isLit(a1) && (typeof a1.value !== 'string' || a1.value.length > MAX_PATTERN_LENGTH))
				return `${name}() pattern must be a string of at most ${MAX_PATTERN_LENGTH} characters`;
			break;
		case 'round':
			if (isLit(a1) && !(typeof a1.value === 'number' && Number.isInteger(a1.value) && Math.abs(a1.value) <= 10))
				return 'round() digits must be an integer between -10 and 10';
			break;
		case 'dateParts':
			if (isLit(a1) && !isValidTimeZone(a1.value)) return `Unknown time zone ${JSON.stringify(a1.value)}`;
			break;
		case 'between': {
			for (const b of [a1, a2])
				if (isLit(b) && typeof b.value === 'string' && looksLikeClock(b.value) && parseClock(b.value) === null)
					return `between() time bounds must be 'HH:MM' (00:00–23:59, or 24:00 as an end); got ${JSON.stringify(b.value)}`;
			if (isLit(a3) && !isValidTimeZone(a3.value)) return `Unknown time zone ${JSON.stringify(a3.value)}`;
			break;
		}
		case 'inSegment':
			if (isLit(a0) && typeof a0.value !== 'string') return 'inSegment() expects a segment name string';
			break;
		case 'sum':
		case 'avg':
			if (isLit(a1) && typeof a1.value !== 'string') return `${name}() field must be a string such as 'price'`;
			break;
		default:
			break;
	}
	return null;
}

/**
 * Runtime services passed to built-ins.
 * @typedef {object} Runtime
 * @property {(n: number) => void} tick Charge evaluation steps (throws when the budget is exhausted).
 * @property {number} nowMs
 * @property {string} timeZone Default zone for zone-aware functions.
 * @property {unknown} context
 * @property {(list: unknown[]) => unknown[]} capList Enforces the list-size cap on produced lists.
 */

/**
 * Cost of work proportional to a string's length.
 * @param {string} s
 */
const strCost = (s) => 1 + Math.ceil(s.length / 256);

/**
 * Read a dotted field path ('price', 'variant.price') from an item.
 * @param {unknown} item
 * @param {string} field
 * @returns {unknown}
 */
function readField(item, field) {
	let cur = item;
	for (const part of field.split('.')) cur = readKey(cur, part);
	return cur;
}

/**
 * Values of a list (optionally projected through `field`), charging one step per item.
 * @param {unknown[]} list
 * @param {unknown} field
 * @param {Runtime} rt
 * @returns {unknown[]}
 */
function project(list, field, rt) {
	rt.tick(list.length);
	const out = [];
	for (let i = 0; i < list.length; i++) {
		const item = itemAt(list, i);
		out.push(isStr(field) ? readField(item, field) : item);
	}
	return out;
}

/**
 * Finite-number guard for results.
 * @param {number} n
 * @returns {number | null}
 */
const finite = (n) => (Number.isFinite(n) ? (n === 0 ? 0 : n) : null);

/**
 * Round half away from zero at `digits` decimals using decimal-exponent shifting (so 1.005 → 1.01).
 * @param {number} x
 * @param {number} digits
 * @returns {number | null}
 */
export function roundHalfAway(x, digits) {
	/** @param {number} v @param {number} e */
	const shift = (v, e) => {
		const [m, ex] = String(v).split('e');
		return Number(`${m ?? '0'}e${Number(ex ?? '0') + e}`);
	};
	const sign = x < 0 ? -1 : 1;
	const r = sign * shift(Math.round(shift(Math.abs(x), digits)), -digits);
	return finite(r);
}

/**
 * Glob match over code points: `*` any run (incl. empty), `?` exactly one character, `\` escapes the next character.
 * Iterative single-star backtracking: O(len(s) × len(pattern)), no recursion, no regex.
 * @param {string} s
 * @param {string} pattern
 * @returns {boolean}
 */
export function globMatch(s, pattern) {
	/** @type {Array<{ k: 'lit', c: string } | { k: 'one' } | { k: 'star' }>} */
	const pat = [];
	const pchars = Array.from(pattern);
	for (let i = 0; i < pchars.length; i++) {
		const c = pchars[i] ?? '';
		if (c === '\\' && i + 1 < pchars.length) pat.push({ k: 'lit', c: pchars[++i] ?? '' });
		else if (c === '*') {
			const last = pat[pat.length - 1];
			if (!(last !== undefined && last.k === 'star')) pat.push({ k: 'star' });
		} else if (c === '?') pat.push({ k: 'one' });
		else pat.push({ k: 'lit', c });
	}
	const str = Array.from(s);
	let si = 0;
	let pi = 0;
	let starPi = -1;
	let starSi = 0;
	while (si < str.length) {
		const p = pat[pi];
		if (p !== undefined && (p.k === 'one' || (p.k === 'lit' && p.c === str[si]))) {
			si++;
			pi++;
		} else if (p !== undefined && p.k === 'star') {
			starPi = pi++;
			starSi = si;
		} else if (starPi >= 0) {
			pi = starPi + 1;
			si = ++starSi;
		} else return false;
	}
	while (pat[pi]?.k === 'star') pi++;
	return pi === pat.length;
}

/**
 * min/max shared implementation.
 * @param {unknown[]} args
 * @param {Runtime} rt
 * @param {1 | -1} dir
 * @returns {unknown}
 */
function extreme(args, rt, dir) {
	const [a0, a1] = args;
	/** @type {unknown[]} */
	let values;
	if (args.length === 1) values = isList(a0) ? project(a0, null, rt) : [a0];
	else if (args.length === 2 && isList(a0) && isStr(a1)) values = project(a0, a1, rt);
	else values = args;
	/** @type {unknown} */
	let best = null;
	for (const v of values) {
		if (isNull(v)) continue;
		if (best === null) {
			if (compareValues(v, v) === null) return null;
			best = v;
			continue;
		}
		const c = compareValues(v, best);
		if (c === null) return null;
		if (c === dir) best = v;
	}
	return best;
}

/**
 * Whole units elapsed between a date-like value and now (truncated toward zero; negative in the future).
 * @param {unknown} v
 * @param {number} unit
 * @param {Runtime} rt
 */
function since(v, unit, rt) {
	const ms = toMs(v);
	if (ms === null) return null;
	return Math.trunc((rt.nowMs - ms) / unit) || 0;
}

/**
 * @param {unknown} tz
 * @param {Runtime} rt
 * @returns {string | null}
 */
function zoneArg(tz, rt) {
	if (tz === undefined || tz === null) return rt.timeZone;
	return isStr(tz) && isValidTimeZone(tz) ? tz : null;
}

/** @type {Record<string, (args: unknown[], rt: Runtime) => unknown>} */
const EAGER = {
	sum(args, rt) {
		const [list, field] = args;
		if (!isList(list)) return null;
		let total = 0;
		for (const v of project(list, field, rt)) if (isNum(v)) total += v;
		return finite(total);
	},
	avg(args, rt) {
		const [list, field] = args;
		if (!isList(list)) return null;
		let total = 0;
		let n = 0;
		for (const v of project(list, field, rt))
			if (isNum(v)) {
				total += v;
				n++;
			}
		return n === 0 ? null : finite(total / n);
	},
	min: (args, rt) => extreme(args, rt, -1),
	max: (args, rt) => extreme(args, rt, 1),
	round([x, digits]) {
		const d = digits === undefined || digits === null ? 0 : digits;
		if (!isNum(x) || !isNum(d) || !Number.isInteger(d) || Math.abs(d) > 10) return null;
		return roundHalfAway(x, d);
	},
	floor: ([x]) => (isNum(x) ? finite(Math.floor(x)) : null),
	ceil: ([x]) => (isNum(x) ? finite(Math.ceil(x)) : null),
	abs: ([x]) => (isNum(x) ? Math.abs(x) : null),
	lower([s], rt) {
		if (!isStr(s)) return null;
		rt.tick(strCost(s));
		return s.toLowerCase();
	},
	upper([s], rt) {
		if (!isStr(s)) return null;
		rt.tick(strCost(s));
		return s.toUpperCase();
	},
	trim([s], rt) {
		if (!isStr(s)) return null;
		rt.tick(strCost(s));
		return s.trim();
	},
	startsWith: ([s, p]) => isStr(s) && isStr(p) && s.startsWith(p),
	endsWith: ([s, p]) => isStr(s) && isStr(p) && s.endsWith(p),
	like: ([s, p], rt) => likeImpl(s, p, rt, false),
	ilike: ([s, p], rt) => likeImpl(s, p, rt, true),
	daysSince: ([d], rt) => since(d, DAY_MS, rt),
	hoursSince: ([d], rt) => since(d, 3600000, rt),
	minutesSince: ([d], rt) => since(d, 60000, rt),
	dateParts([d, tz], rt) {
		const ms = toMs(d);
		const zone = zoneArg(tz, rt);
		if (ms === null || zone === null) return null;
		rt.tick(5);
		return zonedParts(ms, zone);
	},
	between([x, lo, hi, tz], rt) {
		const start = parseClock(lo);
		const end = parseClock(hi);
		if (start !== null && end !== null) {
			const ms = toMs(x);
			const zone = zoneArg(tz, rt);
			if (ms === null || zone === null || start === 1440) return false;
			rt.tick(5);
			const p = zonedParts(ms, zone);
			if (p === null) return false;
			const t = p.hour * 60 + p.minute;
			if (start < end) return t >= start && t < end;
			if (start > end) return t >= start || t < end;
			return false;
		}
		const a = compareValues(x, lo);
		const b = compareValues(x, hi);
		return a !== null && b !== null && a >= 0 && b <= 0;
	},
	inSegment([name], rt) {
		if (!isStr(name)) return false;
		const segments = readKey(rt.context, 'segments');
		if (!isList(segments)) return false;
		rt.tick(segments.length);
		for (let i = 0; i < segments.length; i++) if (itemAt(segments, i) === name) return true;
		return false;
	},
	len([v], rt) {
		if (isStr(v)) {
			rt.tick(strCost(v));
			return Array.from(v).length;
		}
		if (isList(v)) return v.length;
		if (isMap(v)) return mapKeys(v).length;
		return null;
	},
	date([v]) {
		const ms = toMs(v);
		return ms === null ? null : new Date(ms);
	},
	number([v]) {
		if (isNum(v)) return v;
		if (!isStr(v) || v.length > 64) return null;
		const t = v.trim();
		return /^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(t) ? finite(Number(t)) : null;
	},
	string([v]) {
		switch (kindOf(v)) {
			case 'string':
				return v;
			case 'number':
			case 'boolean':
				return String(v);
			case 'date':
				return isDate(v) ? v.toISOString() : null;
			default:
				return null;
		}
	},
};

/**
 * @param {unknown} s
 * @param {unknown} p
 * @param {Runtime} rt
 * @param {boolean} fold
 */
function likeImpl(s, p, rt, fold) {
	if (!isStr(s) || !isStr(p) || p.length > MAX_PATTERN_LENGTH) return false;
	rt.tick(1 + Math.ceil(((s.length + 1) * (p.length + 1)) / 64));
	return fold ? globMatch(s.toLowerCase(), p.toLowerCase()) : globMatch(s, p);
}

/**
 * Call an eager built-in.
 * @param {string} name
 * @param {unknown[]} args
 * @param {Runtime} rt
 * @returns {unknown}
 */
export function callEager(name, args, rt) {
	const impl = Object.hasOwn(EAGER, name) ? EAGER[name] : undefined;
	if (impl === undefined) throw new Error(`No implementation for ${name}`);
	return impl(args, rt);
}
