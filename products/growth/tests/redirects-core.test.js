import { describe, expect, it } from 'vitest';
import { parseCsv, toCsv } from '../core/csv.js';
import { createSnippets } from '../core/snippets.js';
import {
	MAX_RULES,
	ancestorsOf,
	changeActivity,
	checkRule,
	createIndex,
	csvOf,
	findProblems,
	importActivity,
	locationOf,
	newProblems,
	normalizePath,
	normalizeTarget,
	planImport,
	problemMessage,
	requestOf,
	ruleActivity,
	ruleOfBody,
	sameRule,
	suggestionsOf,
} from '../core/redirects.js';

const DOMAIN = 'shop.example.com';

/** @typedef {import('../core/redirects.js').Rule} Rule */

let ids = 0;
/**
 * A stored rule.
 * @param {string} from
 * @param {string | null} to
 * @param {{ match?: 'exact' | 'prefix', code?: 301 | 308 | 410, note?: string }} [more]
 * @returns {Rule}
 */
const rule = (from, to, { match = 'exact', code = to === null ? 410 : 301, note = '' } = {}) => {
	ids += 1;
	return { id: `rdr_${ids}`, from, match, to, code, note };
};

describe('paths', () => {
	it('normalizes a path the same way for rules and for addresses asked about', () => {
		/** @param {string} raw */
		const path = (raw) => {
			const found = normalizePath(raw, { domain: DOMAIN });
			return found.ok ? found.path : found.code;
		};
		expect(path('/old/')).toBe('/old');
		expect(path('  /old  ')).toBe('/old');
		expect(path('/')).toBe('/');
		expect(path('//old//page/')).toBe('/old/page');
		expect(path('/a/./b/../c')).toBe('/a/c');
		expect(path('/a\\b')).toBe('/a/b');
		// a backslash can never turn a path into another host
		expect(path('/\\evil.example.com')).toBe('/evil.example.com');
		expect(path('/Old-Page')).toBe('/Old-Page');
		expect(path('/café ')).toBe('/caf%C3%A9');
		expect(path('/caf%c3%a9')).toBe('/caf%C3%A9');
		// one Unicode form (NFC): the same letters typed or encoded composed or decomposed are one path
		expect(path('/cafe\u0301')).toBe('/caf%C3%A9');
		expect(path('/cafe%cc%81/')).toBe('/caf%C3%A9');
		expect(path('/%E2%84%AB')).toBe('/%C3%85');
		// encoded ASCII and bytes that are not UTF-8 are kept as they are
		expect(path('/a%2fb%20c')).toBe('/a%2Fb%20c');
		expect(path('/x%ff')).toBe('/x%FF');
		expect(path('/a b')).toBe('/a%20b');
		expect(path('https://shop.example.com/old/')).toBe('/old');
		expect(path('https://www.shop.example.com/old')).toBe('/old');
		expect(path('http://SHOP.example.com')).toBe('/');
		expect(path('https://other.example.com/old')).toBe('other_host');
		expect(path('https://shop.example.com:bad/')).toBe('not_path');
		expect(path('/old?id=12')).toBe('query');
		expect(path('/old#top')).toBe('query');
		expect(path('old')).toBe('not_path');
		expect(path('/old\u0000')).toBe('not_path');
		expect(path('')).toBe('required');
		expect(normalizePath(null).ok).toBe(false);
		expect(normalizePath(12)).toEqual({ ok: false, code: 'not_path' });
		// the website's domain may itself be the www. name
		expect(normalizePath('https://shop.example.com/a', { domain: `www.${DOMAIN}` })).toMatchObject({ path: '/a' });
		expect(normalizePath('https://shop.example.com/a')).toEqual({ ok: false, code: 'other_host' });
	});

	it('keeps the query string and fragment of a target', () => {
		expect(normalizePath('/new/?b=1#top', { keepQuery: true })).toEqual({
			ok: true,
			path: '/new',
			query: 'b=1',
			fragment: 'top',
		});
	});

	it('takes a path on the website or an https address as a target', () => {
		/** @param {unknown} raw */
		const to = (raw) => {
			const found = normalizeTarget(raw, DOMAIN);
			return found.ok ? found.to : found.code;
		};
		expect(to('/new/?ref=a#top')).toBe('/new?ref=a#top');
		expect(to('//evil.example.com/x')).toBe('/evil.example.com/x');
		expect(to('https://shop.example.com/new?x=1')).toBe('/new?x=1');
		expect(to('https://www.shop.example.com')).toBe('/');
		expect(to('https://new.example.com/Path?q=1#f')).toBe('https://new.example.com/Path?q=1#f');
		expect(to('HTTPS://New.Example.com')).toBe('https://new.example.com/');
		expect(to('http://new.example.com/')).toBe('not_https');
		expect(to('javascript:alert(1)')).toBe('not_https');
		expect(to('mailto:sam@example.com')).toBe('not_https');
		expect(to('new.example.com/page')).toBe('not_target');
		expect(to('https://user:secret@new.example.com/')).toBe('not_target');
		expect(to('https://intranet/')).toBe('not_target');
		expect(to('https://[::1')).toBe('not_target');
		expect(to('/\u0007')).toBe('not_target');
		expect(to(' ')).toBe('required');
		expect(to(42)).toBe('not_target');
	});
});

