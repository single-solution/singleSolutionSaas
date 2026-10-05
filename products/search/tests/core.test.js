/** Pure core: text analysis, document types, indexing, query planning, the portable engine, results, analytics, sources. */
import { describe, expect, it } from 'vitest';
import { analyticsKey, dayOf, expiryOf, looksPersonal, reportOf, windowStart } from '../core/analytics.js';
import { documentFromItem, itemUrl } from '../core/catalog.js';
import { defaultsOf, effectiveConfig } from '../core/config.js';
import { analyse, termsOf, vocabularyChange } from '../core/indexing.js';
import { candidateTerms, expandTokens, idf, prefixFactor, scoreDocuments } from '../core/portable.js';
import { editsFor, planQuery, rankingOf, weightOf } from '../core/query.js';
import { decodeCursor, encodeCursor, finalScore, rankCandidates, searchResponse } from '../core/results.js';
import { fieldValueOf, hitView, linkOf, matchableFields, textOf, typesOf, validateDocument } from '../core/schema.js';
import {
	at,
	crawledId,
	crawlSourcesOf,
	extractPage,
	hostAllowed,
	mapRecord,
	parseSitemap,
	recordsOf,
	stableHash,
} from '../core/sources.js';
import { suggestionsOf } from '../core/suggestions.js';
import { clip, editDistance, htmlText, normalise, termVariants, tokenize, trigrams } from '../core/text.js';
import ranking from '../schemas/ranking.features.json' with { type: 'json' };
import indexSchema from '../schemas/index.features.json' with { type: 'json' };
import suggestionsSchema from '../schemas/suggestions.features.json' with { type: 'json' };

const TYPES = typesOf([
	{
		key: 'item',
		label: 'Item',
		fields: [
			{ key: 'title', searchable: true, prefix: true, display: true },
			{ key: 'cost', searchable: true, private: true, display: true },
			{ key: 'notes', searchable: false, display: true },
		],
	},
	{
		key: 'page',
		label: '',
		title_field: 'heading',
		description_field: 'BAD',
		fields: [{ key: 'heading' }, { key: 'heading' }, { key: 'BAD' }],
	},
	{ key: 'item', label: 'duplicate', fields: [] },
	{ key: 'Bad Key', fields: [] },
	'junk',
]);
const RANK = rankingOf(effectiveConfig(ranking, {}));

describe('text', () => {
	it('normalises, tokenizes (ideographs one per token) and splits letters from digits', () => {
		expect(normalise('  Crème  BRÛLÉE ')).toBe('creme brulee');
		expect(tokenize('iPhone-13 Pro, 東京tower')).toEqual(['iphone', '13', 'pro', '東', '京', 'tower']);
		expect(tokenize('x'.repeat(50))[0]).toHaveLength(40);
		expect(termVariants('iphone13')).toEqual(['iphone13', 'iphone', '13']);
		expect(termVariants('shirt')).toEqual(['shirt']);
		expect(tokenize(null)).toEqual([]);
	});

	it('builds trigrams and a bounded edit distance (with swaps)', () => {
		expect(trigrams('ab')).toEqual(['^ab', 'ab$']);
		expect(trigrams('a')).toEqual(['^a$']);
		expect(trigrams('abc')).toEqual(['^ab', 'abc', 'bc$']);
		expect(editDistance('sweater', 'sweatre', 2)).toBe(1);
		expect(editDistance('kitten', 'sitting', 3)).toBe(3);
		expect(editDistance('kitten', 'sitting', 1)).toBe(2);
		expect(editDistance('a', 'abcdef', 2)).toBe(3);
		expect(editDistance('', 'ab', 2)).toBe(2);
		expect(editDistance('same', 'same', 0)).toBe(0);
	});

	it('extracts text from HTML and clips on word boundaries', () => {
		expect(htmlText('<p>Hi&nbsp;<b>there</b> &amp; &#65;&#x42; &bogus; &#xD800;</p><script>x()</script><!-- c -->')).toBe(
			'Hi there & AB &bogus;',
		);
		expect(clip('one two three', 100)).toBe('one two three');
		expect(clip('aaaa bbbbbbbbbbb', 12)).toBe('aaaa bbbbbbb');
		expect(clip('one two three four five', 20)).toBe('one two three four');
	});
});

