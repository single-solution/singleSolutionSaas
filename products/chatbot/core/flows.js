/**
 * Conversation flows (pure graph logic; tools and AI steps are injected): validation for the builder, trigger
 * matching and the executor. A flow run is a small state `{ flowId, node, vars, waiting }` stored on the
 * conversation; each customer input advances it until a node waits (question, buttons, form) or the flow ends
 * (end, handoff, a missing edge). `max_steps_per_turn` bounds every turn, so a cycle can never spin.
 * @module
 */
import { compileCondition, conditionMatches } from './rules.js';
import { containsPhrase, fill, normalise, pathMatches } from './text.js';
import { validateField } from './leads.js';

/** Node types. */
export const NODE_TYPES = Object.freeze([
	'message',
	'question',
	'buttons',
	'form',
	'condition',
	'action',
	'ai_step',
	'handoff',
	'end',
]);

/** @typedef {{ label: string, value?: string, next?: string, url?: string }} FlowButton */
/** @typedef {{ name: string, label?: string, type: string, required?: boolean, options?: string[] }} FlowField */
/**
 * @typedef {object} FlowNode
 * @property {string} id
 * @property {string} type
 * @property {string} [text]
 * @property {string} [variable]
 * @property {string} [validate]
 * @property {FlowButton[]} [buttons]
 * @property {FlowField[]} [fields]
 * @property {string} [condition]
 * @property {string} [then]
 * @property {string} [else]
 * @property {{ kind: string, name?: string, value?: string }} [action]
 * @property {string} [prompt]
 * @property {string} [team]
 * @property {string} [next]
 */
/**
 * @typedef {object} Flow
 * @property {string} id
 * @property {string} [name]
 * @property {boolean} [enabled]
 * @property {number} [priority]
 * @property {{ type: string, keywords?: string[], path?: string, event?: string, when?: string }} [trigger]
 * @property {string} start
 * @property {FlowNode[]} nodes
 */
/** @typedef {{ flowId: string, node: string, vars: Record<string, unknown>, waiting: 'question' | 'buttons' | 'form' | null }} FlowState */
/**
 * @typedef {{ kind: 'text', text: string } | { kind: 'buttons', text: string, buttons: Array<{ label: string, value: string, url?: string }> }
 *   | { kind: 'form', text: string, fields: FlowField[] }} FlowOutput
 */
/**
 * @typedef {{ kind: 'handoff', team: string | null, reason: string } | { kind: 'tag', tag: string }
 *   | { kind: 'priority', priority: string } | { kind: 'lead', fields: Record<string, unknown> } | { kind: 'close' }
 *   | { kind: 'ai_fallback' }} FlowEffect
 */

/**
 * Builder diagnostics: errors make a flow unusable, warnings do not.
 * @param {Flow} flow
 * @returns {{ ok: boolean, errors: Array<{ path: string, code: string }>, warnings: Array<{ path: string, code: string }> }}
 */
export const validateFlow = (flow) => {
	/** @type {Array<{ path: string, code: string }>} */
	const errors = [];
	/** @type {Array<{ path: string, code: string }>} */
	const warnings = [];
	const nodes = Array.isArray(flow?.nodes) ? flow.nodes : [];
	const ids = new Map();
	nodes.forEach((node, index) => {
		if (ids.has(node.id)) errors.push({ path: `/nodes/${index}/id`, code: 'duplicate_id' });
		ids.set(node.id, index);
	});
	if (!ids.has(flow?.start)) errors.push({ path: '/start', code: 'unknown_node' });
	/** @param {string | undefined} ref @param {string} path */
	const edge = (ref, path) => {
		if (ref !== undefined && ref !== '' && !ids.has(ref)) errors.push({ path, code: 'unknown_node' });
	};
	nodes.forEach((node, index) => {
		const at = `/nodes/${index}`;
		if (!NODE_TYPES.includes(node.type)) errors.push({ path: `${at}/type`, code: 'unknown_type' });
		edge(node.next, `${at}/next`);
		if (['message', 'question'].includes(node.type) && !node.text) errors.push({ path: `${at}/text`, code: 'required' });
		if (node.type === 'question' && !node.variable) errors.push({ path: `${at}/variable`, code: 'required' });
		if (node.type === 'buttons') {
			if (!node.buttons?.length) errors.push({ path: `${at}/buttons`, code: 'required' });
			node.buttons?.forEach((button, b) => edge(button.next, `${at}/buttons/${b}/next`));
		}
		if (node.type === 'form' && !node.fields?.length) errors.push({ path: `${at}/fields`, code: 'required' });
		if (node.type === 'condition') {
			const compiled = compileCondition(node.condition ?? '');
			if (!node.condition) errors.push({ path: `${at}/condition`, code: 'required' });
			else if (!compiled.ok) errors.push({ path: `${at}/condition`, code: 'invalid_condition' });
			edge(node.then, `${at}/then`);
			edge(node.else, `${at}/else`);
		}
		if (node.type === 'action' && !node.action?.kind) errors.push({ path: `${at}/action`, code: 'required' });
		if (node.type === 'ai_step' && !node.prompt) warnings.push({ path: `${at}/prompt`, code: 'empty_prompt' });
	});
	if (flow?.trigger?.when && !compileCondition(flow.trigger.when).ok)
		errors.push({ path: '/trigger/when', code: 'invalid_condition' });
	if (flow?.trigger?.type === 'keyword' && !flow.trigger.keywords?.length)
		errors.push({ path: '/trigger/keywords', code: 'required' });
	// reachability (warnings)
	const reached = new Set();
	const queue = ids.has(flow?.start) ? [flow.start] : [];
	while (queue.length > 0) {
		const id = /** @type {string} */ (queue.shift());
		if (reached.has(id)) continue;
		reached.add(id);
		const node = nodes[ids.get(id)];
		for (const ref of [node?.next, node?.then, node?.else, ...(node?.buttons ?? []).map((b) => b.next)])
			if (ref && ids.has(ref) && !reached.has(ref)) queue.push(ref);
	}
	nodes.forEach((node, index) => {
		if (!reached.has(node.id)) warnings.push({ path: `/nodes/${index}`, code: 'unreachable' });
	});
	return { ok: errors.length === 0, errors, warnings };
};

