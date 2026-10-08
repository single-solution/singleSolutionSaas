/**
 * A deliberately small static scanner for JavaScript sources: it strips comments and blanks string contents (keeping
 * offsets, so line numbers stay exact), then answers the questions `ss app validate` and `ss app assets` ask: which
 * modules are imported, which DOM globals are touched, which widget-text keys are used and which routes are defined.
 * It is a lexer, not a parser: good enough for linting conventions, never used for security decisions.
 * @module
 */

/**
 * @typedef {object} StringLiteral
 * @property {string} value raw contents (escapes not processed)
 * @property {number} start offset of the opening quote
 * @property {'single' | 'double' | 'template'} quote
 */

/**
 * @typedef {object} Lexed
 * @property {string} source original text
 * @property {string} code comments replaced by spaces (strings intact)
 * @property {string} blank comments and string contents replaced by spaces
 * @property {StringLiteral[]} strings
 */

const REGEX_PRECEDERS = new Set([
	'(',
	',',
	'=',
	':',
	'[',
	'!',
	'&',
	'|',
	'?',
	'{',
	'}',
	';',
	'+',
	'-',
	'*',
	'%',
	'<',
	'>',
	'~',
	'^',
]);
const REGEX_KEYWORDS = new Set([
	'return',
	'typeof',
	'instanceof',
	'in',
	'of',
	'new',
	'delete',
	'void',
	'throw',
	'case',
	'do',
	'else',
]);

/**
 * @param {string} text
 * @param {number} index
 * @returns {boolean} true when a `/` at `index` starts a regular expression literal
 */
const regexAllowed = (text, index) => {
	let i = index - 1;
	while (i >= 0 && /\s/.test(text[i] ?? '')) i -= 1;
	if (i < 0) return true;
	const ch = text[i] ?? '';
	if (REGEX_PRECEDERS.has(ch)) return true;
	if (/[A-Za-z_$]/.test(ch)) {
		let start = i;
		while (start > 0 && /[A-Za-z0-9_$]/.test(text[start - 1] ?? '')) start -= 1;
		return REGEX_KEYWORDS.has(text.slice(start, i + 1));
	}
	return false;
};

/**
 * Lex a JavaScript source.
 * @param {string} source
 * @returns {Lexed}
 */
