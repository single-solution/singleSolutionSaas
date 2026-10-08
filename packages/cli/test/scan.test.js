import { describe, expect, it } from 'vitest';
import { findCssReferences, findDomGlobals, findImports, findRoutes, findStringKeys, lex } from '../src/validate/scan.js';

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
		expect(lex('return /x/; // tail').code).not.toContain('tail');
		expect(lex('/* open').code.trim()).toBe('');
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

	it('finds stylesheet references outside comments', () => {
		expect(findCssReferences("@import 'tailwindcss';\n/* @import '../x.css'; */\n@source \"../../ui/src\";")).toEqual([
			{ specifier: 'tailwindcss', line: 1 },
			{ specifier: '../../ui/src', line: 3 },
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

	it('finds t() keys', () => {
		expect(findStringKeys(lex("t('a.b'); x.t('no'); t(\"c\", { n: 1 }); t(dynamic);"))).toEqual([
			{ key: 'a.b', line: 1 },
			{ key: 'c', line: 1 },
		]);
	});

	it('finds route definitions with their literal members', () => {
		const code = [
			'// defineRoute({ method: "GET" }) in a comment',
			'const label = \'defineRoute({ method: "X" })\';',
			'export const routes = [',
			"\tdefineRoute({ method: 'GET', path: '/v1/a', auth: 'server', feature: 'a', handler: list }),",
			'\tdefineRoute({',
			"\t\tmethod: 'POST',",
			'\t\tpath: "/v1/a/:id",',
			"\t\tauth: 'browser',",
			'\t\twidgetScript: true,',
			'\t\tidempotent: false,',
			'\t\trateLimit: [{ limit: 3, windowSeconds: 60 }, { limit: 1, windowSeconds: 1 }],',
			'\t\thandler: async (ctx) => ({ id: ctx.params.id, x: `a,${1}` }),',
			'\t}),',
			'\tdefineRoute({ ...base, method: METHOD, path: `/v1/${name}`, handler }),',
			'\tdefineRoute({ async handler() {} }),',
			"\tdefineRoute({ method: 'GET', path: '/v1/b', auth: 'browser', feature: ['a', \"b\"], handler }),",
			'];',
		].join('\n');
		const found = findRoutes(lex(code));
		expect(found).toHaveLength(5);
		expect(found[4]?.members.feature).toEqual({ literal: true, value: ['a', 'b'] });
		expect(found[0]).toEqual({
			line: 4,
			spread: false,
			members: {
				method: { literal: true, value: 'GET' },
				path: { literal: true, value: '/v1/a' },
				auth: { literal: true, value: 'server' },
				feature: { literal: true, value: 'a' },
				handler: { literal: false, value: 'list' },
			},
		});
		expect(found[1]?.members).toMatchObject({
			method: { literal: true, value: 'POST' },
			path: { literal: true, value: '/v1/a/:id' },
			widgetScript: { literal: true, value: true },
			idempotent: { literal: true, value: false },
			rateLimit: { literal: false },
		});
		expect(found[2]).toMatchObject({
			spread: true,
			members: { method: { literal: false, value: 'METHOD' }, path: { literal: false }, handler: { literal: false } },
		});
		expect(found[3]?.members).toEqual({});
	});
});
