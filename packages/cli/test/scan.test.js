import { describe, expect, it } from 'vitest';
import {
	colourLiterals,
	findColours,
	findDomGlobals,
	findExports,
	findImports,
	findStringKeys,
	lex,
} from '../src/validate/scan.js';

describe('lexer', () => {
	it('blanks comments and strings but keeps offsets and lines', () => {
		const source = "const a = 'x // not a comment'; // real\n/* block\n */ const b = `t ${a} u`;\nconst r = /ab'c/g;";
		const lexed = lex(source);
		expect(lexed.blank.length).toBe(source.length);
		expect(lexed.code).not.toContain('real');
		expect(lexed.code).toContain("'x // not a comment'");
		expect(lexed.blank).not.toContain('not a comment');
		expect(lexed.strings.map((s) => s.value)).toEqual(['x // not a comment', 't ', ' u']);
		expect(lexed.blank.split('\n')).toHaveLength(source.split('\n').length);
	});

	it('handles nested template expressions and division', () => {
		const lexed = lex('const x = `a ${ { b: `c ${d}` }.b } e`; const y = 4 / 2 / 1; const z = "q";');
		expect(lexed.strings.map((s) => s.value)).toEqual(['a ', 'c ', '', ' e', 'q']);
		expect(lex('const s = "unterminated').strings).toHaveLength(1);
		expect(lex('const t = `open').strings).toHaveLength(0);
	});
});

describe('finders', () => {
	it('finds static, re-export, dynamic and require specifiers with lines', () => {
		const code =
			"import a from './a.js';\nimport {\n b,\n c } from '../core/b.js';\nexport * from './c.js';\nexport { d } from \"d\";\nconst e = await import('./e.js');\nconst f = require('f');\n// import g from './g.js'\nimport './side.js';";
		expect(findImports(lex(code))).toEqual([
			{ specifier: './a.js', line: 1 },
			{ specifier: '../core/b.js', line: 4 },
			{ specifier: './c.js', line: 5 },
			{ specifier: 'd', line: 6 },
			{ specifier: './e.js', line: 7 },
			{ specifier: 'f', line: 8 },
			{ specifier: './side.js', line: 10 },
		]);
	});

	it('finds DOM globals but not members, keys, strings or comments', () => {
		const code =
			"const w = window.innerWidth;\nconst x = { document: 1 };\nconst y = foo.document;\n// document\nconst z = 'navigator';\nlocalStorage.setItem('a', 'b');";
		expect(findDomGlobals(lex(code))).toEqual([
			{ name: 'window', line: 1 },
			{ name: 'localStorage', line: 6 },
		]);
	});

	it('finds colour literals in strings only', () => {
		const code =
			"const a = '#fff';\nconst b = `color: rgba(0,0,0,.5)`;\n// #000000\nconst c = 'var(--ss-color-text)';\nconst d = '#main-nav';";
		expect(findColours(lex(code))).toEqual([
			{ value: '#fff', line: 1 },
			{ value: 'rgba(', line: 2 },
		]);
		expect(colourLiterals('a { color: hsl(1 2 3); background: #A1B2C3D4 }').map((c) => c.value)).toEqual(['hsl(', '#A1B2C3D4']);
	});

	it('finds t() keys and exports', () => {
		expect(findStringKeys(lex("t('a.b'); x.t('no'); t(\"c\", { n: 1 }); t(dynamic);"))).toEqual([
			{ key: 'a.b', line: 1 },
			{ key: 'c', line: 1 },
		]);
		const exports = findExports(
			lex('export const a = 1; export async function b() {} export { c, d as e }; export default 1; export function* g() {}'),
		);
		expect([...exports].sort()).toEqual(['a', 'b', 'c', 'default', 'e', 'g']);
	});
});
