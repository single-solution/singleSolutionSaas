/**
 * The answer loop (pure orchestration; every effect is injected), ported from the ibrahimMobiles `generateReply`:
 * the model may request tools, which run and feed their results back, for at most `maxRounds` rounds; the last round
 * offers no tools so the model must answer in text. One shared deadline covers every call; the token budget is checked
 * before each call and charged after it (provider usage, else an estimate). An answer in the wrong language is retried
 * once with an explicit instruction and dropped if it is still wrong.
 * @module
 */
import { estimateTokens } from './providers.js';

/** @typedef {import('./providers.js').ChatMessage} ChatMessage */
/** @typedef {import('./providers.js').ChatResult} ChatResult */
/** @typedef {import('./providers.js').ToolCall} ToolCall */
/** @typedef {import('./providers.js').ToolSchema} ToolSchema */
/**
 * @typedef {object} AssistantDeps
 * @property {(request: { messages: ChatMessage[], tools: ToolSchema[] }) => Promise<{ ok: true, value: ChatResult } | { ok: false, code: string }>} call
 * @property {(call: ToolCall) => Promise<{ content: string, escalate?: { reason: string } | null, ok?: boolean }>} execute
 * @property {() => number} remainingTokens tokens still allowed (conversation and month)
 * @property {(usage: { input: number, output: number }) => Promise<void> | void} spend
 * @property {() => boolean} expired the shared deadline passed
 */
/**
 * @typedef {object} AssistantInput
 * @property {ChatMessage[]} messages system + history + the customer's message
 * @property {ToolSchema[]} tools
 * @property {number} maxRounds
 * @property {((text: string) => boolean) | null} [languageOk]
 * @property {string} [retryInstruction]
 */
/**
 * @typedef {object} AssistantResult
 * @property {string} text '' when no usable answer
 * @property {string | null} failure provider_error | timeout | budget | empty | language | null
 * @property {{ input: number, output: number }} usage
 * @property {number} calls provider calls made
 * @property {Array<{ name: string, ok: boolean }>} tools tools run
 * @property {{ reason: string } | null} escalation
 * @property {boolean} retried language retry used
 */

/**
 * @param {AssistantInput} input
 * @param {AssistantDeps} deps
 * @returns {Promise<AssistantResult>}
 */
export const runAssistant = async ({ messages, tools, maxRounds, languageOk = null, retryInstruction = '' }, deps) => {
	const conversation = [...messages];
	const usage = { input: 0, output: 0 };
	/** @type {Array<{ name: string, ok: boolean }>} */
	const ran = [];
	/** @type {{ reason: string } | null} */
	let escalation = null;
	let calls = 0;
	/** @param {string | null} failure @param {string} [text] @param {boolean} [retried] @returns {AssistantResult} */
	const done = (failure, text = '', retried = false) => ({ text, failure, usage, calls, tools: ran, escalation, retried });

	/** @param {ToolSchema[]} offered */
	const ask = async (offered) => {
		if (deps.expired()) return /** @type {const} */ ({ ok: false, code: 'timeout' });
		if (deps.remainingTokens() <= 0) return /** @type {const} */ ({ ok: false, code: 'budget' });
		calls += 1;
		const result = await deps.call({ messages: conversation, tools: offered });
		if (!result.ok) return result;
		const reported = result.value.usage;
		const spent = reported.input + reported.output > 0 ? reported : estimateTokens(conversation, result.value.text);
		usage.input += spent.input;
		usage.output += spent.output;
		await deps.spend(spent);
		return result;
	};

	let result = await ask(maxRounds > 0 ? tools : []);
	let round = 0;
	while (result.ok && result.value.toolCalls.length > 0 && round < maxRounds) {
		const requested = result.value.toolCalls;
		conversation.push({ role: 'assistant', content: result.value.text, toolCalls: requested });
		// tools of one round are independent: run them together, keep the provider's order
		const outputs = await Promise.all(requested.map((call) => deps.execute(call)));
		requested.forEach((call, index) => {
			const output = /** @type {{ content: string, escalate?: { reason: string } | null, ok?: boolean }} */ (outputs[index]);
			ran.push({ name: call.name, ok: output.ok !== false });
			if (output.escalate && !escalation) escalation = output.escalate;
			conversation.push({ role: 'tool', toolCallId: call.id, toolName: call.name, content: output.content });
		});
		round += 1;
		result = await ask(round < maxRounds ? tools : []);
	}
	if (!result.ok) return done(result.code === 'timeout' || result.code === 'budget' ? result.code : 'provider_error');
	const text = result.value.text.trim();
	if (!text) return done('empty');
	if (languageOk && !languageOk(text)) {
		if (!retryInstruction) return done('language');
		conversation.push({ role: 'assistant', content: text }, { role: 'user', content: retryInstruction });
		const retry = await ask([]);
		const retried = retry.ok ? retry.value.text.trim() : '';
		return retried && languageOk(retried) ? done(null, retried, true) : done('language', '', true);
	}
	return done(null, text);
};