describe('config and document types', () => {
	it('takes schema defaults and typed overrides only', () => {
		expect(defaultsOf(indexSchema).engine).toBe('auto');
		const config = effectiveConfig(indexSchema, { engine: 'portable', max_documents: 'many', cache_seconds: 5 });
		expect([config.engine, config.max_documents, config.cache_seconds]).toEqual(['portable', 10000, 5]);
		expect(
			effectiveConfig(
				{
					properties: {
						a: { default: 1 },
						n: { type: 'number', default: 1 },
						o: { type: 'object', default: {} },
						l: { type: 'array', default: [] },
					},
				},
				{ a: 'x', n: Infinity, o: [], l: [1] },
			),
		).toEqual({ a: 'x', n: 1, o: {}, l: [1] });
	});

	it('reads document types, dropping invalid ones', () => {
		expect([...TYPES.keys()]).toEqual(['item', 'page']);
		const item = /** @type {any} */ (TYPES.get('item'));
		expect(item.fields.find((/** @type {any} */ f) => f.key === 'cost')).toMatchObject({ private: true, display: false });
		expect(TYPES.get('page')).toMatchObject({ label: 'page', titleField: 'heading', descriptionField: 'description' });
		expect(TYPES.get('page')?.fields).toHaveLength(1);
		expect(typesOf(null).size).toBe(0);
	});

	it('validates links, field values and documents', () => {
		expect(linkOf('/a')).toBe('/a');
		expect(linkOf('https://x.example.com/p')).toBe('https://x.example.com/p');
		for (const bad of ['//x.com', 'http://x.com', 'javascript:alert(1)', 'https://u:p@x.com', 'a b', 'nope', 3])
			expect(linkOf(bad)).toBeUndefined();
		expect(linkOf('')).toBeNull();
		expect(fieldValueOf(['a', 2, true, {}, NaN], 10)).toEqual(['a', 2, true]);
		expect(fieldValueOf({ size: ['S', 'M'], x: {} }, 10)).toEqual(['size S', 'size M']);
		expect(fieldValueOf('abcdef', 3)).toBe('abc');
		expect(fieldValueOf(Infinity, 3)).toBeUndefined();
		expect(fieldValueOf(null, 3)).toBeUndefined();
		expect(textOf(['a', 1])).toBe('a 1');
		expect(textOf(undefined)).toBe('');
		const ok = validateDocument(
			{ id: 'd1', type: 'item', fields: { title: 'T', other: 1 } },
			{ types: TYPES, maxFieldChars: 100 },
		);
		expect(ok).toMatchObject({ ok: true, value: { id: 'd1', boost: 0, price: null, url: null }, ignored: ['other'] });
		expect(validateDocument({ type: 'item' }, { types: TYPES, maxFieldChars: 100, newId: () => 'gen' })).toMatchObject({
			ok: true,
			value: { id: 'gen' },
		});
		const bad = validateDocument(
			{ id: '!', type: 'x', url: 'ftp://a', image: 'http://a', price: 1.5, currency: 'eur', boost: -1, fields: [] },
			{ types: TYPES, maxFieldChars: 100 },
		);
		expect(bad.ok ? [] : bad.errors.map((e) => e.code)).toEqual([
			'id_invalid',
			'type_unknown',
			'url_invalid',
			'url_invalid',
			'minor_units',
			'currency_invalid',
			'boost_range',
			'object_required',
		]);
		expect(validateDocument('x', { types: TYPES, maxFieldChars: 1 })).toEqual({
			ok: false,
			errors: [{ path: '', code: 'object_required' }],
		});
		const value = validateDocument(
			{ id: 'd', type: 'item', fields: { title: {}, cost: null } },
			{ types: TYPES, maxFieldChars: 100 },
		);
		expect(value.ok ? null : value.errors).toEqual([{ path: '/fields/cost', code: 'value_invalid' }]);
	});

	it('shows browsers display fields that are not private, servers everything', () => {
		const doc = {
			id: 'd',
			type: 'item',
			fields: { title: 'T', cost: 5, notes: 'n' },
			boost: 2,
			source: 'api',
			updatedAt: new Date(0),
			price: 1,
			currency: 'EUR',
		};
		const type = TYPES.get('item');
		expect(hitView(doc, type, { owner: false })).toEqual({
			id: 'd',
			type: 'item',
			title: 'T',
			description: '',
			url: null,
			image: null,
			price: 1,
			currency: 'EUR',
			fields: { title: 'T', notes: 'n' },
		});
		expect(hitView(doc, type, { owner: true })).toMatchObject({
			fields: { title: 'T', cost: 5, notes: 'n' },
			boost: 2,
			source: 'api',
			updatedAt: '1970-01-01T00:00:00.000Z',
		});
		const privateTitle = typesOf([{ key: 'x', label: 'X', fields: [{ key: 'title', private: true }] }]).get('x');
		expect(hitView({ id: 'd', type: 'x', fields: { title: 'secret' } }, privateTitle, { owner: false }).title).toBe('');
		expect(hitView({ id: 'd', type: 'gone', fields: null }, undefined, { owner: true })).toMatchObject({
			title: '',
			fields: {},
			boost: 0,
			source: null,
			updatedAt: null,
		});
		expect([...(matchableFields(TYPES, { owner: false }).get('item')?.keys() ?? [])]).toEqual(['title']);
		expect([...(matchableFields(TYPES, { owner: true }).get('item')?.keys() ?? [])]).toEqual(['title', 'cost']);
		expect([...matchableFields(TYPES, { owner: true, only: ['page'] }).keys()]).toEqual(['page']);
	});
});

