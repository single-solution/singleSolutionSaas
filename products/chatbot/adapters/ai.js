/**
 * AI provider adapters for app-kit's connectors (`createProduct({ connectors: { ai } })`): the merchant's AI connector
 * descriptor (resolved through the Portal, never stored) picks `openai`, `anthropic`, `google` or `generic` (any
 * OpenAI-compatible endpoint). Each adapter is app-kit's HTTP connector — the merchant's base URL and API key, the
 * kit's SSRF-guarded `send` (@ss/net safeFetch), relative paths only, no redirects — plus `chat()`, which builds the
 * request and parses the answer with core/providers.js. The product never holds platform AI keys.
 * @module
 */
import { createHttpConnector } from '@ss/app-kit';
import { WIRE } from '../core/providers.js';

/**
 * @typedef {object} ChatAdapter
 * @property {string} provider
 * @property {string | undefined} model the connector's model, if set
 * @property {(request: import('../core/providers.js').ChatRequest & { timeoutMs: number }) =>
 *   Promise<{ ok: true, value: import('../core/providers.js').ChatResult } | { ok: false, code: string, status?: number }>} chat
 */

/**
 * @param {'openai' | 'anthropic' | 'google' | 'generic'} provider
 * @returns {(context: { descriptor: Record<string, unknown>, send: any, policy: any }) => ChatAdapter}
 */
export const aiAdapter =
	(provider) =>
	({ descriptor, send, policy }) => {
		const http = createHttpConnector({ descriptor, kind: 'ai', send, policy });
		const wire = WIRE[provider];
		return Object.freeze({
			provider,
			model: typeof descriptor.model === 'string' ? descriptor.model : undefined,
			chat: async ({ timeoutMs, ...request }) => {
				const built = wire.build(request);
				try {
					const result = await http.request({ path: http.pathOf('complete', built.path), body: built.body, timeoutMs });
					if (!result.ok)
						return { ok: false, code: result.status === 429 ? 'rate_limited' : 'upstream_error', status: result.status };
					return { ok: true, value: wire.parse(result.body) };
				} catch (error) {
					return { ok: false, code: /** @type {any} */ (error)?.code === 'timeout' ? 'timeout' : 'upstream_error' };
				}
			},
		});
	};

/** The adapters to register: `connectors: { ai: AI_ADAPTERS }`. */
export const AI_ADAPTERS = Object.freeze({
	openai: aiAdapter('openai'),
	anthropic: aiAdapter('anthropic'),
	google: aiAdapter('google'),
	generic: aiAdapter('generic'),
	// descriptors without a provider resolve to app-kit's default `http` provider: treat them as OpenAI-compatible
	http: aiAdapter('generic'),
});
