'use client';
/**
 * Browser API client of the Admin Console: the console's `apiFetch` (same-origin `/v1/*`, JSON only, CSRF-safe
 * cookie session, fresh `Idempotency-Key` per POST) with the staff sign-in page as the 401 destination, and raw
 * uploads of pack assets.
 * @module
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { networkProblem } from '@ss/ui/problems';
import { apiFetch } from '../client.js';
import { adminRoutes } from './paths.js';

/** @typedef {import('@ss/ui/problems').Problem} Problem */
/**
 * @template [T=any]
 * @typedef {import('../client.js').ApiResult<T>} ApiResult
 */

/**
 * The staff session expired: back to the staff sign-in page, then here again.
 * @param {string} [next]
 */
export const staffSignInAgain = (next) => {
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
	if (!result.ok && result.status === 401 && redirectOn401) staffSignInAgain();
	return result;
};

/**
 * `PUT` raw bytes (a pack asset) with the staff cookie session: same-origin, so the browser's `Origin` /
 * `Sec-Fetch-Site` headers satisfy the Portal's CSRF check exactly as {@link adminFetch} does.
 * @param {string} path
 * @param {Blob} bytes
 * @param {string} [contentType] defaults to the blob's type
 * @returns {Promise<ApiResult>}
 */
export const adminUpload = async (path, bytes, contentType) => {
	/** @type {Response} */
	let response;
	try {
		response = await fetch(path, {
			method: 'PUT',
			headers: { accept: 'application/json', 'content-type': contentType || bytes.type || 'application/octet-stream' },
			credentials: 'same-origin',
			cache: 'no-store',
			body: bytes,
		});
	} catch (error) {
		return { ok: false, status: 0, problem: networkProblem(error) };
	}
	/** @type {any} */
	const data = await response.json().catch(() => null);
	if (response.ok) return { ok: true, status: response.status, data };
	if (response.status === 401) staffSignInAgain();
	return {
		ok: false,
		status: response.status,
		problem: {
			status: response.status,
			...(data && typeof data === 'object' ? data : { title: response.statusText || 'Error' }),
		},
	};
};

/**
 * A resource loaded on the server (`initial`) and re-fetched after mutations (staff 401 → staff sign-in).
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