describe('indexing', () => {
	it('analyses fields into terms, public terms and the autocomplete text', () => {
		const doc = /** @type {any} */ (
			validateDocument(
				{ id: 'd', type: 'item', fields: { title: 'Linen Shirt13', cost: 'secret', notes: 'skip' } },
				{ types: TYPES, maxFieldChars: 100 },
			)
		).value;
		const analysis = analyse(doc, /** @type {any} */ (TYPES.get('item')), { maxFieldChars: 100 });
		expect(analysis.fieldTerms).toEqual({ title: ['linen', 'shirt13', 'shirt', '13'], cost: ['secret'] });
		expect(analysis.publicTerms).toEqual(['linen', 'shirt13', 'shirt', '13']);
		expect(analysis.terms).toContain('secret');
		expect(analysis.suggest).toBe('Linen Shirt13');
		expect(termsOf('a b c d', 2)).toEqual(['a', 'b']);
		expect(
			analyse({ ...doc, fields: { title: '!!!' } }, /** @type {any} */ (TYPES.get('item')), { maxFieldChars: 10 }).terms,
		).toEqual([]);
	});

	it('computes vocabulary changes', () => {
		expect(vocabularyChange({ terms: ['a', 'b'], publicTerms: ['a'] }, { terms: ['b', 'c'], publicTerms: ['b', 'c'] })).toEqual(
			{
				add: ['c'],
				remove: ['a'],
				addPublic: ['b', 'c'],
				removePublic: ['a'],
			},
		);
		expect(vocabularyChange(null, null)).toEqual({ add: [], remove: [], addPublic: [], removePublic: [] });
	});
});

