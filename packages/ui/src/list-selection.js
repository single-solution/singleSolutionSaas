'use client';
/**
 * The picked item of a list page (`ListColumn`) lives in the address as `?<param>=<id>`: a picked item can be linked to,
 * reloaded, and the browser's Back button goes back to the one picked before. Picking pushes a history entry (the rest
 * of the address stays as it is, and so does the history state, so the router's own bookkeeping is not touched);
 * `popstate` (Back, Forward) reads the address again. With no id in the address the first id is picked (or `initial`),
 * so the right side of a list page is never empty.
 * @module
 */
import { useCallback, useLayoutEffect, useState } from 'react';

/** What the address says: the id, and whether the person put the pick away on purpose (`select(null)`). */
/** @typedef {{ id: string | null, cleared: boolean }} Address */

/** The history-state mark of an entry where the pick was put away on purpose, per parameter. @param {string} param */
const markOf = (param) => `ssListCleared:${param}`;

/** @param {string} param @returns {Address} */
const readAddress = (param) => {
	const id = new URLSearchParams(window.location.search).get(param);
	const state = /** @type {Record<string, unknown> | null} */ (window.history.state);
	return { id: id === null || id === '' ? null : id, cleared: id === null && Boolean(state?.[markOf(param)]) };
};

/**
 * The id that is picked: the one in the address when it is a known id (or while the ids are still on the way), else
 * `initial`, else the first id. `initial: null` and a pick put away with `select(null)` leave it unpicked (a phone starts
 * on the list).
 * @param {Address} address
 * @param {string[]} known
 * @param {string | number | null | undefined} initial
 * @returns {string | null}
 */
const pick = (address, known, initial) => {
	if (address.id !== null && (known.length === 0 || known.includes(address.id))) return address.id;
	if (address.cleared || initial === null) return null;
	const start = initial === undefined ? undefined : String(initial);
	if (start !== undefined && known.includes(start)) return start;
	return known[0] ?? null;
};

/**
 * Keep the picked id of a list in the address. Returns `[selected, select]`: the picked id (a string; `null` while there
 * are no ids yet, or when the pick was put away) and a function that picks an id (`null` puts the pick away, for the Back
 * button of a phone) and pushes a history entry.
 * @param {{ ids: Array<string | number>, param?: string, initial?: string | number | null }} options `ids`: the ids of
 *   the rows that are shown, in order; `param`: the name in the address (`id` by default); `initial`: the id to pick when
 *   the address has none (the first by default; `null` for none)
 * @returns {[string | null, (id: string | number | null) => void]}
 */
export function useListSelection({ ids, param = 'id', initial }) {
	const [address, setAddress] = useState(/** @type {Address} */ ({ id: null, cleared: false }));
	const known = ids.map(String);
	const selected = pick(address, known, initial);

	// read the address in the browser (the server and the first draw have none), when the parameter changes, and on Back and Forward
	useLayoutEffect(() => {
		const read = () => setAddress(readAddress(param));
		read();
		window.addEventListener('popstate', read);
		return () => window.removeEventListener('popstate', read);
	}, [param]);

	const select = useCallback(
		/** @param {string | number | null} id */
		(id) => {
			const next = id === null ? null : String(id);
			const url = new URL(window.location.href);
			if (next === null) url.searchParams.delete(param);
			else url.searchParams.set(param, next);
			const target = `${url.pathname}${url.search}${url.hash}`;
			const state = /** @type {Record<string, unknown> | null} */ (window.history.state);
			if (target !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
				window.history.pushState(next === null ? { ...state, [markOf(param)]: true } : state, '', target);
			}
			setAddress({ id: next, cleared: next === null });
		},
		[param],
	);

	return [selected, select];
}