/**
 * The flow to start for an entry, if any: enabled, valid, trigger matches, highest priority first.
 * @param {readonly Flow[]} flows
 * @param {{ entry: 'start' | 'message' | 'event', text?: string, path?: string, eventType?: string, flowId?: string }} entry
 * @param {{ context: Record<string, unknown>, now: number, timeZone: string }} options
 * @returns {Flow | null}
 */
export const matchFlow = (flows, entry, { context, now, timeZone }) => {
	const candidates = [...flows]
		.filter((flow) => flow.enabled !== false && validateFlow(flow).ok)
		.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id));
	for (const flow of candidates) {
		const trigger = flow.trigger ?? { type: 'manual' };
		let hit = false;
		if (entry.flowId) hit = entry.flowId === flow.id;
		else if (trigger.type === 'conversation_start') hit = entry.entry === 'start';
		else if (trigger.type === 'keyword')
			hit = entry.entry !== 'event' && (trigger.keywords ?? []).some((k) => containsPhrase(entry.text ?? '', k));
		else if (trigger.type === 'page')
			hit = entry.entry === 'start' && Boolean(trigger.path) && pathMatches(String(trigger.path), entry.path ?? '');
		else if (trigger.type === 'event') hit = entry.entry === 'event' && trigger.event === entry.eventType;
		if (hit && conditionMatches(trigger.when, context, { now, timeZone }).matched) return flow;
	}
	return null;
};

/**
 * Validate a free-text answer of a question node.
 * @param {string} text
 * @param {string | undefined} kind
 */
export const answerValid = (text, kind) => {
	const value = text.trim();
	if (!value) return false;
	if (!kind || kind === 'text') return true;
	return validateField({ name: 'answer', type: kind, required: true }, value) === null;
};

/**
 * @typedef {object} StepDeps
 * @property {(prompt: string, vars: Record<string, unknown>) => Promise<string | null>} [runAi] AI step
 * @property {(name: string, args: Record<string, unknown>) => Promise<{ ok: boolean, output: string }>} [runTool]
 */
/**
 * @typedef {object} StepInput
 * @property {Flow} flow
 * @property {FlowState | null} state null = start the flow
 * @property {{ kind: 'start' } | { kind: 'text', text: string } | { kind: 'button', value: string } | { kind: 'form', values: Record<string, unknown> }} input
 * @property {Record<string, unknown>} context conversation, customer, message, page (vars are added)
 * @property {{ maxSteps: number, unmatched: 'repeat' | 'ai' | 'exit', exitKeywords: string[], now: number, timeZone: string,
 *   invalidAnswer: string }} options
 */
/**
 * @typedef {object} StepResult
 * @property {FlowState | null} state null when the flow ended
 * @property {FlowOutput[]} outputs
 * @property {FlowEffect[]} effects
 * @property {boolean} consumed false when the input was not for the flow (the caller answers it otherwise)
 */

/**
 * Advance a flow by one customer input.
 * @param {StepInput} input
 * @param {StepDeps} [deps]
 * @returns {Promise<StepResult>}
 */
