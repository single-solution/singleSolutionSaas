'use client';
/**
 * Settings list editors (Chat's own dashboard routes, PLAN 0.8.3): webhook tools, page rules, flows and custom fields,
 * each saved whole with `PUT /v1/dashboard/websites/:websiteId/lists/:list { items }` (a 422 lists its `errors`), and
 * the tool signing secret (reveal, copy, regenerate).
 * @module
 */
import { useState } from 'react';
import { Button, Callout, Card, Checkbox, CodeBlock, ConfirmDialog, Input, Select, TextArea, describeProblem } from '@ss/ui';
import { call, fill, useLoad } from './api.js';
import { Loaded } from './parts.js';
import { TEXTS } from './texts.js';

/** @typedef {Record<string, any>} Item */

const L = TEXTS.lists;

/**
 * Lines typed in a text area (kept as typed while editing).
 * @param {string} text
 */
const toLines = (text) => text.split('\n');

/**
 * Lines as saved: trimmed, empty ones dropped.
 * @param {unknown} lines
 */
const cleanLines = (lines) =>
	(Array.isArray(lines) ? lines : []).map((line) => String(line).trim()).filter((line) => line !== '');

/**
 * A copy of `items` with the entry at `index` moved by `step` (-1 up, 1 down).
 * @template T
 * @param {T[]} items
 * @param {number} index
 * @param {number} step
 */
const moved = (items, index, step) => {
	const to = index + step;
	if (to < 0 || to >= items.length) return items;
	const next = [...items];
	[next[index], next[to]] = [/** @type {T} */ (next[to]), /** @type {T} */ (next[index])];
	return next;
};

/**
 * The `errors` of a 422 answer as lines, whatever their shape (strings, `{ path, message }` or a key → message map).
 * @param {any} problem
 * @returns {string[]}
 */
const errorLines = (problem) => {
	const errors = problem?.errors;
	if (Array.isArray(errors))
		return errors.map((entry) =>
			typeof entry === 'string'
				? entry
				: [entry?.path ?? entry?.field ?? entry?.index, entry?.message ?? entry?.detail]
						.filter((part) => part !== undefined && part !== null && part !== '')
						.map(String)
						.join(': '),
		);
	if (errors && typeof errors === 'object') return Object.entries(errors).map(([key, message]) => `${key}: ${String(message)}`);
	return [];
};

/**
 * Up, down and remove buttons of one entry.
 * @param {{ label: string, index: number, count: number, onMove: (step: number) => void, onRemove: () => void }} props
 */
function EntryHead({ label, index, count, onMove, onRemove }) {
	return (
		<div className="flex flex-wrap items-center gap-1">
			<span className="mr-auto text-sm font-bold">{`${label} ${index + 1}`}</span>
			<Button size="sm" variant="ghost" disabled={index === 0} onClick={() => onMove(-1)} aria-label={L.up}>
				↑
			</Button>
			<Button size="sm" variant="ghost" disabled={index === count - 1} onClick={() => onMove(1)} aria-label={L.down}>
				↓
			</Button>
			<Button size="sm" variant="ghost" onClick={onRemove}>
				{L.remove}
			</Button>
		</div>
	);
}

/**
 * One list, edited as a whole and saved with one PUT.
 * @param {{ websiteId: string, list: string, title: string, help: string, itemLabel: string, max: number,
 *   blank: () => Item, clean: (item: Item) => Item, off?: boolean,
 *   render: (item: Item, set: (patch: Item) => void) => import('react').ReactNode }} props
 */
