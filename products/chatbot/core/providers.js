/**
 * AI provider wire formats (pure), ported from the ibrahimMobiles assistant provider: OpenAI chat completions (also
 * any OpenAI-compatible endpoint — "generic"), Anthropic messages and Google Gemini `generateContent`, all normalised
 * to one message / tool / tool-call shape with token usage. The adapter (adapters/ai.js) only sends the request
 * built here through the merchant's AI connector and parses the answer with the matching parser.
 * @module
 */

/** Providers a merchant's AI connector may use. */
export const PROVIDERS = Object.freeze(/** @type {const} */ (['openai', 'anthropic', 'google', 'generic']));

/** @typedef {(typeof PROVIDERS)[number]} Provider */
/** @typedef {{ name: string, description: string, parameters: Record<string, unknown> }} ToolSchema */
/** @typedef {{ id: string, name: string, arguments: Record<string, unknown> }} ToolCall */
/**
 * @typedef {{ role: 'system', content: string }
 *   | { role: 'user', content: string }
 *   | { role: 'assistant', content: string, toolCalls?: ToolCall[] }
 *   | { role: 'tool', toolCallId: string, toolName: string, content: string }} ChatMessage
 */
/**
 * @typedef {object} ChatRequest
 * @property {string} model
 * @property {ChatMessage[]} messages
 * @property {ToolSchema[]} [tools]
 * @property {number} temperature
 * @property {number} maxTokens
 */
/** @typedef {{ text: string, toolCalls: ToolCall[], usage: { input: number, output: number }, finish: string | null }} ChatResult */

/**
 * @param {unknown} raw
 * @returns {Record<string, unknown>}
 */
export const parseArguments = (raw) => {
	if (raw && typeof raw === 'object' && !Array.isArray(raw)) return /** @type {Record<string, unknown>} */ (raw);
	if (typeof raw !== 'string' || !raw.trim()) return {};
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
};

/** @param {unknown} value */
const int = (value) => (Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : 0);

// ── OpenAI / OpenAI-compatible ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {ChatRequest} request
 * @returns {{ path: string, body: Record<string, unknown> }}
 */
export const toOpenAi = ({ model, messages, tools, temperature, maxTokens }) => ({
	path: '/chat/completions',
	body: {
		model,
		messages: messages.map((m) => {
			if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
			if (m.role === 'assistant' && m.toolCalls?.length)
				return {
					role: 'assistant',
					content: m.content || null,
					tool_calls: m.toolCalls.map((call) => ({
						id: call.id,
						type: 'function',
						function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
					})),
				};
			return { role: m.role, content: m.content };
		}),
		temperature,
		max_tokens: maxTokens,
		...(tools?.length
			? {
					tools: tools.map((tool) => ({
						type: 'function',
						function: { name: tool.name, description: tool.description, parameters: tool.parameters },
					})),
					tool_choice: 'auto',
				}
			: {}),
	},
});

/**
 * @param {any} payload
 * @returns {ChatResult}
 */
export const fromOpenAi = (payload) => {
	const choice = payload?.choices?.[0];
	const message = choice?.message ?? {};
	const toolCalls = (Array.isArray(message.tool_calls) ? message.tool_calls : [])
		.filter((/** @type {any} */ call) => typeof call?.function?.name === 'string')
		.map((/** @type {any} */ call, /** @type {number} */ index) => ({
			id: typeof call.id === 'string' ? call.id : `call_${index}`,
			name: call.function.name,
			arguments: parseArguments(call.function.arguments),
		}));
	return {
		text: typeof message.content === 'string' ? message.content.trim() : '',
		toolCalls,
		usage: { input: int(payload?.usage?.prompt_tokens), output: int(payload?.usage?.completion_tokens) },
		finish: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
	};
};

// ── Anthropic ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * @param {ChatMessage[]} messages
 */
const toAnthropicMessages = (messages) => {
	/** @type {Array<{ role: 'user' | 'assistant', content: any[] }>} */
	const out = [];
	for (const m of messages) {
		if (m.role === 'system') continue;
		if (m.role === 'tool') {
			const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content };
			const last = out[out.length - 1];
			if (last && last.role === 'user' && last.content.every((b) => b.type === 'tool_result')) last.content.push(block);
			else out.push({ role: 'user', content: [block] });
			continue;
		}
		if (m.role === 'assistant') {
			const blocks = [];
			if (m.content) blocks.push({ type: 'text', text: m.content });
			for (const call of m.toolCalls ?? [])
				blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments ?? {} });
			out.push({ role: 'assistant', content: blocks });
			continue;
		}
		out.push({ role: 'user', content: [{ type: 'text', text: m.content }] });
	}
	return out;
};

/**
 * @param {ChatRequest} request
 * @returns {{ path: string, body: Record<string, unknown> }}
 */
export const toAnthropic = ({ model, messages, tools, temperature, maxTokens }) => {
	const system = messages
		.filter((m) => m.role === 'system')
		.map((m) => m.content)
		.join('\n\n');
	return {
		path: '/messages',
		body: {
			model,
			messages: toAnthropicMessages(messages),
			...(system ? { system } : {}),
			temperature,
			max_tokens: maxTokens,
			...(tools?.length
				? { tools: tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) }
				: {}),
		},
	};
};