export const stepFlow = async ({ flow, state, input, context, options }, deps = {}) => {
	const byId = new Map(flow.nodes.map((node) => [node.id, node]));
	/** @type {Record<string, unknown>} */
	const vars = { ...(state?.vars ?? {}) };
	/** @type {FlowOutput[]} */
	const outputs = [];
	/** @type {FlowEffect[]} */
	const effects = [];
	const ctx = () => ({ ...context, vars });
	const text = (/** @type {string | undefined} */ template) => fill(template ?? '', ctx());
	/** @param {FlowState | null} next @param {boolean} [consumed] @returns {StepResult} */
	const finish = (next, consumed = true) => ({ state: next, outputs, effects, consumed });

	/** @type {FlowNode | undefined} */
	let node;
	if (!state) node = byId.get(flow.start);
	else {
		const waiting = byId.get(state.node);
		if (!waiting) return finish(null, false);
		if (input.kind === 'text' && options.exitKeywords.some((k) => normalise(k) === normalise(input.text)))
			return finish(null, true);
		if (state.waiting === 'question') {
			if (input.kind !== 'text' || !answerValid(input.text, waiting.validate)) {
				outputs.push({ kind: 'text', text: options.invalidAnswer }, { kind: 'text', text: text(waiting.text) });
				return finish(state);
			}
			if (waiting.variable) vars[waiting.variable] = input.text.trim();
			node = byId.get(waiting.next ?? '');
		} else if (state.waiting === 'buttons') {
			const buttons = waiting.buttons ?? [];
			const wanted = input.kind === 'button' ? input.value : input.kind === 'text' ? input.text : '';
			const chosen = buttons.find(
				(b) => normalise(b.value ?? b.label) === normalise(wanted) || normalise(b.label) === normalise(wanted),
			);
			if (!chosen) {
				if (options.unmatched === 'exit') return finish(null, false);
				if (options.unmatched === 'ai') {
					effects.push({ kind: 'ai_fallback' });
					return finish(null, false);
				}
				outputs.push(buttonsOutput(waiting, text));
				return finish(state);
			}
			if (waiting.variable) vars[waiting.variable] = chosen.value ?? chosen.label;
			node = byId.get(chosen.next ?? waiting.next ?? '');
		} else if (state.waiting === 'form') {
			const values = input.kind === 'form' ? input.values : {};
			const fields = waiting.fields ?? [];
			const invalid = fields.filter((field) => validateField(field, values[field.name]) !== null);
			if (input.kind !== 'form' || invalid.length > 0) {
				outputs.push({ kind: 'text', text: options.invalidAnswer }, { kind: 'form', text: text(waiting.text), fields });
				return finish(state);
			}
			for (const field of fields) if (values[field.name] !== undefined) vars[field.name] = values[field.name];
			node = byId.get(waiting.next ?? '');
		} else node = byId.get(waiting.next ?? '');
	}

	for (let steps = 0; node && steps < options.maxSteps; steps += 1) {
		const current = node;
		switch (current.type) {
			case 'message':
				outputs.push({ kind: 'text', text: text(current.text) });
				node = byId.get(current.next ?? '');
				break;
			case 'question':
				outputs.push({ kind: 'text', text: text(current.text) });
				return finish({ flowId: flow.id, node: current.id, vars, waiting: 'question' });
			case 'buttons':
				outputs.push(buttonsOutput(current, text));
				return finish({ flowId: flow.id, node: current.id, vars, waiting: 'buttons' });
			case 'form':
				outputs.push({ kind: 'form', text: text(current.text), fields: current.fields ?? [] });
				return finish({ flowId: flow.id, node: current.id, vars, waiting: 'form' });
			case 'condition': {
				const { matched } = conditionMatches(current.condition, ctx(), {
					now: options.now,
					timeZone: options.timeZone,
					whenEmpty: false,
				});
				node = byId.get((matched ? current.then : current.else) ?? '');
				break;
			}
			case 'action': {
				const action = current.action ?? { kind: '' };
				const value = text(action.value);
				if (action.kind === 'set_variable' && action.name) vars[action.name] = value;
				else if (action.kind === 'add_tag' && action.name) effects.push({ kind: 'tag', tag: action.name });
				else if (action.kind === 'set_priority' && action.name) effects.push({ kind: 'priority', priority: action.name });
				else if (action.kind === 'capture_lead') effects.push({ kind: 'lead', fields: { ...vars } });
				else if (action.kind === 'close') {
					effects.push({ kind: 'close' });
					return finish(null);
				} else if (action.kind === 'call_tool' && action.name && deps.runTool) {
					const result = await deps.runTool(action.name, { ...vars });
					vars.tool = { ok: result.ok, output: result.output };
				}
				node = byId.get(current.next ?? '');
				break;
			}
			case 'ai_step': {
				const answer = deps.runAi ? await deps.runAi(text(current.prompt), { ...vars }) : null;
				if (answer) outputs.push({ kind: 'text', text: answer });
				node = byId.get(current.next ?? '');
				break;
			}
			case 'handoff':
				if (current.text) outputs.push({ kind: 'text', text: text(current.text) });
				effects.push({ kind: 'handoff', team: current.team || null, reason: `flow:${flow.id}` });
				return finish(null);
			default:
				if (current.text) outputs.push({ kind: 'text', text: text(current.text) });
				return finish(null);
		}
	}
	return finish(null);
};

/**
 * @param {FlowNode} node
 * @param {(template: string | undefined) => string} text
 * @returns {FlowOutput}
 */
const buttonsOutput = (node, text) => ({
	kind: 'buttons',
	text: text(node.text),
	buttons: (node.buttons ?? []).map((b) => ({ label: b.label, value: b.value ?? b.label, ...(b.url ? { url: b.url } : {}) })),
});