export const lex = (source) => {
	const code = source.split('');
	const blank = source.split('');
	/** @type {StringLiteral[]} */
	const strings = [];
	/** @param {number} from @param {number} to @param {boolean} both */
	const clear = (from, to, both) => {
		for (let k = from; k < to; k += 1) {
			if (source[k] === '\n') continue;
			blank[k] = ' ';
			if (both) code[k] = ' ';
		}
	};
	/** Template nesting: each entry counts open braces inside a `${ … }` expression. @type {number[]} */
	const templates = [];
	let i = 0;
	const n = source.length;
	/** @param {number} start offset of the backtick or closing brace */
	const scanTemplateChunk = (start) => {
		let j = start + 1;
		while (j < n) {
			const ch = source[j];
			if (ch === '\\') j += 2;
			else if (ch === '`') {
				strings.push({ value: source.slice(start + 1, j), start, quote: 'template' });
				clear(start + 1, j, false);
				return { end: j + 1, open: false };
			} else if (ch === '$' && source[j + 1] === '{') {
				strings.push({ value: source.slice(start + 1, j), start, quote: 'template' });
				clear(start + 1, j, false);
				return { end: j + 2, open: true };
			} else j += 1;
		}
		clear(start + 1, n, false);
		return { end: n, open: false };
	};
	while (i < n) {
		const ch = source[i];
		const next = source[i + 1];
		if (ch === '/' && next === '/') {
			const end = source.indexOf('\n', i);
			const stop = end === -1 ? n : end;
			clear(i, stop, true);
			i = stop;
		} else if (ch === '/' && next === '*') {
			const end = source.indexOf('*/', i + 2);
			const stop = end === -1 ? n : end + 2;
			clear(i, stop, true);
			i = stop;
		} else if (ch === "'" || ch === '"') {
			let j = i + 1;
			while (j < n && source[j] !== ch && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
			strings.push({ value: source.slice(i + 1, j), start: i, quote: ch === "'" ? 'single' : 'double' });
			clear(i + 1, Math.min(j, n), false);
			i = j + 1;
		} else if (ch === '`') {
			const { end, open } = scanTemplateChunk(i);
			if (open) templates.push(0);
			i = end;
		} else if (ch === '{' && templates.length > 0) {
			templates[templates.length - 1] = (templates.at(-1) ?? 0) + 1;
			i += 1;
		} else if (ch === '}' && templates.length > 0) {
			const depth = templates.at(-1) ?? 0;
			if (depth === 0) {
				templates.pop();
				const { end, open } = scanTemplateChunk(i);
				if (open) templates.push(0);
				i = end;
			} else {
				templates[templates.length - 1] = depth - 1;
				i += 1;
			}
		} else if (ch === '/' && regexAllowed(source, i)) {
			let j = i + 1;
			let inClass = false;
			while (j < n && source[j] !== '\n') {
				const c = source[j];
				if (c === '\\') j += 1;
				else if (c === '[') inClass = true;
				else if (c === ']') inClass = false;
				else if (c === '/' && !inClass) break;
				j += 1;
			}
			clear(i + 1, Math.min(j, n), false);
			i = j + 1;
		} else i += 1;
	}
	return { source, code: code.join(''), blank: blank.join(''), strings };
};

/**
 * 1-based line number of an offset.
 * @param {string} text
 * @param {number} offset
 * @returns {number}
 */
const lineOf = (text, offset) => {
	let line = 1;
	for (let k = 0; k < offset && k < text.length; k += 1) if (text[k] === '\n') line += 1;
	return line;
};

/**
 * @typedef {object} ImportRef
 * @property {string} specifier
 * @property {number} line
 */

const IMPORT_PATTERNS = [
	/(?:^|[;\n}])\s*import\s+(?:[\w$*{}\s,]+?\s+from\s*)?(['"])([^'"\n]+)\1/g,
	/\bexport\s+(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(['"])([^'"\n]+)\1/g,
	/\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*[,)]/g,
	/\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
];

/**
 * Static module specifiers referenced by a source.
 * @param {Lexed} lexed
 * @returns {ImportRef[]}
 */
export const findImports = ({ code }) => {
	/** @type {Map<number, ImportRef>} */
	const found = new Map();
	for (const pattern of IMPORT_PATTERNS) {
		for (const match of code.matchAll(new RegExp(pattern))) {
			const specifier = match[2] ?? '';
			const offset = (match.index ?? 0) + match[0].lastIndexOf(specifier);
			if (!found.has(offset)) found.set(offset, { specifier, line: lineOf(code, offset) });
		}
	}
	return [...found.entries()].sort(([a], [b]) => a - b).map(([, ref]) => ref);
};

const CSS_REFERENCE = /@(?:import|source)\s+(?:url\(\s*)?(['"])([^'"\n]+)\1/g;

/**
 * Files a stylesheet references by path: `@import` and Tailwind's `@source` (comments are ignored).
 * @param {string} css
 * @returns {ImportRef[]}
 */
export const findCssReferences = (css) => {
	const code = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
	return [...code.matchAll(CSS_REFERENCE)].map((match) => {
		const specifier = match[2] ?? '';
		return { specifier, line: lineOf(code, (match.index ?? 0) + match[0].lastIndexOf(specifier)) };
	});
};

/** Browser globals that must never appear in `core/` (pure logic). */
const DOM_GLOBALS = Object.freeze([
	'window',
	'document',
	'navigator',
	'localStorage',
	'sessionStorage',
	'HTMLElement',
	'customElements',
	'requestAnimationFrame',
	'getComputedStyle',
	'matchMedia',
	'MutationObserver',
	'IntersectionObserver',
]);

const DOM_PATTERN = new RegExp(`(?<![\\w$.])(${DOM_GLOBALS.join('|')})(?![\\w$])(?!\\s*:(?!:))`, 'g');

/**
 * DOM globals referenced outside comments and strings (member accesses like `x.document` and object keys are ignored).
 * @param {Lexed} lexed
 * @returns {{ name: string, line: number }[]}
 */
export const findDomGlobals = ({ blank }) =>
	[...blank.matchAll(DOM_PATTERN)].map((match) => ({ name: match[1] ?? '', line: lineOf(blank, match.index ?? 0) }));

/**
 * Widget-text keys used through the `t('key')` convention (`strings/en.json`).
 * @param {Lexed} lexed
 * @returns {{ key: string, line: number }[]}
 */
export const findStringKeys = ({ code }) =>
	[...code.matchAll(/(?<![\w$.])t\(\s*(['"])([^'"\n]+)\1/g)].map((match) => ({
		key: match[2] ?? '',
		line: lineOf(code, match.index ?? 0),
	}));

/**
 * @typedef {object} RouteMember
 * @property {boolean} literal the value is a plain string literal, a list of them, `true` or `false`
 * @property {string | string[] | boolean} value the literal value, or the source text when not literal
 */

/**
 * @typedef {object} RouteCall
 * @property {number} line
 * @property {Record<string, RouteMember>} members top-level members of the definition object
 * @property {boolean} spread the object spreads another value (`...x`), so its members cannot be known
 */

const ROUTE_CALL = /(?<![\w$.])defineRoute\s*\(\s*\{/g;
const MEMBER = /^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]*)$/;
const STRING_VALUE = /^(['"])((?:(?!\1)[^\\\n])*)\1$/;
const STRING_LIST = /^\[\s*(?:'[^'\\\n,]*'|"[^"\\\n,]*")(?:\s*,\s*(?:'[^'\\\n,]*'|"[^"\\\n,]*"))*\s*,?\s*\]$/;

/**
 * @param {string} text
 * @returns {RouteMember}
 */
const memberValue = (text) => {
	const string = STRING_VALUE.exec(text);
	if (string) return { literal: true, value: string[2] ?? '' };
	// a list of string literals (a route that works while any of several features is on)
	if (STRING_LIST.test(text)) {
		const items = text
			.slice(1, -1)
			.split(',')
			.map((item) => item.trim())
			.filter((item) => item !== '');
		return { literal: true, value: items.map((item) => item.slice(1, -1)) };
	}
	if (text === 'true' || text === 'false') return { literal: true, value: text === 'true' };
	return { literal: false, value: text };
};

/**
 * Route definitions: every `defineRoute({ … })` call with the top-level members of its object literal. Only plain
 * literals can be checked, so products write `method`, `path`, `auth`, `feature` and `permission` as string literals.
 * @param {Lexed} lexed
 * @returns {RouteCall[]}
 */
export const findRoutes = ({ code, blank }) =>
	[...blank.matchAll(ROUTE_CALL)].map((match) => {
		const open = (match.index ?? 0) + match[0].length - 1;
		/** @type {Array<[number, number]>} */
		const parts = [];
		let depth = 0;
		let start = open + 1;
		let i = open + 1;
		for (; i < blank.length; i += 1) {
			const ch = blank[i];
			if (ch === '{' || ch === '[' || ch === '(') depth += 1;
			else if (ch === '}' || ch === ']' || ch === ')') {
				if (depth === 0) break;
				depth -= 1;
			} else if (ch === ',' && depth === 0) {
				parts.push([start, i]);
				start = i + 1;
			}
		}
		parts.push([start, i]);
		/** @type {Record<string, RouteMember>} */
		const members = {};
		let spread = false;
		for (const [from, to] of parts) {
			const text = code.slice(from, to).trim();
			if (text.startsWith('...')) spread = true;
			const member = MEMBER.exec(text);
			if (member) members[member[1] ?? ''] = memberValue((member[2] ?? '').trim());
			else if (/^[A-Za-z_$][\w$]*$/.test(text)) members[text] = { literal: false, value: text };
		}
		return { line: lineOf(code, open), members, spread };
	});