describe('checking a rule', () => {
	it('fills the defaults and normalizes', () => {
		expect(checkRule({ from: '/old/', to: '/new' }, DOMAIN)).toEqual({
			ok: true,
			rule: { from: '/old', match: 'exact', to: '/new', code: 301, note: '' },
		});
		expect(
			checkRule(
				{ from: '/blog', match: 'PREFIX', to: 'https://news.example.com', code: '308', note: ' moved\n\tthe  blog ' },
				DOMAIN,
			),
		).toEqual({
			ok: true,
			rule: { from: '/blog', match: 'prefix', to: 'https://news.example.com/', code: 308, note: 'moved the blog' },
		});
		expect(checkRule({ from: '/gone', code: 410, to: '' }, DOMAIN)).toMatchObject({ ok: true, rule: { to: null, code: 410 } });
	});

	it('names every field that is wrong', () => {
		const checked = checkRule(
			{ from: '/old?x=1', match: 'starts', code: 302, to: 'http://new.example.com', note: 'x'.repeat(201) },
			DOMAIN,
		);
		expect(checked.ok).toBe(false);
		expect(!checked.ok && checked.errors.map((error) => `${error.path}:${error.code}`)).toEqual([
			'/from:query',
			'/match:not_match',
			'/code:not_code',
			'/to:not_https',
			'/note:too_long',
		]);
		expect(!checked.ok && checked.errors.every((error) => error.message.length > 10)).toBe(true);
		const more = checkRule({ from: `/${'a'.repeat(1000)}`, code: 410, to: '/new', note: 3 }, DOMAIN);
		expect(!more.ok && more.errors.map((error) => `${error.path}:${error.code}`)).toEqual([
			'/from:too_long',
			'/to:gone',
			'/note:not_text',
		]);
		const long = checkRule({ from: '/a', to: `/${'b'.repeat(2048)}` }, DOMAIN);
		expect(!long.ok && long.errors[0]?.code).toBe('too_long');
		expect(checkRule({ to: '/x' }, DOMAIN)).toMatchObject({ ok: false, errors: [{ path: '/from', code: 'required' }] });
		expect(checkRule({ from: '/a' }, DOMAIN)).toMatchObject({ ok: false, errors: [{ path: '/to', code: 'required' }] });
	});

	it('takes a body, or changes merged into a stored rule', () => {
		expect(ruleOfBody([], DOMAIN)).toMatchObject({ ok: false, errors: [{ path: '', code: 'not_object' }] });
		expect(ruleOfBody({ from: '/a', to: '/b', target: '/c' }, DOMAIN)).toMatchObject({
			ok: false,
			errors: [{ path: '/target', code: 'unknown' }],
		});
		const stored = rule('/a', '/b');
		expect(ruleOfBody({ to: '/c' }, DOMAIN, stored)).toMatchObject({ ok: true, rule: { from: '/a', to: '/c' } });
		// a change to 410 drops the stored target
		expect(ruleOfBody({ code: 410 }, DOMAIN, stored)).toMatchObject({ ok: true, rule: { to: null, code: 410 } });
		expect(ruleOfBody({ code: 410, to: '/c' }, DOMAIN, stored)).toMatchObject({ ok: false });
		expect(ruleOfBody({ code: 301 }, DOMAIN, rule('/g', null))).toMatchObject({ ok: false, errors: [{ path: '/to' }] });
		expect(sameRule(stored, { ...stored })).toBe(true);
		expect(sameRule(stored, { ...stored, note: 'x' })).toBe(false);
	});
});