describe('query planning', () => {
	it('resolves ranking settings', () => {
		const rank = rankingOf({
			field_boosts: [{ field: 'title', weight: 500 }, { field: 'x' }],
			synonyms: [{ terms: ['TV', 'television', 'flat screen'] }, { terms: 'bad' }, null],
			pinned: [{ query: ' HELP ', ids: ['a', 3] }, { query: 'help', ids: ['b'] }, { query: '', ids: [] }, { query: 'x' }],
			match_mode: 'weird',
			max_edits: 9,
			typo_tolerance: false,
			stopwords: ['The'],
			document_boost_weight: 'x',
		});
		expect(weightOf(rank, 'title')).toBe(100);
		expect(weightOf(rank, 'other')).toBe(1);
		expect(rank.synonyms.get('tv')).toEqual(['television', 'flat', 'screen']);
		expect(rank.pinned.get('help')).toEqual(['a']);
		expect([rank.mode, rank.maxEdits, rank.typo, rank.boostWeight, [...rank.stopwords]]).toEqual([
			'all_then_any',
			2,
			false,
			1,
			['the'],
		]);
		expect(rankingOf({}).mode).toBe('all_then_any');
	});

	it('plans words, prefixes, typo budgets, stopwords and pins', () => {
		const rank = rankingOf({
			...effectiveConfig(ranking, {}),
			stopwords: ['the'],
			pinned: [{ query: 'the shirt', ids: ['d'] }],
		});
		const plan = planQuery('The  Shirt shirt sweaters 13', rank, { maxChars: 100 });
		expect(plan.tokens.map((t) => [t.term, t.prefix, t.maxEdits])).toEqual([
			['shirt', false, 1],
			['sweaters', false, 2],
			['13', true, 0],
		]);
		expect(planQuery('the', rank, { maxChars: 100 }).tokens.map((t) => t.term)).toEqual(['the']);
		expect(planQuery('shirt ', rank, { maxChars: 100 }).tokens[0]?.prefix).toBe(false);
		expect(planQuery('the shirt', rank, { maxChars: 100 }).pinned).toEqual(['d']);
		expect(planQuery(undefined, rank, { maxChars: 10 }).tokens).toEqual([]);
		expect(editsFor('abc', rank)).toBe(0);
		expect(editsFor('abcdefghij', { ...rank, maxEdits: 1 })).toBe(1);
	});
});