function ListEditor({ websiteId, list, title, help, itemLabel, max, blank, clean, off, render }) {
	const path = `/v1/dashboard/websites/${websiteId}/lists/${list}`;
	const { answer, reload } = useLoad(path);
	const [draft, setDraft] = useState(/** @type {Item[] | null} */ (null));
	const [result, setResult] = useState(/** @type {import('./api.js').Answer | null} */ (null));
	return (
		<Card title={title} subtitle={off ? TEXTS.settings.off : `${help} ${fill(L.max, { max })}`}>
			<Loaded answer={answer}>
				{(data) => {
					/** @type {Item[]} */
					const items = draft ?? data.items;
					/** @param {number} index @param {Item} patch */
					const set = (index, patch) => setDraft(items.map((item, at) => (at === index ? { ...item, ...patch } : item)));
					const problems = result && !result.ok ? errorLines(result.problem) : [];
					return (
						<div className="space-y-4">
							{items.length === 0 ? <p className="text-sm text-muted">{L.none}</p> : null}
							{items.map((item, index) => (
								<div key={index} className="space-y-3 rounded-2xl border border-line p-3 sm:p-4">
									<EntryHead
										label={itemLabel}
										index={index}
										count={items.length}
										onMove={(step) => setDraft(moved(items, index, step))}
										onRemove={() => setDraft(items.filter((_, at) => at !== index))}
									/>
									{render(item, (patch) => set(index, patch))}
								</div>
							))}
							<div className="flex flex-wrap gap-2">
								<Button
									size="sm"
									variant="secondary"
									disabled={items.length >= max}
									onClick={() => setDraft([...items, blank()])}>
									{L.add}
								</Button>
								<Button
									size="sm"
									disabled={draft === null}
									onClick={async () => {
										const next = await call('PUT', path, { items: items.map(clean) });
										setResult(next);
										if (next.ok) {
											setDraft(null);
											reload();
										}
									}}>
									{L.saveList}
								</Button>
								{draft !== null ? (
									<Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
										{TEXTS.cancel}
									</Button>
								) : null}
							</div>
							{result && !result.ok && problems.length > 0 ? (
								<Callout tone="danger" title={L.errors}>
									<ul className="list-disc pl-5">
										{problems.map((line) => (
											<li key={line}>{line}</li>
										))}
									</ul>
								</Callout>
							) : result && !result.ok ? (
								<Callout tone="danger">{describeProblem(result.problem)}</Callout>
							) : result ? (
								<Callout tone="success">{TEXTS.saved}</Callout>
							) : null}
						</div>
					);
				}}
			</Loaded>
		</Card>
	);
}

/** @typedef {{ websiteId: string, off?: boolean }} EditorProps */

const T = L.tools;
const PARAMETER_TYPES = /** @type {const} */ (['string', 'number', 'boolean']);

/** @param {EditorProps} props */
export function ToolsEditor({ websiteId, off }) {
	return (
		<ListEditor
			websiteId={websiteId}
			list="tools"
			title={T.title}
			help={T.help}
			itemLabel={T.item}
			max={20}
			off={off}
			blank={() => ({ name: '', description: '', url: 'https://', parameters: [], includeVisitor: false })}
			clean={(tool) => ({
				name: String(tool.name).trim(),
				description: String(tool.description).trim(),
				url: String(tool.url).trim(),
				parameters: (tool.parameters ?? []).map((/** @type {Item} */ p) => ({ ...p, name: String(p.name).trim() })),
				includeVisitor: tool.includeVisitor === true,
			})}
			render={(tool, set) => {
				/** @type {Item[]} */
				const parameters = tool.parameters ?? [];
				/** @param {number} index @param {Item} patch */
				const setParameter = (index, patch) =>
					set({ parameters: parameters.map((p, at) => (at === index ? { ...p, ...patch } : p)) });
				return (
					<>
						<div className="grid gap-3 md:grid-cols-2">
							<Input
								label={T.name}
								value={tool.name}
								maxLength={41}
								autoComplete="off"
								onChange={(event) => set({ name: event.target.value })}
							/>
							<Input label={T.url} type="url" value={tool.url} onChange={(event) => set({ url: event.target.value })} />
						</div>
						<TextArea
							label={T.description}
							rows={2}
							value={tool.description}
							onChange={(event) => set({ description: event.target.value })}
						/>
						<Checkbox
							label={T.includeVisitor}
							checked={tool.includeVisitor === true}
							onChange={(event) => set({ includeVisitor: event.target.checked })}
						/>
						<p className="text-sm font-semibold">{T.parameters}</p>
						{parameters.map((parameter, index) => (
							<div key={index} className="space-y-2 rounded-xl bg-surface-2 p-3">
								<EntryHead
									label={T.parameter}
									index={index}
									count={parameters.length}
									onMove={(step) => set({ parameters: moved(parameters, index, step) })}
									onRemove={() => set({ parameters: parameters.filter((_, at) => at !== index) })}
								/>
								<div className="grid gap-3 md:grid-cols-3">
									<Input
										label={T.parameter}
										value={parameter.name}
										autoComplete="off"
										onChange={(event) => setParameter(index, { name: event.target.value })}
									/>
									<Select
										label={T.type}
										value={parameter.type}
										options={PARAMETER_TYPES.map((value) => ({ value, label: T.types[value] }))}
										onChange={(event) => setParameter(index, { type: event.target.value })}
									/>
									<Input
										label={T.description}
										value={parameter.description}
										onChange={(event) => setParameter(index, { description: event.target.value })}
									/>
								</div>
								<Checkbox
									label={T.required}
									checked={parameter.required === true}
									onChange={(event) => setParameter(index, { required: event.target.checked })}
								/>
							</div>
						))}
						<Button
							size="sm"
							variant="ghost"
							disabled={parameters.length >= 10}
							onClick={() =>
								set({ parameters: [...parameters, { name: '', type: 'string', description: '', required: false }] })
							}>
							{T.addParameter}
						</Button>
					</>
				);
			}}
		/>
	);
}

