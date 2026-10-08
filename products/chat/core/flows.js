/**
 * Flows (pure, PLAN 0.8.3 Lead capture and flows): short step lists edited as a form in Settings → Flows. A flow starts
 * by a page rule (a path pattern and an optional delay; the widget starts it) or by a keyword in a visitor message;
 * the first matching flow in the list wins; a flow runs at most once per conversation and is never interrupted by
 * another. Steps run top to bottom, without branching: message, question with buttons (the answer is saved on the
 * conversation), collect a field (validated), hand off (skipped when handoff is off) and end. Typing instead of
 * tapping a button ends the flow.
 * @module
 */
import { containsPhrase, pathMatches } from './text.js';
import { checkFieldValue } from './fields.js';

/** Most flows a website has. */
export const MAX_FLOWS = 20;
/** Most steps of one flow. */
export const MAX_STEPS = 20;
const FLOW_ID = /^[a-z0-9_-]{1,40}$/;
const STANDARD_FIELDS = Object.freeze(['name', 'email', 'phone', 'text']);

/**
 * @typedef {{ kind: 'message', text: string } | { kind: 'question', text: string, buttons: string[] }
 *   | { kind: 'collect', field: string, text: string } | { kind: 'handoff' } | { kind: 'end' }} Step
 * @typedef {{ kind: 'page', path: string, delay: number } | { kind: 'keyword', keywords: string[] }} Start
 * @typedef {{ id: string, name: string, start: Start, steps: Step[] }} Flow
 * @typedef {import('./fields.js').CustomField} CustomField
 */

/** @param {unknown} value */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
/** @param {unknown} value @param {number} max */
const text = (value, max) => (typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null);

/**
 * @param {unknown} raw
 * @param {string} at
 * @param {string[]} errors
 * @returns {Step | null}
 */
const checkStep = (raw, at, errors) => {
	if (!isObject(raw)) return (errors.push(`${at}: not a step.`), null);
	const step = /** @type {Record<string, unknown>} */ (raw);
	if (step.kind === 'handoff' || step.kind === 'end') return { kind: step.kind };
	const words = text(step.text, 1000);
	if (!words) return (errors.push(`${at}: write the text (up to 1000 characters).`), null);
	if (step.kind === 'message') return { kind: 'message', text: words };
	if (step.kind === 'question') {
		const buttons = Array.isArray(step.buttons) ? step.buttons.map((b) => text(b, 60)) : [];
		if (buttons.length < 1 || buttons.length > 6 || buttons.some((b) => b === null))
			return (errors.push(`${at}: a question has 1–6 buttons of up to 60 characters.`), null);
		return { kind: 'question', text: words, buttons: /** @type {string[]} */ (buttons) };
	}
	if (step.kind === 'collect') {
		const field = typeof step.field === 'string' ? step.field : '';
		if (!STANDARD_FIELDS.includes(field) && !/^custom:[a-z][a-z0-9_]{0,39}$/.test(field))
			return (errors.push(`${at}: collect name, email, phone, text or a custom field.`), null);
		return { kind: 'collect', field, text: words };
	}
	return (errors.push(`${at}: the kind is message, question, collect, handoff or end.`), null);
};

/**
 * Check the list of flows a merchant saves.
 * @param {unknown} items
 * @returns {{ ok: true, value: Flow[] } | { ok: false, errors: string[] }}
 */
export const checkFlows = (items) => {
	if (!Array.isArray(items) || items.length > MAX_FLOWS) return { ok: false, errors: [`Up to ${MAX_FLOWS} flows.`] };
	/** @type {string[]} */
	const errors = [];
	/** @type {Flow[]} */
	const value = [];
	const ids = new Set();
	items.forEach((item, index) => {
		const at = `Flow ${index + 1}`;
		if (!isObject(item)) return void errors.push(`${at}: not a flow.`);
		const id = typeof item.id === 'string' && FLOW_ID.test(item.id) && !ids.has(item.id) ? item.id : null;
		if (!id) return void errors.push(`${at}: the id is 1–40 lower-case letters, digits, - or _, and unique.`);
		ids.add(id);
		const name = text(item.name, 100);
		if (!name) errors.push(`${at}: name the flow.`);
		/** @type {Start | null} */
		let start = null;
		const rawStart = isObject(item.start) ? /** @type {Record<string, unknown>} */ (item.start) : {};
		if (rawStart.kind === 'page') {
			const path = text(rawStart.path, 200);
			const delay = Number.isInteger(rawStart.delay) ? Number(rawStart.delay) : 0;
			if (path && path.startsWith('/') && delay >= 0 && delay <= 3600) start = { kind: 'page', path, delay };
		} else if (rawStart.kind === 'keyword' && Array.isArray(rawStart.keywords)) {
			const keywords = rawStart.keywords.map((k) => text(k, 100));
			if (keywords.length > 0 && keywords.length <= 20 && keywords.every(Boolean))
				start = { kind: 'keyword', keywords: /** @type {string[]} */ (keywords) };
		}
		if (!start) errors.push(`${at}: start on a page (a path from /, a delay of 0–3600 s) or on up to 20 keywords.`);
		const rawSteps = Array.isArray(item.steps) ? item.steps : [];
		if (rawSteps.length < 1 || rawSteps.length > MAX_STEPS) errors.push(`${at}: 1–${MAX_STEPS} steps.`);
		const steps = rawSteps
			.slice(0, MAX_STEPS)
			.map((/** @type {unknown} */ step, /** @type {number} */ i) => checkStep(step, `${at}, step ${i + 1}`, errors));
		if (name && start && steps.every(Boolean)) value.push({ id, name, start, steps: /** @type {Step[]} */ (steps) });
	});
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
};

