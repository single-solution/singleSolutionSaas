/**
 * Knowledge service: FAQ entries and web pages indexed into chunks in the merchant database, and BM25 search. Pages
 * are fetched through the kit's SSRF guard (adapters/outbound.js); the pure parts (HTML → text, chunking, ranking)
 * are core/knowledge.js.
 */
import { faqChunks, htmlToText, pageChunks, passages, queryTerms, rank } from '../core/knowledge.js';

/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./service.js').Deps} Deps */

/** Candidate chunks loaded per search (the index narrows them to chunks sharing a term). */
export const CANDIDATE_LIMIT = 400;

/**
 * @param {Deps} deps
 */
export const createKnowledge = (deps) => {
	const { hash, now } = deps;
	/** @param {Site} site @param {Record<string, any>} entry */
	const indexEntry = async (site, entry) => {
		const k = site.settings.knowledge;
		const priority = (k?.faq_priority ?? 0) + (Number.isInteger(entry.priority) ? entry.priority : 0);
		const chunks =
			entry.enabled === false || entry.deletedAt
				? []
				: faqChunks(/** @type {any} */ (entry), { priority }).map((chunk, index) => ({
						...chunk,
						id: `kbc_${hash(`faq:${entry.id}:${index}`)}`,
					}));
		await site.repos.chunks.replace('faq', entry.id, chunks);
		return chunks.length;
	};

	/**
	 * Fetch one configured page and replace its chunks.
	 * @param {Site} site
	 * @param {{ id: string, url: string, title?: string, priority?: number }} source
	 * @returns {Promise<{ ok: true, chunks: number, title: string } | { ok: false, code: string }>}
	 */
	const refreshSource = async (site, source) => {
		const k = site.settings.knowledge;
		if (!k) return { ok: false, code: 'element_disabled' };
		const at = new Date(now()).toISOString();
		/** @type {{ status: number, headers: any, body: Buffer }} */
		let response;
		try {
			response = await deps.outbound.fetch(source.url, {
				method: 'GET',
				headers: { accept: 'text/html, text/plain, text/markdown;q=0.9, */*;q=0.1' },
				timeoutMs: k.fetch_timeout_ms,
				maxBytes: k.fetch_max_bytes,
				redirect: 'follow',
			});
		} catch (error) {
			const code = String(/** @type {any} */ (error)?.code ?? 'network');
			await site.repos.sources.save(source.id, {
				id: source.id,
				url: source.url,
				status: 'failed',
				error: code,
				checkedAt: at,
			});
			return { ok: false, code };
		}
		if (response.status < 200 || response.status > 299) {
			await site.repos.sources.save(source.id, {
				id: source.id,
				url: source.url,
				status: 'failed',
				error: `http_${response.status}`,
				checkedAt: at,
			});
			return { ok: false, code: `http_${response.status}` };
		}
		const type = String(
			(typeof response.headers?.get === 'function'
				? response.headers.get('content-type')
				: response.headers?.['content-type']) ?? '',
		);
		const raw = response.body.toString('utf8');
		const page = /html|xml/i.test(type) || /^\s*</.test(raw) ? htmlToText(raw) : { title: '', text: raw };
		const title = source.title || page.title || source.url;
		const chunks = pageChunks(
			{ id: source.id, url: source.url, title, text: page.text, priority: source.priority ?? 0 },
			{ size: k.chunk_chars, overlap: k.chunk_overlap_chars, max: k.max_chunks_per_source },
		).map((chunk, index) => ({ ...chunk, id: `kbc_${hash(`page:${source.id}:${index}`)}` }));
		await site.repos.chunks.replace('page', source.id, chunks);
		await site.repos.sources.save(source.id, {
			id: source.id,
			url: source.url,
			title,
			status: 'ok',
			error: null,
			chunks: chunks.length,
			fetchedAt: at,
			checkedAt: at,
		});
		return { ok: true, chunks: chunks.length, title };
	};

	/**
	 * Search passages for a question.
	 * @param {Site} site
	 * @param {string} query
	 * @param {{ topK?: number }} [options]
	 */
	const search = async (site, query, { topK } = {}) => {
		const k = site.settings.knowledge;
		if (!k) return [];
		const terms = queryTerms(query);
		if (terms.length === 0) return [];
		const [chunks, stats] = await Promise.all([
			site.repos.chunks.candidates(terms, CANDIDATE_LIMIT),
			site.repos.chunks.stats(terms),
		]);
		const ranked = rank({ terms, chunks, stats, k1: k.bm25_k1, b: k.bm25_b, minMatch: k.min_match, topK: topK ?? k.top_k });
		return passages(ranked, { maxChars: k.chunk_chars });
	};

	/** Configured sources with their fetch state. @param {Site} site */
	const sources = async (site) => {
		const configured = Array.isArray(site.settings.knowledge?.sources) ? site.settings.knowledge.sources : [];
		const states = new Map((await site.repos.sources.all()).map((/** @type {any} */ s) => [s.id, s]));
		return configured.map((/** @type {any} */ source) => {
			const state = states.get(source.id);
			return {
				id: source.id,
				url: source.url,
				title: state?.title ?? source.title ?? null,
				priority: source.priority ?? 0,
				refreshHours: source.refresh_hours ?? 0,
				enabled: source.enabled !== false,
				status: state?.status ?? 'pending',
				chunks: state?.chunks ?? 0,
				fetchedAt: state?.fetchedAt ?? null,
				error: state?.error ?? null,
			};
		});
	};

	/**
	 * Sources due for a refresh (enabled, refresh_hours > 0 and older than that, or never fetched).
	 * @param {Site} site
	 */
	const dueSources = async (site) =>
		(await sources(site)).filter(
			(s) =>
				s.enabled &&
				(s.status === 'pending' ||
					(s.refreshHours > 0 && (!s.fetchedAt || now() - Date.parse(s.fetchedAt) >= s.refreshHours * 3_600_000))),
		);

	return Object.freeze({ indexEntry, refreshSource, search, sources, dueSources });
};

/** @typedef {ReturnType<typeof createKnowledge>} Knowledge */
