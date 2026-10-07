'use client';
/**
 * Browser API client of the Admin Console: the console's `apiFetch` (same-origin `/v1/*`, JSON only, CSRF-safe
 * cookie session, fresh `Idempotency-Key` per POST) with the sign-in page as the 401 destination.
 * @module
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../client.js';
import { adminRoutes } from './paths.js';

/** @typedef {import('@ss/ui/problems').Problem} Problem */
/**
 * @template [T=any]
 * @typedef {import('../client.js').ApiResult<T>} ApiResult
 */

/**
 * The admin session ended: back to the sign-in page, then here again.
 * @param {string} [next]
 */
export const adminSignInAgain = (next) => {
	if (typeof window === 'undefined') return;
	const back = next ?? `${window.location.pathname}${window.location.search}`;
	window.location.assign(`${adminRoutes.login(back)}&expired=1`);
};

/**
 * @template [T=any]
 * @param {string} path
 * @param {{ method?: string, body?: unknown, idempotencyKey?: string, signal?: AbortSignal, redirectOn401?: boolean }} [init]
 * @returns {Promise<ApiResult<T>>}
 */
export const adminFetch = async (path, { redirectOn401 = true, ...init } = {}) => {
	const result = await apiFetch(path, { ...init, redirectOn401: false });
	if (!result.ok && result.status === 401 && redirectOn401) adminSignInAgain();
	return result;
};

/**
 * A resource loaded on the server (`initial`) and re-fetched after mutations (a 401 goes to the sign-in page).
 * @template T
 * @param {string | null} path
 * @param {T} initial
 */
export const useAdminResource = (path, initial) => {
	const [data, setData] = useState(initial);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [loading, setLoading] = useState(false);
	const live = useRef(true);
	useEffect(() => {
		live.current = true;
		return () => {
			live.current = false;
		};
	}, []);
	const reload = useCallback(async () => {
		if (!path) return null;
		setLoading(true);
		const result = await adminFetch(path);
		if (!live.current) return null;
		setLoading(false);
		if (result.ok) {
			setData(result.data);
			setProblem(null);
			return result.data;
		}
		setProblem(result.problem);
		return null;
	}, [path]);
	return { data, setData, problem, loading, reload };
};

/**
 * Cursor-paginated list: `items` + `nextCursor` from the server, "load more" appends the next page.
 * @param {(cursor: string | null) => string | null} pathOf GET path for a cursor (null = not loadable)
 * @param {{ items?: any[], nextCursor?: string | null } | null | undefined} initial
 */
export const usePagedList = (pathOf, initial) => {
	const [items, setItems] = useState(/** @type {any[]} */ (initial?.items ?? []));
	const [cursor, setCursor] = useState(/** @type {string | null} */ (initial?.nextCursor ?? null));
	const [loading, setLoading] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const ref = useRef(pathOf);
	ref.current = pathOf;
	const load = useCallback(async (/** @type {string | null} */ after = null) => {
		const path = ref.current(after);
		if (!path) return;
		setLoading(true);
		setProblem(null);
		const result = await adminFetch(path);
		setLoading(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		const page = /** @type {any} */ (result.data);
		setItems((list) => (after ? [...list, ...(page?.items ?? [])] : (page?.items ?? [])));
		setCursor(page?.nextCursor ?? null);
	}, []);
	return {
		items,
		cursor,
		loading,
		problem,
		reload: () => load(null),
		more: () => load(cursor),
	};
};