describe('matching', () => {
	it('lists a path and every path above it', () => {
		expect(ancestorsOf('/a/b/c')).toEqual(['/a/b/c', '/a/b', '/a', '/']);
		expect(ancestorsOf('/a')).toEqual(['/a', '/']);
		expect(ancestorsOf('/')).toEqual(['/']);
	});

	it('answers with the exact rule, else the longest prefix, segment by segment', () => {
		const rules = [
			rule('/blog', '/news', { match: 'prefix' }),
			rule('/blog/2019', '/archive', { match: 'prefix' }),
			rule('/blog/2019/best-of', '/best'),
			rule('/home', '/'),
			rule('/gone', null, { match: 'prefix' }),
		];
		const index = createIndex(rules);
		/** @param {string} path */
		const from = (path) => index.match(path)?.from ?? null;
		expect(from('/blog')).toBe('/blog');
		expect(from('/blog/a/b')).toBe('/blog');
		expect(from('/blogger')).toBe(null);
		expect(from('/blog/2019/x')).toBe('/blog/2019');
		expect(from('/blog/2019/best-of')).toBe('/blog/2019/best-of');
		expect(from('/blog/2019/best-of/more')).toBe('/blog/2019');
		expect(from('/home')).toBe('/home');
		expect(from('/home/x')).toBe(null);
		expect(from('/gone/old')).toBe('/gone');
		expect(from('/')).toBe(null);
		expect(index.under('/blog').map((found) => found.from)).toEqual(['/blog/2019', '/blog/2019/best-of']);
		expect(index.under('/').map((found) => found.from)).toHaveLength(5);
		expect(createIndex([rule('/', 'https://new.example.com', { match: 'prefix' })]).match('/any/path')?.from).toBe('/');
	});

	it('sends the visitor on with the rest of a prefix rule and the query string', () => {
		const prefix = rule('/blog', '/news?ref=old#top', { match: 'prefix' });
		expect(locationOf(prefix, '/blog/a/b', 'utm_source=x')).toBe('/news/a/b?ref=old&utm_source=x#top');
		expect(locationOf(prefix, '/blog')).toBe('/news?ref=old#top');
		expect(locationOf(rule('/', '/shop', { match: 'prefix' }), '/a')).toBe('/shop/a');
		expect(locationOf(rule('/old', '/', { match: 'prefix' }), '/old/a')).toBe('/a');
		expect(locationOf(rule('/old', '/', { match: 'prefix' }), '/old')).toBe('/');
		expect(locationOf(rule('/a', '/b'), '/a', 'x=1')).toBe('/b?x=1');
		expect(locationOf(rule('/a', 'https://new.example.com/shop/', { match: 'prefix' }), '/a/b', 'q=2')).toBe(
			'https://new.example.com/shop/b?q=2',
		);
		expect(locationOf(rule('/gone', null), '/gone')).toBe(null);
	});

	it('reads the address the website asks about', () => {
		expect(requestOf('/a//x/?utm_source=x&b=2#f')).toEqual({ path: '/a/x', query: 'utm_source=x&b=2' });
		expect(requestOf('/a')).toEqual({ path: '/a', query: '' });
		expect(requestOf('/cafe%CC%81?q=1')).toEqual({ path: '/caf%C3%A9', query: 'q=1' });
		expect(requestOf(`/${'a'.repeat(1200)}`)).toEqual({ path: null, query: '' });
		expect(requestOf(`/a?${'q'.repeat(2049)}`)).toBe(null);
		expect(requestOf('a')).toBe(null);
		expect(requestOf('/a\n')).toBe(null);
		expect(requestOf(undefined)).toBe(null);
	});
});