describe('portable engine core', () => {
	const plan = planQuery('linen shir', RANK, { maxChars: 100 });
	const vocab = [
		{ term: 'shirt', df: 2, pdf: 2 },
		{ term: 'shirts', df: 1, pdf: 0 },
		{ term: 'linen', df: 3, pdf: 3 },
		{ term: 'lien', df: 1, pdf: 1 },
		{ term: 'shorts', df: 1, pdf: 1 },
	];
	it('expands words to prefixes and typo candidates (public vocabulary for browsers)', () => {
		const expanded = expandTokens(plan, { prefixes: [[], vocab], typos: [vocab, vocab] }, { owner: false });
		expect([...(expanded[1]?.terms.keys() ?? [])]).toEqual(['shir', 'shirt', 'shorts']);
		expect(expanded[1]?.terms.get('shirt')?.kind).toBe('prefix');
		expect([...(expanded[0]?.terms.keys() ?? [])]).toEqual(['linen', 'lien']);
		const owner = expandTokens(plan, { prefixes: [[], vocab], typos: [[], []] }, { owner: true });
		expect([...(owner[1]?.terms.keys() ?? [])]).toContain('shirts');
		expect(candidateTerms(expanded)).toEqual(['linen', 'lien', 'shir', 'shirt', 'shorts']);
		expect(prefixFactor('sh', 'shirt')).toBeCloseTo(0.66);
		expect(idf(0, 0)).toBe(1);
		const synonyms = expandTokens(
			{ ...plan, tokens: [{ term: 'tv', synonyms: ['television'], prefix: false, maxEdits: 2 }] },
			{
				prefixes: [],
				typos: [
					[
						{ term: 'tx', df: 1, pdf: 1 },
						{ term: 'tvvvv', df: 1, pdf: 1 },
					],
				],
			},
			{ owner: false },
		);
		expect([...(synonyms[0]?.terms ?? new Map())].map(([t, e]) => [t, e.kind])).toEqual([
			['tv', 'exact'],
			['television', 'synonym'],
			['tx', 'typo'],
		]);
	});

	it('scores with field weights and the match mode; prefix expansions only match prefix fields', () => {
		const expanded = expandTokens(plan, { prefixes: [[], vocab], typos: [[], []] }, { owner: false });
		const allowed = matchableFields(TYPES, { owner: false });
		const docs = /** @type {any[]} */ ([
			{ id: 'a', type: 'item', fieldTerms: { title: ['linen', 'shirt'] } },
			{ id: 'b', type: 'item', fieldTerms: { title: ['linen'] } },
			{ id: 'c', type: 'item', fieldTerms: { cost: ['linen', 'shirt'] } },
			{ id: 'd', type: 'unknown', fieldTerms: { title: ['linen'] } },
			{ id: 'e', type: 'page', fieldTerms: { heading: ['shirt'] } },
		]);
		const context = { allowed, ranking: RANK, weightOfTerm: () => 1 };
		expect(scoreDocuments(docs, expanded, { ...context, mode: 'all' }).scored.map((s) => s.doc.id)).toEqual(['a']);
		const any = scoreDocuments(docs, expanded, { ...context, mode: 'any' }).scored.map((s) => s.doc.id);
		expect(any).toEqual(['a', 'b']);
		const relaxed = scoreDocuments(docs.slice(1), expanded, { ...context, mode: 'all_then_any' });
		expect([relaxed.relaxed, relaxed.scored.map((s) => s.doc.id)]).toEqual([true, ['b']]);
		expect(scoreDocuments(docs, [], { ...context, mode: 'all' }).scored).toEqual([]);
	});
});

describe('results', () => {
	it('ranks with the document boost, pins first and pages with a query-bound cursor', () => {
		expect(finalScore(2, 9, 1)).toBe(4);
		expect(finalScore(2, -1, 1)).toBe(2);
		const ranked = rankCandidates(
			[
				{ doc: { id: 'b', type: 'item', fields: { title: 'B' } }, score: 1 },
				{ doc: { id: 'a', type: 'item', fields: { title: 'A' } }, score: 1 },
				{ doc: { id: 'c', type: 'item', fields: {}, boost: 99 }, score: 1 },
			],
			{ boostWeight: 1, pinned: [{ id: 'a', type: 'item', fields: { title: 'A' } }] },
		);
		expect(ranked.map((r) => r.doc.id)).toEqual(['a', 'c', 'b']);
		const page = searchResponse({
			query: 'x',
			text: 'x',
			ranked,
			offset: 0,
			limit: 2,
			maxResults: 10,
			types: TYPES,
			owner: false,
			engine: 'portable',
			relaxed: false,
			capped: false,
			explain: true,
		});
		expect(page).toMatchObject({ total: 3, hasMore: true, items: [{ id: 'a' }, { id: 'c', score: 3 }] });
		expect(decodeCursor(page.nextCursor, 'x')).toBe(2);
		expect(decodeCursor(page.nextCursor, 'y')).toBe(-1);
		expect(decodeCursor('%%%', 'x')).toBe(-1);
		expect(decodeCursor('x'.repeat(500), 'x')).toBe(-1);
		expect(decodeCursor(undefined, 'x')).toBeNull();
		expect(decodeCursor(encodeCursor(1, 'x'), 'x')).toBe(1);
		expect(rankCandidates([], { boostWeight: 1, pinned: [{ id: 'p' }] })[0]?.score).toBe(1);
	});
});