/**
 * @param {any} payload
 * @returns {ChatResult}
 */
export const fromAnthropic = (payload) => {
	/** @type {string[]} */
	const texts = [];
	/** @type {ToolCall[]} */
	const toolCalls = [];
	for (const block of Array.isArray(payload?.content) ? payload.content : []) {
		if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
		if (block?.type === 'tool_use' && typeof block.name === 'string')
			toolCalls.push({
				id: typeof block.id === 'string' ? block.id : block.name,
				name: block.name,
				arguments: parseArguments(block.input),
			});
	}
	return {
		text: texts.join('').trim(),
		toolCalls,
		usage: { input: int(payload?.usage?.input_tokens), output: int(payload?.usage?.output_tokens) },
		finish: typeof payload?.stop_reason === 'string' ? payload.stop_reason : null,
	};
};

// ── Google Gemini ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * @param {ChatMessage[]} messages
 */
const toGeminiContents = (messages) => {
	/** @type {Array<{ role: 'user' | 'model', parts: any[] }>} */
	const contents = [];
	for (const m of messages) {
		if (m.role === 'system') continue;
		if (m.role === 'tool') {
			const part = { functionResponse: { name: m.toolName, response: { result: m.content } } };
			const last = contents[contents.length - 1];
			if (last && last.role === 'user' && last.parts.every((p) => 'functionResponse' in p)) last.parts.push(part);
			else contents.push({ role: 'user', parts: [part] });
			continue;
		}
		if (m.role === 'assistant') {
			const parts = [];
			if (m.content) parts.push({ text: m.content });
			for (const call of m.toolCalls ?? []) parts.push({ functionCall: { name: call.name, args: call.arguments ?? {} } });
			contents.push({ role: 'model', parts });
			continue;
		}
		contents.push({ role: 'user', parts: [{ text: m.content }] });
	}
	return contents;
};

/**
 * @param {ChatRequest} request
 * @returns {{ path: string, body: Record<string, unknown> }}
 */
export const toGoogle = ({ model, messages, tools, temperature, maxTokens }) => {
	const system = messages
		.filter((m) => m.role === 'system')
		.map((m) => m.content)
		.join('\n\n');
	return {
		path: `/models/${encodeURIComponent(model)}:generateContent`,
		body: {
			...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
			contents: toGeminiContents(messages),
			...(tools?.length
				? {
						tools: [
							{
								functionDeclarations: tools.map((tool) => {
									const properties = /** @type {Record<string, unknown>} */ (tool.parameters?.properties ?? {});
									// Gemini rejects an empty `properties` map: no-argument tools omit `parameters`
									return {
										name: tool.name,
										description: tool.description,
										...(Object.keys(properties).length > 0 ? { parameters: tool.parameters } : {}),
									};
								}),
							},
						],
					}
				: {}),
			generationConfig: { temperature, maxOutputTokens: maxTokens },
		},
	};
};

/**
 * @param {any} payload
 * @returns {ChatResult}
 */
export const fromGoogle = (payload) => {
	const candidate = payload?.candidates?.[0];
	const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
	/** @type {string[]} */
	const texts = [];
	/** @type {ToolCall[]} */
	const toolCalls = [];
	parts.forEach((/** @type {any} */ part, /** @type {number} */ index) => {
		if (typeof part?.text === 'string') texts.push(part.text);
		if (typeof part?.functionCall?.name === 'string')
			toolCalls.push({
				id: `${part.functionCall.name}-${index}`,
				name: part.functionCall.name,
				arguments: parseArguments(part.functionCall.args),
			});
	});
	return {
		text: texts.join('').trim(),
		toolCalls,
		usage: {
			input: int(payload?.usageMetadata?.promptTokenCount),
			output: int(payload?.usageMetadata?.candidatesTokenCount),
		},
		finish: typeof candidate?.finishReason === 'string' ? candidate.finishReason : null,
	};
};

/** Request builder and parser per provider. */
export const WIRE = Object.freeze({
	openai: { build: toOpenAi, parse: fromOpenAi },
	generic: { build: toOpenAi, parse: fromOpenAi },
	anthropic: { build: toAnthropic, parse: fromAnthropic },
	google: { build: toGoogle, parse: fromGoogle },
});

/**
 * Rough token estimate (≈ 4 characters per token) when a provider reports no usage.
 * @param {ChatMessage[]} messages
 * @param {string} output
 */
export const estimateTokens = (messages, output) => {
	const input = messages.reduce(
		(sum, m) => sum + m.content.length + ('toolCalls' in m && m.toolCalls ? JSON.stringify(m.toolCalls).length : 0),
		0,
	);
	return { input: Math.ceil(input / 4), output: Math.ceil(output.length / 4) };
};

/**
 * Model for a provider: the feature override, else the connector's model, else the per-provider default.
 * @param {{ provider: string, override: string, connectorModel?: string | null, defaults: Record<string, string> }} input
 * @returns {string}
 */
export const resolveModel = ({ provider, override, connectorModel, defaults }) =>
	override.trim() || (connectorModel ?? '').trim() || (defaults[provider] ?? '').trim();
