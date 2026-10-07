/**
 * MongoDB Atlas Search, pure part: the search index definition this product manages (one definition for every
 * website and document type, so merchant field changes never need an index rebuild: document fields are mapped
 * dynamically, the as-you-type text of public prefix fields is an `autocomplete` field), the `$search` pipeline built
 * from the shared query plan (field boosts, synonyms, typo budget, prefix, match mode, tenant and visibility filters),
 * and the classification of Atlas errors and index states for the dashboard.
 *
 * The definition name carries its version: a new definition gets a new name, so an existing index is never edited in
 * place while it serves queries.
 * @module
 */
import { weightOf } from './query.js';

export const ATLAS_INDEX = 'ss_search_v1';

/** The Atlas Search index definition of the documents collection. */
export const atlasDefinition = () => ({
	mappings: {
		dynamic: false,
		fields: {
			websiteId: { type: 'token' },
			status: { type: 'token' },
			type: { type: 'token' },
			boost: { type: 'number' },
			fields: { type: 'document', dynamic: true },
			suggest: [
				{ type: 'string' },
				{ type: 'autocomplete', tokenization: 'edgeGram', minGrams: 1, maxGrams: 15, foldDiacritics: true },
			],
		},
	},
});

/** Fields every engine returns for a hit (the same projection as the portable engine's). */
export const HIT_PROJECTION = Object.freeze({
	_id: 0,
	id: 1,
	type: 1,
	url: 1,
	image: 1,
	price: 1,
	currency: 1,
	boost: 1,
	fields: 1,
	source: 1,
	updatedAt: 1,
});

/**
 * Clauses matching one planned word in the fields a key may match.
 * @param {import('./query.js').PlannedToken} token
 * @param {Map<string, Map<string, { prefix: boolean }>>} allowed type → field → options
 * @param {import('./query.js').Ranking} ranking
 */
export const tokenClause = (token, allowed, ranking) => {
	/** @type {Map<string, string[]>} field → the types where it may match */
	const byField = new Map();
	for (const [type, fields] of allowed)
		for (const field of fields.keys()) byField.set(field, [...(byField.get(field) ?? []), type]);
	const types = [...allowed.keys()];
	const fuzzy = token.maxEdits > 0 ? { fuzzy: { maxEdits: token.maxEdits, maxExpansions: 50 } } : {};
	/** @type {Array<Record<string, unknown>>} */
	const should = [];
	for (const [field, fieldTypes] of [...byField].sort(([a], [b]) => a.localeCompare(b))) {
		const weight = weightOf(ranking, field);
		if (weight <= 0) continue;
		/** @param {Record<string, unknown>} clause */
		const scoped = (clause) =>
			fieldTypes.length === types.length
				? clause
				: { compound: { filter: [{ in: { path: 'type', value: fieldTypes } }], must: [clause] } };
		should.push(
			scoped({ text: { query: token.term, path: `fields.${field}`, ...fuzzy, score: { boost: { value: weight } } } }),
		);
		if (token.synonyms.length > 0)
			should.push(
				scoped({
					text: { query: [...token.synonyms], path: `fields.${field}`, score: { boost: { value: weight * 0.9 } } },
				}),
			);
	}
	if (token.prefix) {
		const prefixWeight = Math.max(
			0,
			...[...allowed.values()].flatMap((fields) =>
				[...fields].filter(([, options]) => options.prefix).map(([field]) => weightOf(ranking, field)),
			),
		);
		if (prefixWeight > 0)
			should.push({
				autocomplete: {
					query: token.term,
					path: 'suggest',
					...(token.maxEdits > 0 ? { fuzzy: { maxEdits: 1, prefixLength: 1 } } : {}),
					score: { boost: { value: prefixWeight * 0.7 } },
				},
			});
	}
	return { compound: { should, minimumShouldMatch: 1 } };
};

/**
 * The `$search` pipeline of a query. Tenant (`websiteId`), visibility (`status`) and document types are filters of
 * the search itself; a `$match` on `websiteId` follows as a second guard.
 * @param {{ websiteId: string, plan: import('./query.js').QueryPlan, allowed: Map<string, Map<string, { prefix: boolean }>>,
 *   ranking: import('./query.js').Ranking, limit: number, mode: 'all' | 'any', index?: string }} input
 * @returns {Array<Record<string, unknown>>}
 */
export const atlasPipeline = ({ websiteId, plan, allowed, ranking, limit, mode, index = ATLAS_INDEX }) => {
	const clauses = plan.tokens.map((token) => tokenClause(token, allowed, ranking));
	/** @type {Array<Record<string, unknown>>} */
	const filter = [
		{ equals: { path: 'websiteId', value: websiteId } },
		{ equals: { path: 'status', value: 'active' } },
		{ in: { path: 'type', value: [...allowed.keys()] } },
	];
	return [
		{
			$search: {
				index,
				compound: {
					filter,
					...(mode === 'all' ? { must: clauses } : { should: clauses, minimumShouldMatch: 1 }),
				},
			},
		},
		{ $match: { websiteId } },
		{ $limit: limit },
		{ $project: { ...HIT_PROJECTION, score: { $meta: 'searchScore' } } },
	];
};

/**
 * True when a `$search` pipeline pins one website inside the search (compound filter) and in the next `$match`.
 * @param {Array<Record<string, any>>} pipeline
 * @param {string} websiteId
 */
export const pinsTenant = (pipeline, websiteId) => {
	const [search, match] = pipeline;
	const filters = search?.$search?.compound?.filter;
	return (
		typeof websiteId === 'string' &&
		websiteId !== '' &&
		Array.isArray(filters) &&
		filters.some((f) => f?.equals?.path === 'websiteId' && f.equals.value === websiteId) &&
		match?.$match?.websiteId === websiteId
	);
};

/** Atlas engine states shown in the dashboard. */
export const ATLAS_STATES = Object.freeze(
	/** @type {const} */ (['unknown', 'unavailable', 'permission_denied', 'missing', 'building', 'ready', 'failed']),
);

/**
 * What an Atlas error means: no Atlas Search on this deployment, missing permissions, or a failure.
 * @param {unknown} error
 * @returns {'unavailable' | 'permission_denied' | 'failed'}
 */
export const classifyAtlasError = (error) => {
	const e = /** @type {{ code?: unknown, codeName?: unknown, message?: unknown }} */ (error ?? {});
	const code = typeof e.code === 'number' ? e.code : null;
	const name = typeof e.codeName === 'string' ? e.codeName : '';
	const message = typeof e.message === 'string' ? e.message : '';
	if (code === 13 || name === 'Unauthorized' || /not authori[sz]ed|unauthori[sz]ed|requires authentication/i.test(message))
		return 'permission_denied';
	if (
		[59, 115, 31082, 40324, 6047401].includes(code ?? -1) ||
		['CommandNotFound', 'CommandNotSupported', 'SearchNotEnabled'].includes(name) ||
		/atlas|search ?index|\$listSearchIndexes|\$search|mongot|unrecognized pipeline stage/i.test(message)
	)
		return 'unavailable';
	return 'failed';
};

/**
 * State of the product's search index from `listSearchIndexes()`.
 * @param {Array<Record<string, any>>} listed
 * @param {string} [name]
 * @returns {'missing' | 'building' | 'ready' | 'failed'}
 */
export const indexStateOf = (listed, name = ATLAS_INDEX) => {
	const entry = listed.find((item) => item?.name === name);
	if (!entry) return 'missing';
	if (entry.queryable === true) return 'ready';
	if (entry.status === 'FAILED') return 'failed';
	return 'building';
};