const P = L.pageRules;

/** @param {EditorProps} props */
export function PageRulesEditor({ websiteId, off }) {
	return (
		<ListEditor
			websiteId={websiteId}
			list="page_rules"
			title={P.title}
			help={P.help}
			itemLabel={P.item}
			max={20}
			off={off}
			blank={() => ({ path: '/', delay: 10, message: '' })}
			clean={(rule) => ({
				path: String(rule.path).trim(),
				delay: Number(rule.delay) || 0,
				message: String(rule.message).trim(),
			})}
			render={(rule, set) => (
				<>
					<div className="grid gap-3 md:grid-cols-2">
						<Input label={P.path} value={rule.path} onChange={(event) => set({ path: event.target.value })} />
						<Input
							label={P.delay}
							type="number"
							min={0}
							max={3600}
							value={String(rule.delay)}
							onChange={(event) => set({ delay: Number(event.target.value) })}
						/>
					</div>
					<TextArea
						label={P.message}
						rows={2}
						value={rule.message}
						onChange={(event) => set({ message: event.target.value })}
					/>
				</>
			)}
		/>
	);
}

const C = L.customFields;
const FIELD_TYPES = /** @type {const} */ (['text', 'number', 'yes_no', 'choice']);

/** @param {EditorProps} props */
export function CustomFieldsEditor({ websiteId, off }) {
	return (
		<ListEditor
			websiteId={websiteId}
			list="custom_fields"
			title={C.title}
			help={C.help}
			itemLabel={C.item}
			max={30}
			off={off}
			blank={() => ({ key: '', label: '', type: 'text', options: [] })}
			clean={(field) => ({
				key: String(field.key).trim(),
				label: String(field.label).trim(),
				type: field.type,
				options: field.type === 'choice' ? cleanLines(field.options) : [],
			})}
			render={(field, set) => (
				<>
					<div className="grid gap-3 md:grid-cols-3">
						<Input
							label={C.key}
							value={field.key}
							maxLength={40}
							autoComplete="off"
							onChange={(event) => set({ key: event.target.value })}
						/>
						<Input label={C.label} value={field.label} onChange={(event) => set({ label: event.target.value })} />
						<Select
							label={C.type}
							value={field.type}
							options={FIELD_TYPES.map((value) => ({ value, label: C.types[value] }))}
							onChange={(event) => set({ type: event.target.value })}
						/>
					</div>
					{field.type === 'choice' ? (
						<TextArea
							label={C.options}
							rows={4}
							value={(field.options ?? []).join('\n')}
							onChange={(event) => set({ options: toLines(event.target.value) })}
						/>
					) : null}
				</>
			)}
		/>
	);
}

