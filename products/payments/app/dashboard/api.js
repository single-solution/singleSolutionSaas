'use client';
/**
 * Browser calls to the kit's dashboard API (`/v1/dashboard/*`, session cookie; writes carry this page's Origin).
 * @module
 */
import { useCallback, useEffect, useState } from 'react';

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
 * Load a dashboard resource; `reload()` fetches it again (the last answer stays shown meanwhile).
 * @param {string | null} path null loads nothing
 * @returns {{ answer: Answer | null, reload: () => void }}
 */
export const useLoad = (path) => {
	const [answer, setAnswer] = useState(/** @type {Answer | null} */ (null));
	const [round, setRound] = useState(0);
	useEffect(() => {
		let live = true;
		if (path !== null)
			void call('GET', path).then((next) => {
				if (live) setAnswer(next);
			});
		return () => {
			live = false;
		};
	}, [path, round]);
	const reload = useCallback(() => setRound((n) => n + 1), []);
	return { answer, reload };
};

/**
 * Fill `{name}` placeholders of a dashboard text.
 * @param {string} text
 * @param {Record<string, string | number>} values
 */
export const fill = (text, values) =>
	text.replace(/\{(\w+)\}/g, (match, key) => (Object.hasOwn(values, key) ? String(values[key]) : match));