describe('analytics', () => {
	it('never counts personal-looking queries', () => {
		expect(analyticsKey('  Linen   SHIRT ')).toBe('linen shirt');
		for (const q of ['me@example.com', '+44 20 7946 0958', '4111 1111 1111 1111', 'https://x.com', 'www.x.com', '', '   '])
			expect(analyticsKey(q)).toBeNull();
		expect(looksPersonal('iphone 13')).toBe(false);
	});

	it('uses calendar days in the website time zone and builds reports', () => {
		const t = Date.parse('2026-10-01T23:30:00Z');
		expect(dayOf(t, 'Asia/Tokyo')).toBe('2026-10-02');
		expect(dayOf(t, 'Not/AZone')).toBe('2026-10-01');
		expect(dayOf(t, null)).toBe('2026-10-01');
		expect(windowStart(t, 7, 'UTC')).toBe('2026-09-25');
		expect(expiryOf(0, 1).toISOString()).toBe('1970-01-03T00:00:00.000Z');
		const report = reportOf(
			[
				{ q: 'a', searches: 2, zero: 0, clicks: 1, results: 3 },
				{ q: 'a', searches: 1 },
				{ q: 'b', searches: 3, zero: 3 },
				{ q: 'c', searches: 3, zero: 1 },
			],
			{ limit: 5 },
		);
		expect(report.top.map((r) => r.q)).toEqual(['a', 'b', 'c']);
		expect(report.zeroResults.map((r) => r.q)).toEqual(['b', 'c']);
		expect(report.totals).toEqual({ searches: 9, zero: 4, clicks: 1, zeroRate: 0.444, clickRate: 0.111 });
		expect(reportOf([], { limit: 1 }).totals.zeroRate).toBe(0);
	});
});

describe('suggestions', () => {
	it('merges popular queries over the minimum, completions and recent documents', () => {
		const settings = effectiveConfig(suggestionsSchema, {});
		const value = suggestionsOf({
			query: 'red sh',
			popular: [
				{ q: 'red shoes', searches: 9 },
				{ q: 'red shirt', searches: 9 },
				{ q: 'rare', searches: 1 },
			],
			completions: [
				{ term: 'shoes', pdf: 3 },
				{ term: 'shirt', pdf: 5 },
				{ term: 'sh', pdf: 1 },
				{ term: 'shy', pdf: 0 },
			],
			recent: [],
			settings,
		});
		expect(value).toEqual({
			query: 'red sh',
			popular: [{ text: 'red shirt' }, { text: 'red shoes' }],
			completions: [{ text: 'red shirt' }, { text: 'red shoes' }],
			recent: [],
		});
		const empty = suggestionsOf({
			query: '',
			popular: [{ q: 'x', searches: 10 }],
			completions: [],
			recent: [/** @type {any} */ ({ id: 'd', type: 't', title: 'T', url: null, extra: 1 })],
			settings,
		});
		expect(empty).toMatchObject({
			popular: [{ text: 'x' }],
			completions: [],
			recent: [{ id: 'd', type: 't', title: 'T', url: null }],
		});
		const off = suggestionsOf({
			query: 'x',
			popular: [{ q: 'xy', searches: 99 }],
			completions: [{ term: 'xy', pdf: 1 }],
			recent: [],
			settings: { ...settings, popular: false, completions: false, recent_documents: false },
		});
		expect(off).toEqual({ query: 'x', popular: [], completions: [], recent: [] });
		expect(
			suggestionsOf({ query: 'sh', popular: [], completions: [{ term: 'shirt', pdf: 1 }], recent: [], settings }).completions,
		).toEqual([{ text: 'shirt' }]);
	});
});

