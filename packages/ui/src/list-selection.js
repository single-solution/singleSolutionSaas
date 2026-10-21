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
	if (address.id !== null) return address.id;
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

/**
 * @typedef {object} RowSelection
 * @property {boolean} mode select mode is on
 * @property {(key?: string) => void} start turn select mode on (and select that row)
 * @property {() => void} done leave select mode and forget the selection
 * @property {(key: string) => void} toggle
 * @property {() => void} selectAll
 * @property {() => void} clear
 * @property {string[]} keys the keys of the selected rows (only rows that are still in the list)
 * @property {unknown[]} rows the selected rows
 * @property {number} count
 * @property {number} total
 * @property {boolean} allSelected
 * @property {(key: string) => boolean} isSelected
 * @property {(actions?: import('react').ReactNode) => { onStartSelect?: () => void, bulk?: import('./Toolbar.js').ToolbarBulk }} toolbar
 *   the Toolbar props for the current mode: the Select button, or the bulk bar with these actions
 */

/**
 * Select rows of a list: the state shared by the {@link ListColumn} (or {@link Toolbar}) and the row checks.
 * Records that leave the list drop out of the selection.
 * @template T
 * @param {T[]} rows the rows that can be selected (the ones on screen)
 * @param {(row: T) => string} rowKey
 * @returns {RowSelection}
 */
export function useRowSelection(rows, rowKey) {
	const [mode, setMode] = useState(false);
	const [chosen, setChosen] = useState(/** @type {Set<string>} */ (new Set()));
	const all = rows.map(rowKey);
	const keys = all.filter((key) => chosen.has(key));
	const picked = new Set(keys);
	/** @param {string} [key] */
	const start = (key) => {
		setMode(true);
		if (key !== undefined) setChosen(new Set([key]));
	};
	const done = () => {
		setMode(false);
		setChosen(new Set());
	};
	/** @param {string} key */
	const toggle = (key) =>
		setChosen((previous) => {
			const next = new Set(previous);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	const selectAll = () => setChosen(new Set(all));
	const clear = () => setChosen(new Set());
	const allSelected = all.length > 0 && keys.length === all.length;
	return {
		mode,
		start,
		done,
		toggle,
		selectAll,
		clear,
		keys,
		rows: rows.filter((row) => picked.has(rowKey(row))),
		count: keys.length,
		total: all.length,
		allSelected,
		isSelected: (key) => picked.has(key),
		toolbar: (actions) =>
			mode
				? { bulk: { count: keys.length, total: all.length, allSelected, actions, onSelectAll: selectAll, onDone: done } }
				: all.length > 0
					? { onStartSelect: () => start() }
					: {},
	};
}
