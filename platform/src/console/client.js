'use client';
/**
 * Browser API client: every console action is a `fetch` to the Portal's public `/v1/*` API (same origin). Cookie
 * sessions are CSRF-safe by construction (PLAN infra rules): the browser sends `Sec-Fetch-Site: same-origin` and an
 * `Origin` equal to the Portal origin on mutations, bodies are JSON only, cookies are `SameSite=Lax`. POSTs carry a
 * fresh `Idempotency-Key` (a retry of the same action re-uses it only when the caller passes one explicitly).
 * @module
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { networkProblem } from '@ss/ui/problems';

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
 * Run an API action with a busy flag and its last problem.
 * @template {unknown[]} A
 * @template R
 * @param {(...args: A) => Promise<ApiResult<R>>} action
 */
export const useAction = (action) => {
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const ref = useRef(action);
	ref.current = action;
	const run = useCallback(async (/** @type {A} */ ...args) => {
		setBusy(true);
		setProblem(null);
		try {
			const result = await ref.current(...args);
			if (!result.ok) setProblem(result.problem);
			return result;
		} finally {
			setBusy(false);
		}
	}, []);
	const reset = useCallback(() => setProblem(null), []);
	return { run, busy, problem, reset };
};

/**
 * Value of `#token=…` in the URL fragment (e-mail links carry tokens there so they never reach servers or logs);
 * removes the fragment from the address bar once read.
 * @returns {string | null}
 */
export const takeFragmentToken = () => {
	if (typeof window === 'undefined') return null;
	const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
	const token = params.get('token');
	if (token && window.history?.replaceState)
		window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
	return token;
};