describe('loops and chains', () => {
	/** @param {Rule[]} rules */
	const kinds = (rules) => findProblems(rules).map((found) => `${found.kind} ${found.steps.join(' ')}`);

	it('finds a rule that sends to itself or round two rules', () => {
		expect(kinds([rule('/a', '/a')])).toEqual(['loop /a /a']);
		expect(kinds([rule('/a', '/b'), rule('/b', '/a')])).toEqual(['loop /a /b /a', 'loop /b /a /b']);
		// a prefix rule that sends into itself grows each path for ever
		expect(kinds([rule('/a', '/a/b', { match: 'prefix' })])).toEqual(['loop /a /a/b /a/b/b']);
	});

	it('finds chains of two hops, and redirects to a removed page', () => {
		expect(kinds([rule('/a', '/b'), rule('/b', '/c')])).toEqual(['chain /a /b /c']);
		expect(kinds([rule('/a', '/b'), rule('/b', '/c', { match: 'prefix' })])).toEqual(['chain /a /b /c']);
		expect(kinds([rule('/a', '/b/x'), rule('/b', 'https://new.example.com', { match: 'prefix' })])).toEqual([
			'chain /a /b/x https://new.example.com/x',
		]);
		const gone = findProblems([rule('/a', '/b'), rule('/b', null)]);
		expect(gone).toEqual([{ kind: 'chain', steps: ['/a', '/b'], gone: true, first: '/a', second: '/b' }]);
		expect(problemMessage(/** @type {any} */ (gone[0]))).toContain('removes (410)');
	});

	it('follows the rest of a prefix rule onto the rules under its target', () => {
		// /old/x → /new/x, which another rule sends on
		expect(kinds([rule('/old', '/new', { match: 'prefix' }), rule('/new/x', '/y')])).toEqual(['chain /old/x /new/x /y']);
		// any path under it lands under a prefix rule of the target
		expect(kinds([rule('/old', '/new', { match: 'prefix' }), rule('/new/x', '/y', { match: 'prefix' })])).toEqual([
			'chain /old/x /new/x /y',
		]);
		expect(kinds([rule('/old', '/new/sub', { match: 'prefix' }), rule('/new', '/z', { match: 'prefix' })])).toEqual([
			'chain /old /new/sub /z/sub',
		]);
		// a prefix moved up meets the other rules under the website, not itself
		expect(kinds([rule('/old', '/', { match: 'prefix' })])).toEqual([]);
		expect(kinds([rule('/old', '/', { match: 'prefix' }), rule('/shop', '/store')])).toEqual(['chain /old/shop /shop /store']);
		// a path answered by a more specific rule of the prefix is not the prefix's
		expect(kinds([rule('/a', '/b', { match: 'prefix' }), rule('/a/x', '/c'), rule('/b/x', '/d')])).toEqual([]);
		expect(
			kinds([
				rule('/a', '/b', { match: 'prefix' }),
				rule('/a/x', 'https://x.example.com', { match: 'prefix' }),
				rule('/b/x', '/d', { match: 'prefix' }),
			]),
		).toEqual([]);
		// an exact rule over the landing path keeps the paths under it for the prefix rule
		expect(kinds([rule('/a', '/b', { match: 'prefix' }), rule('/a/x', '/c'), rule('/b/x', '/d', { match: 'prefix' })])).toEqual(
			['chain /a/x/… /b/x/… /d/…'],
		);
	});

	it('stops at another site and at five hops', () => {
		expect(kinds([rule('/a', 'https://new.example.com/a'), rule('/b', '/a/c')])).toEqual([]);
		const long = [rule('/1', '/2'), rule('/2', '/3'), rule('/3', '/4'), rule('/4', '/5'), rule('/5', '/6'), rule('/6', '/7')];
		expect(findProblems(long)[0]?.steps).toEqual(['/1', '/2', '/3', '/4', '/5', '/6']);
	});

	it('reports only what a change brings', () => {
		const prefix = rule('/a', '/b', { match: 'prefix' });
		const shadow = rule('/a/x', '/c');
		const other = rule('/b/x', '/d');
		expect(newProblems([prefix, shadow, other], [prefix, shadow, other])).toEqual([]);
		// deleting the exact rule leaves /a/x to the prefix rule, onto /b/x
		expect(newProblems([prefix, shadow, other], [prefix, other]).map((found) => found.steps)).toEqual([['/a/x', '/b/x', '/d']]);
		// an older problem is not the change's
		const loop = [rule('/l', '/m'), rule('/m', '/l')];
		expect(newProblems(loop, [...loop, rule('/z', '/y')])).toEqual([]);
	});
});

