/**
 * The pluggable search engine. Both engines take the same query plan and return candidates `{ doc, score }` that the
 * search service ranks and shapes identically:
 *
 * - **atlas** — MongoDB Atlas Search on the merchant's database (`$search` with the product-managed index), used when
 *   `index.engine` is `auto` or `atlas` and the index is ready. The state is probed at most every 10 minutes per
 *   website when a search needs it (and by the dashboard re-check), stored for the dashboard, and a failing `$search` falls back to the portable
 *   engine for a cooldown instead of failing the visitor's search.
 * - **portable** — the product's own engine on any MongoDB: vocabulary lookups (exact, prefix range scan, trigram
 *   typo candidates checked with a bounded edit distance), one indexed candidate query over the multikey `terms`
 *   index, scoring in `core/portable.js`. Always kept up to date, so it can answer at any time.
 */
import { atlasPipeline } from '../core/atlas.js';
import { candidateTerms, expandTokens, idf, scoreDocuments } from '../core/portable.js';
import { ensureAtlasIndex, rawCollection, runSearch } from '../adapters/atlas.js';

/** How long an Atlas state is trusted. */
export const ATLAS_CHECK_MS = 10 * 60_000;
/** How long the portable engine answers after a failed `$search`. */
export const ATLAS_COOLDOWN_MS = 5 * 60_000;
/** How long a website's document count (for idf) is cached. */
const COUNT_TTL_MS = 5 * 60_000;
/** Typo candidates read per word. */
const TYPO_SCAN = 50;

/**
 * @typedef {import('./documents.js').Site} Site
 * @typedef {{ candidates: Array<{ doc: Record<string, any>, score: number }>, relaxed: boolean, capped: boolean, engine: 'atlas' | 'portable' }} EngineResult
 * @typedef {{ owner: boolean, allowed: Map<string, Map<string, { prefix: boolean }>>, limit: number }} EngineQuery
 */

/**
 * @param {{ now: () => number, log?: { warn?: Function } | null, atlasRunner?: typeof runSearch, atlasProbe?: typeof ensureAtlasIndex }} deps
 *   `atlasRunner` / `atlasProbe` replace the driver calls in tests (Atlas Search does not run in mongodb-memory-server)
 */