const F = L.flows;
const STEP_KINDS = /** @type {const} */ (['message', 'question', 'collect', 'handoff', 'end']);
const BASE_FIELDS = /** @type {const} */ (['name', 'email', 'phone', 'text']);

/**
 * A fresh step of `kind`, keeping the text of the step it replaces.
 * @param {string} kind
 * @param {Item} [from]
 * @returns {Item}
 */
const stepOf = (kind, from = {}) => {
	const text = typeof from.text === 'string' ? from.text : '';
	if (kind === 'message') return { kind, text };
	if (kind === 'question') return { kind, text, buttons: Array.isArray(from.buttons) ? from.buttons : [] };
	if (kind === 'collect') return { kind, field: typeof from.field === 'string' ? from.field : 'email', text };
	return { kind };
};

/**
 * A step as saved.
 * @param {Item} step
 */
const cleanStep = (step) => {
	const base = stepOf(step.kind, step);
	if ('text' in base) base.text = String(base.text).trim();
	if (step.kind === 'question') base.buttons = cleanLines(step.buttons);
	return base;
};

/** @param {EditorProps & { customFields: boolean }} props `customFields`: offer the custom fields to collect */
export function FlowsEditor({ websiteId, off, customFields }) {
	const custom = useLoad(customFields ? `/v1/dashboard/websites/${websiteId}/lists/custom_fields` : null);
	/** @type {Array<{ key: string, label: string }>} */
	const extra = custom.answer?.ok ? custom.answer.data.items : [];
	const fieldOptions = [
		...BASE_FIELDS.map((value) => ({ value, label: F.fields[value] })),
		...extra.map((field) => ({ value: `custom:${field.key}`, label: fill(F.custom, { label: field.label }) })),
	];
	return (
		<ListEditor
			websiteId={websiteId}
			list="flows"
			title={F.title}
			help={F.help}
			itemLabel={F.item}
			max={20}
			off={off}
			blank={() => ({ id: '', name: '', start: { kind: 'page', path: '/', delay: 5 }, steps: [stepOf('message')] })}
			clean={(flow) => ({
				id: String(flow.id).trim(),
				name: String(flow.name).trim(),
				start:
					flow.start?.kind === 'keyword'
						? { kind: 'keyword', keywords: cleanLines(flow.start.keywords) }
						: { kind: 'page', path: String(flow.start?.path ?? '').trim(), delay: Number(flow.start?.delay) || 0 },
				steps: (flow.steps ?? []).map(cleanStep),
			})}
			render={(flow, set) => {
				/** @type {Item} */
				const start = flow.start ?? { kind: 'page', path: '/', delay: 0 };
				/** @type {Item[]} */
				const steps = flow.steps ?? [];
				/** @param {number} index @param {Item} next */
				const setStep = (index, next) => set({ steps: steps.map((step, at) => (at === index ? next : step)) });
				return (
					<>
						<div className="grid gap-3 md:grid-cols-3">
							<Input
								label={F.id}
								value={flow.id}
								maxLength={40}
								autoComplete="off"
								onChange={(event) => set({ id: event.target.value })}
							/>
							<Input label={F.name} value={flow.name} onChange={(event) => set({ name: event.target.value })} />
							<Select
								label={F.start}
								value={start.kind}
								options={[
									{ value: 'page', label: F.starts.page },
									{ value: 'keyword', label: F.starts.keyword },
								]}
								onChange={(event) =>
									set({
										start:
											event.target.value === 'keyword'
												? { kind: 'keyword', keywords: [] }
												: { kind: 'page', path: '/', delay: 5 },
									})
								}
							/>
						</div>
						{start.kind === 'keyword' ? (
							<TextArea
								label={F.keywords}
								rows={3}
								value={(start.keywords ?? []).join('\n')}
								onChange={(event) => set({ start: { ...start, keywords: toLines(event.target.value) } })}
							/>
						) : (
							<div className="grid gap-3 md:grid-cols-2">
								<Input
									label={F.path}
									value={start.path}
									onChange={(event) => set({ start: { ...start, path: event.target.value } })}
								/>
								<Input
									label={F.delay}
									type="number"
									min={0}
									max={3600}
									value={String(start.delay)}
									onChange={(event) => set({ start: { ...start, delay: Number(event.target.value) } })}
								/>
							</div>
						)}
						<p className="text-sm font-semibold">{F.steps}</p>
						{steps.map((step, index) => (
							<div key={index} className="space-y-2 rounded-xl bg-surface-2 p-3">
								<EntryHead
									label={F.step}
									index={index}
									count={steps.length}
									onMove={(move) => set({ steps: moved(steps, index, move) })}
									onRemove={() => set({ steps: steps.filter((_, at) => at !== index) })}
								/>
								<div className="grid gap-3 md:grid-cols-2">
									<Select
										label={F.step}
										value={step.kind}
										options={STEP_KINDS.map((value) => ({ value, label: F.kinds[value] }))}
										onChange={(event) => setStep(index, stepOf(event.target.value, step))}
									/>
									{step.kind === 'collect' ? (
										<Select
											label={F.field}
											value={step.field}
											options={
												fieldOptions.some((option) => option.value === step.field)
													? fieldOptions
													: [...fieldOptions, { value: step.field, label: step.field }]
											}
											onChange={(event) => setStep(index, { ...step, field: event.target.value })}
										/>
									) : null}
								</div>
								{'text' in step ? (
									<TextArea
										label={F.text}
										rows={2}
										value={step.text}
										onChange={(event) => setStep(index, { ...step, text: event.target.value })}
									/>
								) : null}
								{step.kind === 'question' ? (
									<TextArea
										label={F.buttons}
										rows={3}
										value={(step.buttons ?? []).join('\n')}
										onChange={(event) => setStep(index, { ...step, buttons: toLines(event.target.value) })}
									/>
								) : null}
							</div>
						))}
						<Button
							size="sm"
							variant="ghost"
							disabled={steps.length >= 20}
							onClick={() => set({ steps: [...steps, stepOf('message')] })}>
							{F.addStep}
						</Button>
					</>
				);
			}}
		/>
	);
}