describe('CSV files', () => {
	it('writes RFC 4180 with a byte order mark and a formula guard, and reads it back', () => {
		const text = toCsv(
			['from', 'note'],
			[
				['/a', '=SUM(A1)'],
				['/b,c', 'say "hi"\nthere'],
				['/d', 5],
				['/e', null],
			],
		);
		expect(text.startsWith('﻿from,note\r\n')).toBe(true);
		expect(text).toContain(`"/b,c","say ""hi""\nthere"`);
		expect(text).toContain("/a,'=SUM(A1)");
		const parsed = parseCsv(text, { maxRows: 10 });
		expect(parsed).toMatchObject({
			ok: true,
			header: ['from', 'note'],
			records: [
				{ line: 2, values: { from: '/a', note: '=SUM(A1)' } },
				{ line: 3, values: { from: '/b,c', note: 'say "hi"\nthere' } },
				{ line: 4, values: { from: '/d', note: '5' } },
				{ line: 5, values: { from: '/e', note: '' } },
			],
		});
	});

	it('reads semicolons, tabs, CR line ends, blank lines and short rows', () => {
		expect(parseCsv('From;To\r\n\r\n/a;/b\r', { maxRows: 5 })).toMatchObject({
			ok: true,
			records: [{ line: 2, values: { from: '/a', to: '/b' } }],
		});
		expect(parseCsv('from\tto\n/a\t/b\n/c', { maxRows: 5 })).toMatchObject({
			ok: true,
			records: [{ values: { from: '/a', to: '/b' } }, { values: { from: '/c', to: '' } }],
		});
		expect(parseCsv('from,,from\r/a,x,/b', { maxRows: 5 })).toMatchObject({ ok: true, records: [{ values: { from: '/a' } }] });
		// a header of many empty columns costs no time per record
		const started = performance.now();
		expect(parseCsv(`from${','.repeat(200_000)}\n${'/a\n'.repeat(5000)}`, { maxRows: 5000 })).toMatchObject({ ok: true });
		expect(performance.now() - started).toBeLessThan(1000);
		expect(parseCsv('', { maxRows: 5 })).toEqual({ ok: false, code: 'empty' });
		expect(parseCsv('from\n"/a', { maxRows: 5 })).toEqual({ ok: false, code: 'unterminated_quote' });
		expect(parseCsv('from\n/a\n/b\n/c\n', { maxRows: 2 })).toEqual({ ok: false, code: 'too_many_rows' });
		expect(parseCsv('from\n/a\n/b\n/c', { maxRows: 2 })).toEqual({ ok: false, code: 'too_many_rows' });
	});

	it('exports the rules A to Z', () => {
		const text = csvOf([rule('/b', null, { match: 'prefix', note: 'old shop' }), rule('/a', '/new')]);
		expect(text).toBe('﻿from,match,to,code,note\r\n/a,exact,/new,301,\r\n/b,prefix,,410,old shop\r\n');
	});

	it('plans an import: creates, changes, leaves the same alone, and lists every problem', () => {
		const existing = [rule('/same', '/x'), rule('/change', '/x'), rule('/keep', '/k')];
		const plan = planImport({
			csv: [
				'Redirect from,Redirect to,Status,Note,Extra',
				'/same,/x,301,,ignored',
				'/change,/y,308,moved,',
				'/new,https://shop.example.com/n,,,',
				'/gone,,410,,',
				'/new,/z,,,',
				'/bad?x,/z,,,',
				'/loop,/loop,,,',
			].join('\n'),
			existing,
			domain: DOMAIN,
		});
		expect(plan.rows).toBe(7);
		expect(plan.unchanged).toBe(1);
		expect(plan.changes.map((change) => `${change.line} ${change.action} ${change.rule.from} ${change.rule.to}`)).toEqual([
			'3 update /change /y',
			'4 create /new /n',
			'5 create /gone null',
		]);
		expect(plan.changes[0]?.before).toMatchObject({ to: '/x', code: 301 });
		expect(plan.errors.map((error) => `${error.line} ${error.path} ${error.code}`)).toEqual([
			'6 /from twice',
			'7 /from query',
			'8 /to loop',
		]);
		expect(plan.errors[2]?.steps).toEqual(['/loop', '/loop']);
		// the set after it keeps the stored ids
		expect(plan.next.find((found) => found.from === '/change')).toMatchObject({ id: existing[1]?.id, to: '/y', code: 308 });
	});

	it('names chains and removed targets on the line that brings them', () => {
		const plan = planImport({ csv: 'from,to,code\n/a,/b,\n/b,/c,\n/x,/y,\n/y,,410', existing: [], domain: DOMAIN });
		expect(plan.errors.map((error) => `${error.line} ${error.code}`)).toEqual(['2 chain', '4 removed']);
		expect(plan.changes.map((change) => change.line)).toEqual([3, 5]);
		const later = planImport({ csv: 'from,to\n/c,/a', existing: [rule('/a', '/b')], domain: DOMAIN });
		expect(later.errors).toMatchObject([{ line: 2, code: 'chain', steps: ['/c', '/a', '/b'] }]);
	});

	it('refuses a file without a from column, a broken file and too many rules', () => {
		expect(planImport({ csv: 'old,new\n/a,/b', existing: [], domain: DOMAIN }).errors).toMatchObject([
			{ line: 1, path: '', code: 'columns' },
		]);
		expect(planImport({ csv: '', existing: [], domain: DOMAIN }).errors).toMatchObject([{ code: 'empty' }]);
		expect(planImport({ csv: 'from\n"/a', existing: [], domain: DOMAIN }).errors).toMatchObject([
			{ code: 'unterminated_quote' },
		]);
		const lines = Array.from({ length: MAX_RULES + 1 }, (_, i) => `/p${i},/q${i}`);
		expect(planImport({ csv: `from,to\n${lines.join('\n')}`, existing: [], domain: DOMAIN }).errors).toMatchObject([
			{ code: 'too_many_rows' },
		]);
		const full = Array.from({ length: MAX_RULES }, (_, i) => rule(`/s${i}`, `/t${i}`));
		const over = planImport({ csv: 'from,to\n/one-more,/t', existing: full, domain: DOMAIN });
		expect(over.errors).toMatchObject([{ line: 1, path: '', code: 'too_many' }]);
		expect(over.changes).toHaveLength(1);
	});
});