/**
 * The first flow a visitor message starts by keyword, unless it already ran in this conversation.
 * @param {readonly Flow[]} flows
 * @param {string} message
 * @param {readonly string[]} run ids of flows that ran
 */
export const keywordFlow = (flows, message, run) =>
	flows.find(
		(flow) =>
			!run.includes(flow.id) &&
			flow.start.kind === 'keyword' &&
			flow.start.keywords.some((keyword) => containsPhrase(message, keyword)),
	) ?? null;

/**
 * Whether a page-started flow may start on a path (the widget asks; the server checks).
 * @param {Flow} flow
 * @param {string} path
 */
export const pageFlowMatches = (flow, path) => flow.start.kind === 'page' && pathMatches(flow.start.path, path);

/**
 * Run a flow from a step until it waits for the visitor or ends.
 * @param {Flow} flow
 * @param {number} from step index
 * @param {{ handoff: boolean }} on
 * @returns {{ messages: Array<{ text: string, buttons?: string[] }>, waitAt: number | null, handoff: boolean }}
 */
export const advance = (flow, from, on) => {
	/** @type {Array<{ text: string, buttons?: string[] }>} */
	const messages = [];
	let handoff = false;
	for (let i = from; i < flow.steps.length; i += 1) {
		const step = /** @type {Step} */ (flow.steps[i]);
		if (step.kind === 'end') return { messages, waitAt: null, handoff };
		if (step.kind === 'handoff') {
			if (on.handoff) handoff = true;
			continue;
		}
		if (step.kind === 'message') {
			messages.push({ text: step.text });
			continue;
		}
		messages.push(step.kind === 'question' ? { text: step.text, buttons: step.buttons } : { text: step.text });
		return { messages, waitAt: i, handoff };
	}
	return { messages, waitAt: null, handoff };
};

/**
 * What the widget needs to answer the waiting step.
 * @param {Step | undefined} step
 * @param {readonly CustomField[]} customFields
 */
export const waitingView = (step, customFields) => {
	if (!step || step.kind === 'question') return { kind: 'question', buttons: step?.kind === 'question' ? step.buttons : [] };
	if (step.kind !== 'collect') return null;
	const custom = step.field.startsWith('custom:') ? customFields.find((f) => `custom:${f.key}` === step.field) : undefined;
	/** @type {Record<string, string>} */
	const types = { name: 'text', email: 'email', phone: 'phone', text: 'text' };
	return {
		kind: 'collect',
		field: custom ? custom.key : step.field,
		type: custom ? custom.type : (types[step.field] ?? 'text'),
		options: custom?.options ?? [],
	};
};

/**
 * Check the visitor's answer to the waiting step.
 * @param {Flow} flow
 * @param {number} at
 * @param {string} answer
 * @param {readonly CustomField[]} customFields
 * @returns {{ ok: true, key: string, value: string | number | boolean } | { ok: false }}
 */
export const answerStep = (flow, at, answer, customFields) => {
	const step = flow.steps[at];
	const key = `${flow.id}:${at + 1}`;
	if (step?.kind === 'question') return step.buttons.includes(answer) ? { ok: true, key, value: answer } : { ok: false };
	if (step?.kind !== 'collect') return { ok: false };
	if (step.field.startsWith('custom:')) {
		const field = customFields.find((f) => `custom:${f.key}` === step.field);
		const checked = field ? checkFieldValue(field, answer) : null;
		return field && checked?.ok ? { ok: true, key: field.key, value: checked.value } : { ok: false };
	}
	const type = /** @type {CustomField['type']} */ (step.field);
	const checked = checkFieldValue({ key: step.field, label: step.field, type, options: [] }, answer);
	return checked.ok ? { ok: true, key: step.field === 'text' ? key : step.field, value: checked.value } : { ok: false };
};