describe('catalog items', () => {
	it('maps item snapshots to documents, removes inactive items, never reads cost', () => {
		expect(itemUrl('/items/{itemId}', 'a b')).toBe('/items/a%20b');
		expect(itemUrl('', 'a')).toBeNull();
		expect(itemUrl('/static', 'a')).toBeNull();
		const mapped = documentFromItem(
			{
				itemId: 'itm_1',
				title: 'Linen shirt',
				status: 'active',
				brand: 'Acme',
				collections: ['col_1'],
				attributes: { material: 'linen', sizes: ['S', 'M'] },
				currency: 'EUR',
				variants: [
					{ variantId: 'v1', sku: 'LS-S', price: 4900, cost: 2100, attributes: { size: 'S' } },
					{ variantId: 'v2', sku: 'LS-S', price: 3900 },
				],
			},
			{ type: 'item', urlTemplate: '/items/{itemId}' },
		);
		expect(mapped).toEqual({
			action: 'upsert',
			document: {
				id: 'itm_1',
				type: 'item',
				url: '/items/itm_1',
				image: null,
				price: 3900,
				currency: 'EUR',
				boost: 0,
				fields: {
					title: 'Linen shirt',
					brand: 'Acme',
					skus: ['LS-S'],
					attributes: ['material linen', 'sizes S', 'sizes M', 'size S'],
					collections: ['col_1'],
				},
			},
		});
		expect(JSON.stringify(mapped)).not.toContain('2100');
		expect(documentFromItem({ itemId: 'itm_1', status: 'draft' }, { type: 'item', urlTemplate: '' })).toEqual({
			action: 'remove',
			id: 'itm_1',
		});
		expect(documentFromItem({ itemId: 'itm_1' }, { type: 'item', urlTemplate: '' })).toBeNull();
		expect(documentFromItem({ itemId: '!' }, { type: 'item', urlTemplate: '' })).toBeNull();
		expect(documentFromItem({ itemId: 'i', title: 'T', attributes: 'x' }, { type: 'item', urlTemplate: '' })).toMatchObject({
			document: { price: null, currency: null, fields: { title: 'T', attributes: [] } },
		});
	});
});