describe('suggestions from the 404 log', () => {
	it('lists the most-hit missing paths without a rule, with a page of the same last segment', () => {
		const totals = [
			{ metric: 'not_found', key: '/old/blue-lamp', count: 9 },
			{ metric: 'not_found', key: '/old/blue-lamp/', count: 1 },
			{ metric: 'not_found', key: '/has-rule', count: 50 },
			{ metric: 'not_found', key: '/missing', count: 3 },
			{ metric: 'not_found', key: '/a-tie', count: 3 },
			{ metric: 'not_found', key: 'not a path', count: 99 },
			{ metric: 'page', key: '/lamps/blue-lamp', count: 40 },
			{ metric: 'page', key: '/sale/blue-lamp', count: 2 },
			{ metric: 'page', key: '/old/blue-lamp', count: 10 },
			{ metric: 'page', key: '/moved/missing', count: 10 },
			{ metric: 'page', key: '/', count: 100 },
			{ metric: 'page', key: 'nope', count: 100 },
			{ metric: 'search', key: 'lamp', count: 5 },
		];
		const rules = [rule('/has-rule', '/x'), rule('/moved', '/y', { match: 'prefix' })];
		expect(suggestionsOf({ totals, rules, limit: 20 })).toEqual([
			{ path: '/old/blue-lamp', hits: 10, to: '/lamps/blue-lamp' },
			{ path: '/a-tie', hits: 3, to: null },
			{ path: '/missing', hits: 3, to: null },
		]);
		expect(suggestionsOf({ totals, rules, limit: 1 })).toHaveLength(1);
	});
});

