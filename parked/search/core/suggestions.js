/**
 * Suggestions (pure): popular queries (only those searched at least `popular_min_count` times, so a rare — possibly
 * personal — query is never shown to other visitors), completions of the last word from the public vocabulary, and
 * recently updated documents. The visitor's own recent searches never reach the server: the headless core keeps them
 * in the visitor's browser.
 * @module
 */
import { normalise, tokenize } from './text.js';

/**
 * @param {{ query: string, popular: Array<{ q: string, searches: number }>, completions: Array<{ term: string, pdf: number }>,
 *   recent: Array<import('./schema.js').Hit>, settings: Record<string, any> }} input
 */
export const suggestionsOf = ({ query, popular, completions, recent, settings }) => {
	const text = normalise(query);
	const words = tokenize(text);
	const last = words.at(-1) ?? '';
	const head = text.endsWith(last) ? text.slice(0, text.length - last.length).trimEnd() : text;
	const popularList = settings.popular
		? popular
				.filter(
					(row) => row.searches >= settings.popular_min_count && row.q !== text && (text === '' || row.q.includes(text)),
				)
				.sort((a, b) => b.searches - a.searches || a.q.localeCompare(b.q))
				.slice(0, settings.popular_limit)
				.map((row) => ({ text: row.q }))
		: [];
	const completionList =
		settings.completions && last !== ''
			? completions
					.filter((entry) => entry.term.startsWith(last) && entry.term !== last && entry.pdf > 0)
					.sort((a, b) => b.pdf - a.pdf || a.term.localeCompare(b.term))
					.slice(0, settings.completions_limit)
					.map((entry) => ({ text: head ? `${head} ${entry.term}` : entry.term }))
			: [];
	return {
		query: text,
		popular: popularList,
		completions: completionList,
		recent: settings.recent_documents
			? recent.slice(0, settings.recent_limit).map((hit) => ({ id: hit.id, type: hit.type, title: hit.title, url: hit.url }))
			: [],
	};
};
