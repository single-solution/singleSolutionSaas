/**
 * A deliberately small static scanner for JavaScript sources: it strips comments and blanks string contents (keeping
 * offsets, so line numbers stay exact), then answers the questions `ss app validate` asks: which modules are imported,
 * which DOM globals are touched, which colour literals appear, which string keys are used and which names are exported.
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
export const lineOf = (text, offset) => {
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

/** Browser globals that must never appear in `core/` or `headless/`. */
export const DOM_GLOBALS = Object.freeze([
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

const COLOUR_PATTERNS = [
	/(?<![\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g,
	/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\s*\(/gi,
];

/**
 * Colour literals in a text fragment.
 * @param {string} text
 * @returns {{ value: string, index: number }[]}
 */
export const colourLiterals = (text) =>
	COLOUR_PATTERNS.flatMap((pattern) =>
		[...text.matchAll(new RegExp(pattern))].map((match) => ({ value: match[0], index: match.index ?? 0 })),
	).sort((a, b) => a.index - b.index);

/**
 * Hard-coded colours inside string and template literals of a JS source.
 * @param {Lexed} lexed
 * @returns {{ value: string, line: number }[]}
 */
export const findColours = ({ source, strings }) =>
	strings.flatMap((literal) =>
		colourLiterals(literal.value).map(({ value, index }) => ({ value, line: lineOf(source, literal.start + 1 + index) })),
	);

/**
 * String-catalog keys used through the `t('key')` convention.
 * @param {Lexed} lexed
 * @returns {{ key: string, line: number }[]}
 */
export const findStringKeys = ({ code }) =>
	[...code.matchAll(/(?<![\w$.])t\(\s*(['"])([^'"\n]+)\1/g)].map((match) => ({
		key: match[2] ?? '',
		line: lineOf(code, match.index ?? 0),
	}));

/**
 * Names exported by a module (declarations and export lists; `export default` is reported as `default`).
 * @param {Lexed} lexed
 * @returns {Set<string>}
 */
export const findExports = ({ code }) => {
	/** @type {Set<string>} */
	const names = new Set();
	for (const match of code.matchAll(/\bexport\s+(?:async\s+)?(?:const|let|var|function\s*\*?|class)\s+([A-Za-z_$][\w$]*)/g))
		names.add(match[1] ?? '');
	for (const match of code.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
		for (const part of (match[1] ?? '').split(',')) {
			const name = part
				.trim()
				.split(/\s+as\s+/)
				.at(-1)
				?.trim();
			if (name) names.add(name);
		}
	}
	if (/\bexport\s+default\b/.test(code)) names.add('default');
	return names;
};
