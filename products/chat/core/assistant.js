/**
 * The answer loop (pure orchestration; every effect is injected): the model may request tools, which run and feed their
 * results back, for at most `maxRounds` rounds; the last round offers no tools so the model must answer in text. One
 * shared deadline covers every call, and each call's tokens are charged after it (provider usage, else an estimate;
 * the caps are checked before the answer starts). An answer in the wrong language is retried once with an explicit instruction and dropped if it is
 * still wrong; so is an answer any other check refuses (an answer that says it is a bot while "never disclose" is on,
 * PLAN 0.8.10 C1).
 * @module
 */
import { estimateTokens } from '@ss/app-kit/ai';

/** @typedef {import('@ss/app-kit').AiMessage} AiMessage */
/** @typedef {import('@ss/app-kit').AiResult} AiResult */
/** @typedef {import('@ss/app-kit').AiToolCall} AiToolCall */
/** @typedef {import('@ss/app-kit').AiToolSchema} AiToolSchema */
/**
 * @typedef {object} AssistantDeps
 * @property {(request: { messages: AiMessage[], tools: AiToolSchema[] }) => Promise<{ ok: true, value: AiResult } | { ok: false, code: string }>} call
 * @property {(call: AiToolCall) => Promise<{ content: string, escalate?: { reason: string } | null, ok?: boolean }>} execute
 * @property {(usage: { input: number, output: number }) => Promise<void> | void} spend
 * @property {() => boolean} expired the shared deadline passed
 */
/**
 * @typedef {object} AssistantInput
 * @property {AiMessage[]} messages system + history + the customer's message
 * @property {AiToolSchema[]} tools
 * @property {number} maxRounds
 * @property {((text: string) => boolean) | null} [languageOk]
 * @property {string} [retryInstruction]
 * @property {Array<{ ok: (text: string) => boolean, retry: string, failure: string }>} [checks] more checks of the
 *   answer: a failed one asks again once with its `retry` instruction, then drops the answer with its `failure`
 */
/**
 * @typedef {object} AssistantResult
 * @property {string} text '' when no usable answer
 * @property {string | null} failure provider_error | timeout | empty | language | a check's failure | null
 * @property {{ reason: string } | null} escalation
 * @property {boolean} retried language retry used
 */

/**
 * @param {AssistantInput} input
 * @param {AssistantDeps} deps
 * @returns {Promise<AssistantResult>}
 */
export const runAssistant = async (
	{ messages, tools, maxRounds, languageOk = null, retryInstruction = '', checks = [] },
	deps,
) => {
	const conversation = [...messages];
	/** @type {{ reason: string } | null} */
	let escalation = null;
	/** @param {string | null} failure @param {string} [text] @param {boolean} [retried] @returns {AssistantResult} */
	const done = (failure, text = '', retried = false) => ({ text, failure, escalation, retried });

	/** @param {AiToolSchema[]} offered */
	const ask = async (offered) => {
		if (deps.expired()) return /** @type {const} */ ({ ok: false, code: 'timeout' });
		const result = await deps.call({ messages: conversation, tools: offered });
		if (!result.ok) return result;
		const reported = result.value.usage;
		await deps.spend(reported.input + reported.output > 0 ? reported : estimateTokens(conversation, result.value.text));
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
			if (output.escalate && !escalation) escalation = output.escalate;
			conversation.push({ role: 'tool', toolCallId: call.id, toolName: call.name, content: output.content });
		});
		round += 1;
		result = await ask(round < maxRounds ? tools : []);
	}
	if (!result.ok) return done(result.code === 'timeout' ? 'timeout' : 'provider_error');
	const text = result.value.text.trim();
	if (!text) return done('empty');
	const all = [...(languageOk ? [{ ok: languageOk, retry: retryInstruction, failure: 'language' }] : []), ...checks];
	const failed = all.find((check) => !check.ok(text));
	if (!failed) return done(null, text);
	if (!failed.retry) return done(failed.failure);
	conversation.push({ role: 'assistant', content: text }, { role: 'user', content: failed.retry });
	const retry = await ask([]);
	const retried = retry.ok ? retry.value.text.trim() : '';
	const still = retried ? all.find((check) => !check.ok(retried)) : failed;
	return still ? done(still.failure, '', true) : done(null, retried, true);
};
