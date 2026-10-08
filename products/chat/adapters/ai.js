/**
 * The AI providers (PLAN 0.8.3 AI): Chat calls the provider directly with the merchant's own key from Connections,
 * through `@ss/net` (no redirects, a deadline, a body cap). Requests are built and answers parsed by core/providers.js.
 * A connection is tested when saved with a read-only call (its model list).
 * @module
 */
import { jsonOf } from '@ss/net';
import { PROVIDER_BASE, checkAiConnection } from '../core/models.js';
import { WIRE } from '../core/providers.js';

/** Deadline of one AI call (ms). */
export const AI_TIMEOUT_MS = 25_000;

/** @typedef {import('../core/models.js').AiConnection} AiConnection */
/** @typedef {import('../core/providers.js').ChatMessage} ChatMessage */
/** @typedef {import('../core/providers.js').ToolSchema} ToolSchema */
/** @typedef {import('../core/providers.js').ChatResult} ChatResult */
/** @typedef {(url: string, init?: import('@ss/net').SafeFetchInit) => Promise<import('@ss/net').SafeResponse>} Send */

/**
 * The base address and the authentication headers of a connection.
 * @param {AiConnection} connection
 * @returns {{ base: string, headers: Record<string, string> }}
 */
export const endpointOf = (connection) => {
	if (connection.provider === 'anthropic')
		return { base: PROVIDER_BASE.anthropic, headers: { 'x-api-key': connection.apiKey, 'anthropic-version': '2023-06-01' } };
	if (connection.provider === 'google') return { base: PROVIDER_BASE.google, headers: { 'x-goog-api-key': connection.apiKey } };
	return {
		base: connection.provider === 'compatible' ? /** @type {string} */ (connection.baseUrl) : PROVIDER_BASE.openai,
		headers: { authorization: `Bearer ${connection.apiKey}` },
	};
};

/**
 * @param {{ send: Send }} deps
 */
export const createAi = ({ send }) =>
	Object.freeze({
		/**
		 * One completion.
		 * @param {AiConnection} connection
		 * @param {{ messages: ChatMessage[], tools: ToolSchema[], temperature: number, maxTokens: number }} request
		 * @returns {Promise<{ ok: true, value: ChatResult } | { ok: false, code: string }>}
		 */
		chat: async (connection, request) => {
			const wire = WIRE[connection.provider];
			const built = wire.build({ model: connection.model, ...request });
			const { base, headers } = endpointOf(connection);
			try {
				const response = await send(`${base}${built.path}`, {
					method: 'POST',
					headers: { ...headers, 'content-type': 'application/json' },
					body: JSON.stringify(built.body),
					redirect: 'error',
					timeoutMs: AI_TIMEOUT_MS,
					maxBytes: 2 * 1024 * 1024,
				});
				if (response.status < 200 || response.status > 299)
					return { ok: false, code: response.status === 429 ? 'rate_limited' : 'provider_error' };
				return { ok: true, value: wire.parse(jsonOf(response)) };
			} catch {
				return { ok: false, code: 'provider_error' };
			}
		},
		/**
		 * The connection test: the value's shape, then a read-only call to the provider's model list.
		 * @param {unknown} value
		 * @returns {Promise<{ ok: boolean, message?: string }>}
		 */
		test: async (value) => {
			const checked = checkAiConnection(value);
			if (!checked.ok) return { ok: false, message: checked.message };
			const { base, headers } = endpointOf(checked.value);
			try {
				const response = await send(`${base}/models`, { headers, redirect: 'error', timeoutMs: 10_000 });
				if (response.status === 401 || response.status === 403)
					return { ok: false, message: 'The provider refused the key.' };
				if (response.status < 200 || response.status > 299)
					return { ok: false, message: `The provider answered ${response.status}.` };
				return { ok: true };
			} catch {
				return { ok: false, message: 'The provider cannot be reached.' };
			}
		},
	});

/** @typedef {ReturnType<typeof createAi>} Ai */