describe('the activity log', () => {
	it('says what a rule does and what changed', () => {
		expect(ruleActivity(rule('/a', '/b'))).toEqual({ label: '/a', detail: 'To /b, 301, exact.' });
		expect(ruleActivity(rule('/g', null, { match: 'prefix' }))).toEqual({ label: '/g', detail: 'Gone (410), prefix.' });
		const before = rule('/a', '/b');
		expect(changeActivity(before, { ...before, from: '/c', match: 'prefix', code: 410, to: null, note: 'x' })).toEqual({
			label: '/c',
			detail: 'from /a → /c; match exact → prefix; code 301 → 410; to /b → none; note changed.',
		});
		expect(changeActivity({ ...before, to: null }, { ...before }).detail).toBe('to none → /b.');
		expect(importActivity({ created: 2, updated: 1, unchanged: 0 })).toEqual({
			label: 'redirects.csv',
			detail: '2 new, 1 changed, 0 unchanged.',
		});
	});
});

describe('the docs’ middleware example', () => {
	it('sends every request where GET /v1/redirects/match does, reading the list once', async () => {
		const rules = [
			rule('/blog', '/news?ref=old#top', { match: 'prefix' }),
			rule('/blog/2019', 'https://archive.example.com/2019/', { match: 'prefix' }),
			rule('/blog/2019/best', '/best'),
			rule('/caf%C3%A9', '/coffee'),
			rule('/retired', null, { match: 'prefix' }),
			rule('/', 'https://new.example.com', { match: 'prefix' }),
			rule('/Home', '/'),
		];
		const code = createSnippets({ base: 'https://growth.example.dev', widgets: [], permissions: [] }).redirects;
		let reads = 0;
		const fetch = async () => {
			reads += 1;
			return { status: 200, headers: { get: () => '"v1"' }, json: async () => ({ rules }) };
		};
		const redirectFor = /** @type {(url: URL) => Promise<unknown>} */ (
			new Function('fetch', 'process', `${code.replace('export async function', 'async function')}\nreturn redirectFor;`)(
				fetch,
				{
					env: { SS_SERVER_TOKEN: 'token' },
				},
			)
		);
		const index = createIndex(rules);
		for (const address of [
			'/blog',
			'/blog/a/b/?utm_source=news',
			'/blog//2019/x',
			'/blog/2019/best/',
			'/blog/2019/best/more?x=1',
			'/caf%c3%a9',
			'/cafe%CC%81',
			'/cafe\u0301/',
			'/retired/old-lamp',
			'/Home',
			'/home',
			'/anything/else?q=2',
			'/',
		]) {
			const url = new URL(address, 'https://shop.example.com');
			const asked = /** @type {{ path: string, query: string }} */ (requestOf(`${url.pathname}${url.search}`));
			const found = index.match(asked.path);
			const expected =
				found === null
					? null
					: found.code === 410
						? { status: 410 }
						: { status: found.code, location: locationOf(found, asked.path, asked.query) };
			expect({ address, answer: await redirectFor(url) }).toEqual({ address, answer: expected });
		}
		expect(reads).toBe(1);
	});
});
