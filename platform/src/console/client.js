'use client';
/**
 * Browser API client: every console action is a `fetch` to the Portal's public `/v1/*` API (same origin). Cookie
 * sessions are CSRF-safe by construction (PLAN infra rules): the browser sends `Sec-Fetch-Site: same-origin` and an
 * `Origin` equal to the Portal origin on mutations, bodies are JSON only, cookies are `SameSite=Lax`. POSTs carry a
 * fresh `Idempotency-Key` (a retry of the same action re-uses it only when the caller passes one explicitly).
 * @module
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { networkProblem, problemCode } from '@ss/ui/problems';

/** @typedef {import('@ss/ui/problems').Problem} Problem */
/**
 * @template [T=any]
 * @typedef {{ ok: true, status: number, data: T } | { ok: false, status: number, problem: Problem }} ApiResult
 */

/** @returns {string} */
const newKey = () =>
	typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
		? crypto.randomUUID()
		: `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/**
 * Called when a signed-in call answers 401 (session expired): go to the sign-in page and come back afterwards.
 * @param {string} [next]
 */
export const signInAgain = (next) => {
	if (typeof window === 'undefined') return;
	const back = next ?? `${window.location.pathname}${window.location.search}`;
	window.location.assign(`/login?next=${encodeURIComponent(back)}&expired=1`);
};

/**
 * @template [T=any]
 * @param {string} path `/v1/...`
 * @param {{ method?: string, body?: unknown, idempotencyKey?: string, signal?: AbortSignal, redirectOn401?: boolean }} [init]
 * @returns {Promise<ApiResult<T>>}
 */
export const apiFetch = async (path, { method = 'GET', body, idempotencyKey, signal, redirectOn401 = true } = {}) => {
	/** @type {Record<string, string>} */
	const headers = { accept: 'application/json' };
	if (body !== undefined) headers['content-type'] = 'application/json';
	if (method === 'POST') headers['idempotency-key'] = idempotencyKey ?? newKey();
	/** @type {Response} */
	let response;
	try {
		response = await fetch(path, {
			method,
			headers,
			credentials: 'same-origin',
			cache: 'no-store',
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			...(signal ? { signal } : {}),
		});
	} catch (error) {
		return { ok: false, status: 0, problem: networkProblem(error) };
	}
	const text = await response.text().catch(() => '');
	/** @type {any} */
	let data = null;
	if (text) {
		try {
			data = JSON.parse(text);
		} catch {
			data = null;
		}
	}
	if (response.ok) return { ok: true, status: response.status, data };
	if (response.status === 401 && redirectOn401) signInAgain();
	const problem = data && typeof data === 'object' ? data : { title: response.statusText || 'Error' };
	return { ok: false, status: response.status, problem: { status: response.status, ...problem } };
};

/**
 * A call that checks the signed-in person's password or code (a fresh confirmation, changing the password or the email,
 * two-step): a wrong one also answers 401 though the session is fine, so only an ended session (`unauthorized`) goes to
 * the sign-in page, and a wrong password stays on the form that asked.
 * @template [T=any]
 * @param {string} path `/v1/...`
 * @param {{ method?: string, body?: unknown }} [init]
 * @returns {Promise<ApiResult<T>>}
 */
export const apiConfirm = async (path, init = {}) => {
	const result = await apiFetch(path, { ...init, redirectOn401: false });
	if (!result.ok && problemCode(result.problem) === 'unauthorized') signInAgain();
	return result;
};

/**
 * A resource loaded on the server (`initial`) and re-fetched in the browser after mutations.
 * @template T
 * @param {string | null} path GET path (null = not loadable, `reload` is a no-op)
 * @param {T} initial
 * @param {{ problem?: Problem | null }} [options]
 */
export const useResource = (path, initial, { problem: initialProblem = null } = {}) => {
	const [data, setData] = useState(initial);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (initialProblem));
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
		const result = await apiFetch(path);
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
 * A cursor-paginated list (`{ items, nextCursor }`): the page loaded on the server, then Load more appends the next.
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
		const result = await apiFetch(path);
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
		more: () => (cursor ? load(cursor) : Promise.resolve()),
	};
};

/**
 * Value of `#token=…` (or another name, such as a share link's `#key=…`) in the URL fragment: email and share links
 * carry their secret there so it never reaches servers or logs. Removes the fragment from the address bar once read.
 * @param {string} [name]
 * @returns {string | null}
 */
export const takeFragmentToken = (name = 'token') => {
	if (typeof window === 'undefined') return null;
	const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
	const token = params.get(name);
	if (token && window.history?.replaceState)
		window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
	return token;
};