const S = TEXTS.secret;

/** @param {{ websiteId: string }} props */
export function ToolSecret({ websiteId }) {
	const path = `/v1/dashboard/websites/${websiteId}/tool-secret`;
	const [secret, setSecret] = useState(/** @type {string | null} */ (null));
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState(/** @type {import('./api.js').Answer | null} */ (null));
	/** @param {'GET' | 'POST'} method */
	const load = async (method) => {
		setBusy(true);
		const next = await call(method, path);
		setBusy(false);
		setResult(next.ok ? null : next);
		if (next.ok) setSecret(next.data.secret);
	};
	return (
		<Card title={S.title} subtitle={S.help}>
			{secret ? <CodeBlock code={secret} secret /> : null}
			<div className="mt-3 flex flex-wrap gap-2">
				<Button
					size="sm"
					variant="secondary"
					loading={busy && !confirming}
					onClick={() => (secret ? setSecret(null) : void load('GET'))}>
					{secret ? S.hide : S.reveal}
				</Button>
				<Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
					{S.regenerate}
				</Button>
			</div>
			{result && !result.ok ? <Callout tone="danger">{describeProblem(result.problem)}</Callout> : null}
			<ConfirmDialog
				open={confirming}
				busy={busy}
				danger
				title={S.confirmTitle}
				confirmLabel={S.regenerate}
				cancelLabel={TEXTS.cancel}
				onClose={() => setConfirming(false)}
				onConfirm={async () => {
					await load('POST');
					setConfirming(false);
				}}>
				<p>{S.confirmText}</p>
			</ConfirmDialog>
		</Card>
	);
}
