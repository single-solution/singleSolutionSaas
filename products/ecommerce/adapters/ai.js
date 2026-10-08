/**
 * The merchant's AI provider for AI copy (PLAN 0.8.8: written with the merchant's own AI key): any OpenAI-compatible
 * service, from the `ai` connection `{ baseUrl, apiKey, model }`, called through `@ss/net` (no redirects, a deadline,
 * a body cap) with the injected `send`. The connection is tested when saved with a read-only call (its model list).
 * @module
 */
import { jsonOf } from '@ss/net';

/** Deadline of one writing call (ms). */
export const AI_TIMEOUT_MS = 30_000;

/** @typedef {{ baseUrl: string, apiKey: string, model: string }} AiConnection */
/** @typedef {(url: string, init?: import('@ss/net').SafeFetchInit) => Promise<import('@ss/net').SafeResponse>} Send */

/**
 * Check a connection value.
 * @param {unknown} value
 * @returns {{ ok: true, value: AiConnection } | { ok: false, message: string }}
 */
export const checkAiConnection = (value) => {
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		return { ok: false, message: 'Enter the base URL, the key and the model.' };
	const v = /** @type {Record<string, unknown>} */ (value);
	if (typeof v.baseUrl !== 'string' || !/^https:\/\/[^\s/]+(\/\S*)?$/.test(v.baseUrl.trim()))
		return { ok: false, message: 'Enter the https base URL of the service (for example https://api.openai.com/v1).' };
	if (typeof v.apiKey !== 'string' || v.apiKey.trim().length < 8) return { ok: false, message: 'Enter the API key.' };
	if (typeof v.model !== 'string' || !/^[\w./:@-]{1,120}$/.test(v.model.trim()))
		return { ok: false, message: 'Enter the model.' };
	return { ok: true, value: { baseUrl: v.baseUrl.trim().replace(/\/+$/, ''), apiKey: v.apiKey.trim(), model: v.model.trim() } };
};

/**
 * @param {{ send: Send }} options
 */
export const createAi = ({ send }) =>
	Object.freeze({
		send,
		/**
		 * The connection test: the value's shape, then a read-only call to the model list.
		 * @param {unknown} value
		 * @returns {Promise<{ ok: boolean, message?: string }>}
		 */
		test: async (value) => {
			const checked = checkAiConnection(value);
			if (!checked.ok) return { ok: false, message: checked.message };
			try {
				const response = await send(`${checked.value.baseUrl}/models`, {
					headers: { authorization: `Bearer ${checked.value.apiKey}` },
					redirect: 'error',
					timeoutMs: 10_000,
				});
				if (response.status === 401 || response.status === 403)
					return { ok: false, message: 'The provider refused the key.' };
				if (response.status < 200 || response.status > 299)
					return { ok: false, message: `The provider answered ${response.status}.` };
				return { ok: true };
			} catch {
				return { ok: false, message: 'The provider cannot be reached.' };
			}
		},
		/**
		 * Write text: one chat completion.
		 * @param {unknown} value the `ai` connection
		 * @param {{ system: string, prompt: string, maxTokens: number }} request
		 * @returns {Promise<{ ok: true, text: string } | { ok: false, code: 'not_connected' | 'rate_limited' | 'provider_error' }>}
		 */
		write: async (value, { system, prompt, maxTokens }) => {
			const checked = checkAiConnection(value);
			if (!checked.ok) return { ok: false, code: 'not_connected' };
			const { baseUrl, apiKey, model } = checked.value;
			try {
				const response = await send(`${baseUrl}/chat/completions`, {
					method: 'POST',
					headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
					body: JSON.stringify({
						model,
						messages: [
							{ role: 'system', content: system },
							{ role: 'user', content: prompt },
						],
						temperature: 0.7,
						max_tokens: maxTokens,
					}),
					redirect: 'error',
					timeoutMs: AI_TIMEOUT_MS,
					maxBytes: 2 * 1024 * 1024,
				});
				if (response.status < 200 || response.status > 299)
					return { ok: false, code: response.status === 429 ? 'rate_limited' : 'provider_error' };
				const content = /** @type {any} */ (jsonOf(response))?.choices?.[0]?.message?.content;
				return typeof content === 'string' && content.trim()
					? { ok: true, text: content }
					: { ok: false, code: 'provider_error' };
			} catch {
				return { ok: false, code: 'provider_error' };
			}
		},
	});

/** @typedef {ReturnType<typeof createAi>} Ai */
