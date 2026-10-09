'use client';
/**
 * Browser calls to the kit's dashboard API (`/v1/dashboard/*`, session cookie; writes carry this page's Origin).
 * @module
 */
import { startTransition, useCallback, useEffect, useState } from 'react';
import { useNavigationProgress } from '@ss/ui';

/** @typedef {{ ok: true, data: any } | { ok: false, problem: any }} Answer */

/**
 * @param {'GET' | 'PUT' | 'POST' | 'DELETE'} method
 * @param {string} path
 * @param {unknown} [body]
 * @returns {Promise<Answer>}
 */
export const call = async (method, path, body) => {
	try {
		const response = await fetch(path, {
			method,
			credentials: 'same-origin',
			...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
		});
		const data = response.status === 204 ? null : await response.json().catch(() => null);
		return response.ok ? { ok: true, data } : { ok: false, problem: data ?? { status: response.status } };
	} catch {
		return { ok: false, problem: { status: 503, title: 'The product cannot be reached.' } };
	}
};

/**
 * The last answer of each resource this page loaded (in this browser tab only): a section opened again shows it at
 * once while it is fetched again.
 * @type {Map<string, Answer>}
 */
const answers = new Map();

/**
 * Load a dashboard resource: its last answer shows at once (or a skeleton, with the progress bar, the first time) and
 * is refreshed in the background every time the section opens; `reload()` fetches it again (the last answer stays
 * shown meanwhile).
 * @param {string | null} path null loads nothing
 * @returns {{ answer: Answer | null, reload: () => void }}
 */
export const useLoad = (path) => {
	const [shown, setShown] = useState(
		/** @type {{ path: string | null, answer: Answer | null }} */ ({
			path,
			answer: path === null ? null : (answers.get(path) ?? null),
		}),
	);
	const [round, setRound] = useState(0);
	// another resource: its last answer (or nothing) until its fetch ends
	const current = shown.path === path ? shown : { path, answer: path === null ? null : (answers.get(path) ?? null) };
	if (current !== shown) setShown(current);
	useNavigationProgress(path !== null && current.answer === null);
	useEffect(() => {
		let live = true;
		if (path !== null)
			void call('GET', path).then((next) => {
				answers.set(path, next);
				// a transition, so content that replaces a skeleton animates in (React ViewTransition)
				if (live) startTransition(() => setShown({ path, answer: next }));
			});
		return () => {
			live = false;
		};
	}, [path, round]);
	const reload = useCallback(() => setRound((n) => n + 1), []);
	return { answer: current.answer, reload };
};

/**
 * Fill `{name}` placeholders of a dashboard text.
 * @param {string} text
 * @param {Record<string, string | number>} values
 */
export const fill = (text, values) =>
	text.replace(/\{(\w+)\}/g, (match, key) => (Object.hasOwn(values, key) ? String(values[key]) : match));