describe('crawled sources', () => {
	it('allows only https on the website domain, known types and the plan limit', () => {
		expect(hostAllowed('https://shop.example.com/a', 'shop.example.com')).toBe(true);
		expect(hostAllowed('https://cdn.shop.example.com/a', 'shop.example.com.')).toBe(true);
		for (const url of ['http://shop.example.com', 'https://evilshop.example.com', 'https://u:p@shop.example.com', 'nope'])
			expect(hostAllowed(url, 'shop.example.com')).toBe(false);
		expect(hostAllowed('https://shop.example.com', '')).toBe(false);
		const result = crawlSourcesOf(
			[
				{
					key: 'feed',
					kind: 'json',
					url: 'https://shop.example.com/feed.json',
					type: 'item',
					fields: [{ field: 'title', path: 'name' }, { bad: 1 }],
					every_hours: 6,
					records_path: 'data.items',
				},
				{ key: 'feed', kind: 'json', url: 'https://shop.example.com/x', type: 'item' },
				{ key: 'map', kind: 'sitemap', url: 'https://shop.example.com/sitemap.xml', type: 'page' },
				{ key: 'other', kind: 'sitemap', url: 'https://other.com/sitemap.xml', type: 'page' },
				{ key: 'kind', kind: 'rss', url: 'https://shop.example.com/a', type: 'page' },
				{ key: 'type', kind: 'json', url: 'https://shop.example.com/a', type: 'nope' },
				{ key: 'many', kind: 'json', url: 'https://shop.example.com/b', type: 'page' },
				'junk',
			],
			{ domain: 'shop.example.com', max: 2, types: TYPES },
		);
		expect(result.sources.map((s) => [s.key, s.everyHours, s.recordsPath, s.fields])).toEqual([
			['feed', 6, 'data.items', { title: 'name' }],
			['map', 24, null, {}],
		]);
		expect(result.refused).toEqual([
			{ key: 'other', reason: 'url_not_allowed' },
			{ key: 'kind', reason: 'kind_unknown' },
			{ key: 'type', reason: 'type_unknown' },
			{ key: 'many', reason: 'limit_reached' },
		]);
		expect(crawlSourcesOf(null, { domain: 'a.com', max: 1, types: TYPES }).sources).toEqual([]);
	});

	it('reads paths, records and maps them to documents', () => {
		const json = { data: { items: [{ name: 'A', meta: { tags: ['x'] } }] } };
		expect(at(json, 'data.items.0.name')).toBe('A');
		expect(at(json, 'missing|data.items.0.meta.tags')).toEqual(['x']);
		expect(at(json, 'data.items.x')).toBeUndefined();
		expect(at(json, '.')).toEqual(json);
		expect(recordsOf([1], null)).toEqual([1]);
		expect(recordsOf({ results: [2] }, null)).toEqual([2]);
		expect(recordsOf(json, 'data.items')).toHaveLength(1);
		expect(recordsOf({ x: 1 }, null)).toEqual([]);
		const source = /** @type {any} */ ({ key: 'feed', type: 'item', fields: { title: 'name', id: 'sku' } });
		expect(
			mapRecord(
				{
					sku: 'S1',
					name: 'Shirt',
					price: 100,
					currency: 'EUR',
					boost: 3,
					url: '/s',
					image: { url: 'https://cdn.example.com/i.png' },
				},
				source,
				['title', 'url', 'cost'],
			),
		).toEqual({
			id: 'feed:S1',
			type: 'item',
			url: '/s',
			image: 'https://cdn.example.com/i.png',
			price: 100,
			currency: 'EUR',
			boost: 3,
			fields: { title: 'Shirt' },
		});
		expect(mapRecord({ sku: 5, price: 1.5, currency: 'x', boost: -1, url: 'http://x' }, source, [])).toMatchObject({
			id: 'feed:5',
			price: null,
			currency: null,
			boost: 0,
			url: null,
		});
		expect(mapRecord({ name: 'no id' }, source, [])).toBeNull();
		expect(mapRecord('x', source, [])).toBeNull();
		expect(crawledId('k', 'https://shop.example.com/a b')).toMatch(/^k:[0-9a-f]{14}$/);
		expect(stableHash('a')).toBe(stableHash('a'));
		expect(stableHash('a')).not.toBe(stableHash('b'));
	});

	it('parses sitemaps and pages', () => {
		const xml =
			'<urlset><url><loc> https://shop.example.com/a?x=1&amp;y=2 </loc></url><url><loc><![CDATA[https://shop.example.com/b]]></loc></url><url><loc>https://shop.example.com/b</loc></url><url></url></urlset>';
		expect(parseSitemap(xml, { max: 10 })).toEqual({
			urls: ['https://shop.example.com/a?x=1&y=2', 'https://shop.example.com/b'],
			sitemaps: [],
		});
		expect(parseSitemap(xml, { max: 1 }).urls).toHaveLength(1);
		expect(
			parseSitemap('<sitemapindex><sitemap><loc>https://shop.example.com/s1.xml</loc></sitemap></sitemapindex>', { max: 5 })
				.sitemaps,
		).toEqual(['https://shop.example.com/s1.xml']);
		const page = extractPage(
			'<html><head><title>Returns &amp; refunds</title><meta name="description" content="How to return"><meta property="og:image" content="https://cdn.example.com/r.png"></head><body><nav>Menu</nav><main><h1>Returns</h1><p>Within 30 days.</p></main></body></html>',
		);
		expect(page).toEqual({
			title: 'Returns & refunds',
			description: 'How to return',
			headings: ['Returns'],
			body: 'Returns Within 30 days.',
			image: 'https://cdn.example.com/r.png',
			noindex: false,
		});
		expect(
			extractPage('<meta name="robots" content="noindex, follow"><meta property="og:title" content="OG"><body>x</body>')
				.noindex,
		).toBe(true);
		expect(extractPage('<meta property="og:title" content="OG">text').title).toBe('OG');
		expect(extractPage('<meta name="ss-search" content="none">', { maxBody: 5 }).noindex).toBe(true);
	});
});