export const createEngines = ({ now, log = null, atlasRunner = runSearch, atlasProbe = ensureAtlasIndex }) => {
	/** @type {Map<string, { status: import('../adapters/atlas.js').AtlasStatus, checkedAt: number, cooldownUntil: number }>} */
	const atlas = new Map();
	/** @type {Map<string, { count: number, at: number }>} */
	const counts = new Map();

	/** @param {Site} site */
	const raw = (site) => rawCollection(site.repos.documents.guarded, site.websiteId);

	/**
	 * The Atlas state of a website (probing and creating the index when due).
	 * @param {Site} site
	 * @param {{ refresh?: boolean }} [options]
	 * @returns {Promise<import('../adapters/atlas.js').AtlasStatus & { checkedAt: string | null }>}
	 */
	const atlasStatus = async (site, { refresh = false } = {}) => {
		const cached = atlas.get(site.websiteId);
		if (!refresh && cached && now() - cached.checkedAt < ATLAS_CHECK_MS)
			return { ...cached.status, checkedAt: new Date(cached.checkedAt).toISOString() };
		/** @type {import('../adapters/atlas.js').AtlasStatus} */
		let status;
		try {
			status = await atlasProbe(raw(site));
		} catch {
			status = { state: 'failed', detail: 'probe_failed' };
		}
		atlas.set(site.websiteId, { status, checkedAt: now(), cooldownUntil: cached?.cooldownUntil ?? 0 });
		await site.repos.engine
			.set({ state: status.state, detail: status.detail, definition: status.definition ?? null, checkedAt: new Date(now()) })
			.catch(() => undefined);
		return { ...status, checkedAt: new Date(now()).toISOString() };
	};

	/**
	 * Documents in the index (cached) for the inverse document frequency.
	 * @param {Site} site
	 */
	const total = async (site) => {
		const cached = counts.get(site.websiteId);
		if (cached && now() - cached.at < COUNT_TTL_MS) return cached.count;
		const count = await site.repos.documents.count({ status: 'active' });
		counts.set(site.websiteId, { count, at: now() });
		return count;
	};

	/**
	 * The portable engine.
	 * @param {Site} site
	 * @param {import('../core/query.js').QueryPlan} plan
	 * @param {EngineQuery} query
	 * @returns {Promise<EngineResult>}
	 */
	const portable = async (site, plan, { owner, allowed, limit }) => {
		const vocabulary = site.repos.vocabulary;
		const publicOnly = !owner;
		const exact = await vocabulary.lookup([...new Set(plan.tokens.flatMap((t) => [t.term, ...t.synonyms]))]);
		/** @type {Map<string, { df: number, pdf: number }>} */
		const known = new Map(exact.map((entry) => [entry.term, entry]));
		const visible = (/** @type {string} */ term) => {
			const entry = known.get(term);
			return entry ? (owner ? entry.df : entry.pdf) > 0 : false;
		};
		const prefixes = await Promise.all(
			plan.tokens.map((token) => (token.prefix ? vocabulary.prefixed(token.term, { publicOnly }) : Promise.resolve([]))),
		);
		const typos = await Promise.all(
			plan.tokens.map((token) =>
				token.maxEdits > 0 && !visible(token.term)
					? vocabulary.similar(token.term, token.maxEdits, { publicOnly, limit: TYPO_SCAN, prefix: token.prefix })
					: Promise.resolve([]),
			),
		);
		for (const entry of [...prefixes.flat(), ...typos.flat()]) if (!known.has(entry.term)) known.set(entry.term, entry);
		const expanded = expandTokens(plan, { prefixes, typos }, { owner });
		const documents = await total(site);
		const docs = await site.repos.documents.candidates({ terms: candidateTerms(expanded), types: [...allowed.keys()], limit });
		const { scored, relaxed } = scoreDocuments(docs, expanded, {
			allowed,
			ranking: site.settings.rank,
			weightOfTerm: (term) => idf(owner ? (known.get(term)?.df ?? 0) : (known.get(term)?.pdf ?? 0), documents),
			mode: plan.mode,
		});
		return {
			candidates: scored.map(({ doc, score }) => ({ doc, score })),
			relaxed,
			capped: docs.length >= limit,
			engine: 'portable',
		};
	};

	/**
	 * The Atlas engine (throws on driver errors; the caller falls back).
	 * @param {Site} site
	 * @param {import('../core/query.js').QueryPlan} plan
	 * @param {EngineQuery} query
	 * @returns {Promise<EngineResult>}
	 */
	const atlasSearch = async (site, plan, { allowed, limit }) => {
		const collection = raw(site);
		const run = (/** @type {'all' | 'any'} */ mode) =>
			atlasRunner(
				collection,
				atlasPipeline({ websiteId: site.websiteId, plan, allowed, ranking: site.settings.rank, limit, mode }),
				site.websiteId,
			);
		let rows = await run(plan.mode === 'any' ? 'any' : 'all');
		let relaxed = false;
		if (rows.length === 0 && plan.mode === 'all_then_any' && plan.tokens.length > 1) {
			rows = await run('any');
			relaxed = rows.length > 0;
		}
		return {
			candidates: rows.map((row) => ({ doc: row, score: typeof row.score === 'number' ? row.score : 0 })),
			relaxed,
			capped: rows.length >= limit,
			engine: 'atlas',
		};
	};

	/**
	 * Search with the engine the website's settings and its database allow.
	 * @param {Site} site
	 * @param {import('../core/query.js').QueryPlan} plan
	 * @param {EngineQuery} query
	 * @returns {Promise<EngineResult>}
	 */
	const search = async (site, plan, query) => {
		if (site.settings.index.engine !== 'portable') {
			const status = await atlasStatus(site);
			const entry = atlas.get(site.websiteId);
			if (status.state === 'ready' && (entry?.cooldownUntil ?? 0) <= now()) {
				try {
					return await atlasSearch(site, plan, query);
				} catch (error) {
					if (entry) entry.cooldownUntil = now() + ATLAS_COOLDOWN_MS;
					log?.warn?.('atlas search failed; portable engine until the cooldown ends', {
						websiteId: site.websiteId,
						code: /** @type {any} */ (error)?.codeName ?? /** @type {any} */ (error)?.code ?? 'error',
					});
				}
			}
		}
		return portable(site, plan, query);
	};

	return {
		search,
		portable,
		atlasSearch,
		atlasStatus,
		/** Forget cached state (tests, entitlement changes). @param {string} websiteId */
		forget: (websiteId) => {
			atlas.delete(websiteId);
			counts.delete(websiteId);
		},
	};
};

/** @typedef {ReturnType<typeof createEngines>} Engines */
