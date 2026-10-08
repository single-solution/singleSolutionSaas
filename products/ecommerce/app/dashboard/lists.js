'use client';
/**
 * Settings list editors (Ecommerce's list settings, `adapters/lists.js`): the order flow (statuses with roles and the
 * allowed moves), couriers, delivery zones, tax rules, condition grades and booking hours. Each list is read with
 * `GET /v1/dashboard/websites/:websiteId/lists/:list` and saved whole with `PUT … { value }`; a 422 lists the server's
 * check errors, which are shown under the editor.
 * @module
 */
import { useState } from 'react';
import { Button, Callout, Card, CheckboxGroup, Input, Select, TextArea, describeProblem } from '@ss/ui';
import { DEFAULT_FLOW, canMove } from '../../core/flow.js';
import { STATUS_ROLES } from '../../core/model.js';
import { exponentOf, fromDecimal, toDecimal } from '../../core/money.js';
import { call, fill, useLoad } from './api.js';
import { Loaded } from './parts.js';
import { TEXTS } from './texts.js';

/** @typedef {Record<string, any>} Item */
/** @typedef {import('../../core/model.js').OrderFlow} OrderFlow */
/** @typedef {{ websiteId: string, off?: boolean }} EditorProps */

const L = TEXTS.lists;

/**
 * Lines as saved: trimmed, empty ones dropped.
 * @param {unknown} lines
 */
const cleanLines = (lines) =>
	(Array.isArray(lines) ? lines : []).map((line) => String(line).trim()).filter((line) => line !== '');

/**
 * A key made from a name when none was typed (`Express Delivery` → `express_delivery`).
 * @param {unknown} key
 * @param {unknown} name
 */
const keyOf = (key, name) => {
	const typed = String(key ?? '').trim();
	if (typed !== '') return typed;
	const made = String(name ?? '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^[^a-z]+|_+$/g, '')
		.slice(0, 40);
	return made;
};

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
 * The list routes put every error on `/value`, so that path is left out.
 * @param {any} problem
 * @returns {string[]}
 */
const errorLines = (problem) => {
	const errors = problem?.errors;
	if (Array.isArray(errors))
		return errors.map((entry) =>
			typeof entry === 'string'
				? entry
				: [entry?.path === '/value' ? undefined : (entry?.path ?? entry?.field), entry?.message ?? entry?.detail]
						.filter((part) => part !== undefined && part !== null && part !== '')
						.map(String)
						.join(': '),
		);
	if (errors && typeof errors === 'object') return Object.entries(errors).map(([key, message]) => `${key}: ${String(message)}`);
	return [];
};

/**
 * Minor units from a decimal typed in the shop currency: empty → `empty`, zero → 0, else the amount or undefined.
 * @param {unknown} text
 * @param {string} currency
 * @param {number | null} empty
 * @returns {number | null | undefined}
 */
const amountOf = (text, currency, empty) => {
	const value = String(text ?? '').trim();
	if (value === '') return empty;
	if (/^0*(\.0*)?$/.test(value)) return 0;
	return fromDecimal(value, currency) ?? undefined;
};

/**
 * A saved amount as the decimal shown while editing.
 * @param {unknown} amount minor units
 * @param {string} currency
 */
const decimalOf = (amount, currency) =>
	typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0 ? toDecimal(amount, currency) : '';

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
 * The outcome of a save: local errors, the server's check errors, another problem, or saved.
 * @param {{ result: import('./api.js').Answer | null, local: string[] }} props
 */
function ListOutcome({ result, local }) {
	const problems = local.length > 0 ? local : result && !result.ok ? errorLines(result.problem) : [];
	if (problems.length > 0)
		return (
			<Callout tone="danger" title={L.errors}>
				<ul className="list-disc pl-5">
					{problems.map((line) => (
						<li key={line}>{line}</li>
					))}
				</ul>
			</Callout>
		);
	if (result && !result.ok) return <Callout tone="danger">{describeProblem(result.problem)}</Callout>;
	return result ? <Callout tone="success">{TEXTS.saved}</Callout> : null;
}

/**
 * Save and Cancel under an editor.
 * @param {{ dirty: boolean, onSave: () => Promise<void>, onCancel: () => void, children?: import('react').ReactNode }} props
 */
function SaveRow({ dirty, onSave, onCancel, children }) {
	const [busy, setBusy] = useState(false);
	return (
		<div className="flex flex-wrap gap-2">
			{children}
			<Button
				size="sm"
				disabled={!dirty}
				loading={busy}
				onClick={async () => {
					setBusy(true);
					await onSave();
					setBusy(false);
				}}>
				{L.saveList}
			</Button>
			{dirty ? (
				<Button size="sm" variant="ghost" onClick={onCancel}>
					{TEXTS.cancel}
				</Button>
			) : null}
		</div>
	);
}

/**
 * Load and save one list: the saved value, the draft, the last outcome.
 * @param {string} websiteId
 * @param {string} list
 */
const useList = (websiteId, list) => {
	const path = `/v1/dashboard/websites/${websiteId}/lists/${list}`;
	const { answer, reload } = useLoad(path);
	const [draft, setDraft] = useState(/** @type {any} */ (null));
	const [result, setResult] = useState(/** @type {import('./api.js').Answer | null} */ (null));
	const [local, setLocal] = useState(/** @type {string[]} */ ([]));
	/** @param {unknown} value */
	const save = async (value) => {
		setLocal([]);
		const next = await call('PUT', path, { value });
		setResult(next);
		if (next.ok) {
			setDraft(null);
			reload();
		}
	};
	/** @param {string[]} problems */
	const refuse = (problems) => {
		setResult(null);
		setLocal(problems);
	};
	return { answer, draft, setDraft, result, local, save, refuse };
};

/**
 * A list of records, edited as a whole and saved with one PUT. `load` turns a saved record into its draft (amounts as
 * decimals), `clean` a draft back into the record to save, `check` finds draft problems before anything is sent.
 * @param {{ websiteId: string, list: string, title: string, help: string, itemLabel: string, max: number,
 *   blank: () => Item, load?: (item: Item) => Item, clean: (item: Item) => Item, check?: (items: Item[]) => string[],
 *   off?: boolean, render: (item: Item, set: (patch: Item) => void) => import('react').ReactNode }} props
 */
function ListEditor({ websiteId, list, title, help, itemLabel, max, blank, load = (item) => item, clean, check, off, render }) {
	const state = useList(websiteId, list);
	return (
		<Card title={title} subtitle={off ? TEXTS.settings.off : `${help} ${fill(L.max, { max })}`}>
			<Loaded answer={state.answer}>
				{(data) => {
					/** @type {Item[]} */
					const items = state.draft ?? (Array.isArray(data.value) ? data.value : []).map(load);
					/** @param {Item[]} next */
					const setItems = (next) => state.setDraft(next);
					/** @param {number} index @param {Item} patch */
					const set = (index, patch) => setItems(items.map((item, at) => (at === index ? { ...item, ...patch } : item)));
					return (
						<div className="space-y-4">
							{items.length === 0 ? <p className="text-sm text-muted">{L.none}</p> : null}
							{items.map((item, index) => (
								<div key={index} className="space-y-3 rounded-2xl bg-surface-2 p-3 sm:p-4">
									<EntryHead
										label={itemLabel}
										index={index}
										count={items.length}
										onMove={(step) => setItems(moved(items, index, step))}
										onRemove={() => setItems(items.filter((_, at) => at !== index))}
									/>
									{render(item, (patch) => set(index, patch))}
								</div>
							))}
							<SaveRow
								dirty={state.draft !== null}
								onCancel={() => state.setDraft(null)}
								onSave={async () => {
									const problems = check ? check(items) : [];
									if (problems.length > 0) return state.refuse(problems);
									await state.save(items.map(clean));
								}}>
								<Button
									size="sm"
									variant="secondary"
									disabled={items.length >= max}
									onClick={() => setItems([...items, blank()])}>
									{L.add}
								</Button>
							</SaveRow>
							<ListOutcome result={state.result} local={state.local} />
						</div>
					);
				}}
			</Loaded>
		</Card>
	);
}

const C = L.couriers;

/** Couriers: a name and a tracking link template with `{tracking}` (`couriers`, feature checkout). @param {EditorProps} props */
export function CouriersEditor({ websiteId, off }) {
	return (
		<ListEditor
			websiteId={websiteId}
			list="couriers"
			title={C.title}
			help={C.help}
			itemLabel={C.item}
			max={30}
			off={off}
			blank={() => ({ key: '', name: '', trackingUrl: 'https://' })}
			clean={(courier) => ({
				key: keyOf(courier.key, courier.name),
				name: String(courier.name ?? '').trim(),
				trackingUrl: String(courier.trackingUrl ?? '').trim(),
			})}
			render={(courier, set) => (
				<div className="grid gap-3 md:grid-cols-3">
					<Input label={C.name} value={courier.name ?? ''} onChange={(event) => set({ name: event.target.value })} />
					<Input
						label={C.key}
						value={courier.key ?? ''}
						maxLength={40}
						autoComplete="off"
						onChange={(event) => set({ key: event.target.value })}
					/>
					<Input
						label={C.trackingUrl}
						type="url"
						value={courier.trackingUrl ?? ''}
						onChange={(event) => set({ trackingUrl: event.target.value })}
					/>
				</div>
			)}
		/>
	);
}

const Z = L.zones;

/**
 * Delivery zones: cities and areas, the fee and free-over amount (typed as decimals in the shop currency, saved as minor
 * units) and the delivery days (`delivery_zones`).
 * @param {EditorProps & { currency: string }} props
 */
export function ZonesEditor({ websiteId, off, currency }) {
	const step = exponentOf(currency) === 0 ? '1' : String(10 ** -exponentOf(currency));
	return (
		<ListEditor
			websiteId={websiteId}
			list="delivery_zones"
			title={Z.title}
			help={Z.help}
			itemLabel={Z.item}
			max={100}
			off={off}
			blank={() => ({ key: '', name: '', cities: [], areas: [], fee: '', freeOver: '', minDays: '1', maxDays: '3' })}
			load={(zone) => ({
				...zone,
				cities: Array.isArray(zone.cities) ? zone.cities : [],
				areas: Array.isArray(zone.areas) ? zone.areas : [],
				fee: decimalOf(zone.fee, currency),
				freeOver: zone.freeOver ? decimalOf(zone.freeOver, currency) : '',
				minDays: String(zone.minDays ?? ''),
				maxDays: String(zone.maxDays ?? ''),
			})}
			check={(zones) =>
				zones.flatMap((zone, index) =>
					[
						{ text: zone.fee, empty: 0 },
						{ text: zone.freeOver, empty: 0 },
					]
						.filter((entry) => amountOf(entry.text, currency, entry.empty) === undefined)
						.map((entry) =>
							fill(Z.badAmount, { zone: zone.name || `${Z.item} ${index + 1}`, value: String(entry.text), currency }),
						),
				)
			}
			clean={(zone) => ({
				key: keyOf(zone.key, zone.name),
				name: String(zone.name ?? '').trim(),
				cities: cleanLines(zone.cities),
				areas: cleanLines(zone.areas),
				fee: amountOf(zone.fee, currency, 0),
				freeOver: amountOf(zone.freeOver, currency, 0),
				minDays: Number(String(zone.minDays).trim() || 0),
				maxDays: Number(String(zone.maxDays).trim() || zone.minDays || 0),
			})}
			render={(zone, set) => (
				<>
					<div className="grid gap-3 md:grid-cols-2">
						<Input label={Z.name} value={zone.name ?? ''} onChange={(event) => set({ name: event.target.value })} />
						<Input
							label={Z.key}
							value={zone.key ?? ''}
							maxLength={40}
							autoComplete="off"
							onChange={(event) => set({ key: event.target.value })}
						/>
						<TextArea
							label={Z.cities}
							rows={3}
							value={zone.cities.join('\n')}
							onChange={(event) => set({ cities: event.target.value.split('\n') })}
						/>
						<TextArea
							label={Z.areas}
							rows={3}
							value={zone.areas.join('\n')}
							onChange={(event) => set({ areas: event.target.value.split('\n') })}
						/>
					</div>
					<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
						<Input
							label={fill(Z.fee, { currency })}
							type="number"
							min={0}
							step={step}
							inputMode="decimal"
							value={zone.fee}
							onChange={(event) => set({ fee: event.target.value })}
						/>
						<Input
							label={fill(Z.freeOver, { currency })}
							type="number"
							min={0}
							step={step}
							inputMode="decimal"
							value={zone.freeOver}
							onChange={(event) => set({ freeOver: event.target.value })}
						/>
						<Input
							label={Z.minDays}
							type="number"
							min={0}
							value={zone.minDays}
							onChange={(event) => set({ minDays: event.target.value })}
						/>
						<Input
							label={Z.maxDays}
							type="number"
							min={0}
							value={zone.maxDays}
							onChange={(event) => set({ maxDays: event.target.value })}
						/>
					</div>
				</>
			)}
		/>
	);
}

const G = L.grades;

/**
 * Whole days typed, or null when left empty (the feature's own default applies).
 * @param {unknown} text
 */
const daysOf = (text) => {
	const value = String(text ?? '').trim();
	return value === '' ? null : Number(value);
};

/** Condition grades with their return and warranty days (`grades`, feature grades_serials). @param {EditorProps} props */
export function GradesEditor({ websiteId, off }) {
	return (
		<ListEditor
			websiteId={websiteId}
			list="grades"
			title={G.title}
			help={G.help}
			itemLabel={G.item}
			max={20}
			off={off}
			blank={() => ({ key: '', label: '', description: '', returnDays: '', warrantyDays: '' })}
			load={(grade) => ({
				...grade,
				returnDays: grade.returnDays === null || grade.returnDays === undefined ? '' : String(grade.returnDays),
				warrantyDays: grade.warrantyDays === null || grade.warrantyDays === undefined ? '' : String(grade.warrantyDays),
			})}
			clean={(grade) => ({
				key: keyOf(grade.key, grade.label),
				label: String(grade.label ?? '').trim(),
				description: String(grade.description ?? '').trim(),
				returnDays: daysOf(grade.returnDays),
				warrantyDays: daysOf(grade.warrantyDays),
			})}
			render={(grade, set) => (
				<>
					<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
						<Input label={G.label} value={grade.label ?? ''} onChange={(event) => set({ label: event.target.value })} />
						<Input
							label={G.key}
							value={grade.key ?? ''}
							maxLength={40}
							autoComplete="off"
							onChange={(event) => set({ key: event.target.value })}
						/>
						<Input
							label={G.returnDays}
							type="number"
							min={0}
							value={grade.returnDays}
							onChange={(event) => set({ returnDays: event.target.value })}
						/>
						<Input
							label={G.warrantyDays}
							type="number"
							min={0}
							value={grade.warrantyDays}
							onChange={(event) => set({ warrantyDays: event.target.value })}
						/>
					</div>
					<TextArea
						label={G.description}
						rows={2}
						value={grade.description ?? ''}
						onChange={(event) => set({ description: event.target.value })}
					/>
				</>
			)}
		/>
	);
}

const B = L.bookingHours;

/** Weekly booking hours: a day (0 Sunday – 6 Saturday) and a time range (`booking_hours`). @param {EditorProps} props */
export function BookingHoursEditor({ websiteId, off }) {
	return (
		<ListEditor
			websiteId={websiteId}
			list="booking_hours"
			title={B.title}
			help={B.help}
			itemLabel={B.item}
			max={70}
			off={off}
			blank={() => ({ day: 1, from: '09:00', to: '17:00' })}
			clean={(hours) => ({ day: Number(hours.day), from: String(hours.from ?? ''), to: String(hours.to ?? '') })}
			render={(hours, set) => (
				<div className="grid gap-3 sm:grid-cols-3">
					<Select
						label={B.day}
						value={String(hours.day ?? 1)}
						options={B.days.map((label, day) => ({ value: String(day), label }))}
						onChange={(event) => set({ day: Number(event.target.value) })}
					/>
					<Input
						label={B.from}
						type="time"
						value={hours.from ?? ''}
						onChange={(event) => set({ from: event.target.value })}
					/>
					<Input label={B.to} type="time" value={hours.to ?? ''} onChange={(event) => set({ to: event.target.value })} />
				</div>
			)}
		/>
	);
}

const X = L.taxRules;

/**
 * Tax rules: a name, a percent, the category ids it applies to and the regions (`Country` or `Country, City` per
 * line); empty lists apply everywhere (`tax_rules`, `core/taxes.js`).
 * @param {EditorProps} props
 */
export function TaxRulesEditor({ websiteId, off }) {
	return (
		<ListEditor
			websiteId={websiteId}
			list="tax_rules"
			title={X.title}
			help={X.help}
			itemLabel={X.item}
			max={50}
			off={off}
			blank={() => ({ name: '', percent: '', categoryIds: [], regions: [] })}
			load={(rule) => ({
				name: rule.name ?? '',
				percent: String(rule.percent ?? ''),
				categoryIds: Array.isArray(rule.categoryIds) ? rule.categoryIds : [],
				regions: (Array.isArray(rule.regions) ? rule.regions : []).map((/** @type {Item} */ region) =>
					region.city ? `${region.country}, ${region.city}` : String(region.country ?? ''),
				),
			})}
			clean={(rule) => {
				const percent = String(rule.percent).trim();
				return {
					name: String(rule.name ?? '').trim(),
					percent: percent === '' ? Number.NaN : Number(percent),
					categoryIds: cleanLines(rule.categoryIds),
					regions: cleanLines(rule.regions).map((line) => {
						const comma = line.indexOf(',');
						return comma < 0
							? { country: line, city: '' }
							: { country: line.slice(0, comma).trim(), city: line.slice(comma + 1).trim() };
					}),
				};
			}}
			check={(rules) =>
				rules
					.filter((rule) => !Number.isFinite(Number(String(rule.percent).trim() || Number.NaN)))
					.map((rule) => fill(X.badPercent, { rule: rule.name || X.item }))
			}
			render={(rule, set) => (
				<>
					<div className="grid gap-3 sm:grid-cols-2">
						<Input
							label={X.name}
							value={rule.name}
							maxLength={60}
							onChange={(event) => set({ name: event.target.value })}
						/>
						<Input
							label={X.percent}
							type="number"
							min={0}
							max={100}
							step="0.001"
							inputMode="decimal"
							value={rule.percent}
							onChange={(event) => set({ percent: event.target.value })}
						/>
					</div>
					<div className="grid gap-3 sm:grid-cols-2">
						<TextArea
							label={X.categoryIds}
							rows={3}
							value={rule.categoryIds.join('\n')}
							onChange={(event) => set({ categoryIds: event.target.value.split('\n') })}
						/>
						<TextArea
							label={X.regions}
							rows={3}
							value={rule.regions.join('\n')}
							onChange={(event) => set({ regions: event.target.value.split('\n') })}
						/>
					</div>
				</>
			)}
		/>
	);
}

const F = L.orderFlow;

/**
 * The moves of a flow the role rules allow, among statuses that exist.
 * @param {OrderFlow} flow
 */
const allowedMoves = (flow) => flow.moves.filter((move) => canMove(flow, move.from, move.to));

/**
 * The statuses an order in `from` could move to under the role rules (whether or not the move is ticked).
 * @param {OrderFlow} flow
 * @param {string} from
 */
const possibleTargets = (flow, from) =>
	flow.statuses.filter((status) => canMove({ statuses: flow.statuses, moves: [{ from, to: status.key }] }, from, status.key));

/** @param {OrderFlow} flow @returns {OrderFlow} a copy safe to edit */
const copyFlow = (flow) => ({
	statuses: flow.statuses.map((status) => ({ ...status })),
	moves: flow.moves.map((move) => ({ ...move })),
});

/**
 * The order flow: statuses (key, name, role) in order, and for each status the statuses it may move to. Moves the
 * role rules do not allow are not offered; the server checks the whole flow again (`core/flow.js` `checkOrderFlow`).
 * @param {EditorProps} props
 */
export function OrderFlowEditor({ websiteId, off }) {
	const state = useList(websiteId, 'order_flow');
	const [resetShown, setResetShown] = useState(false);
	return (
		<Card title={F.title} subtitle={off ? TEXTS.settings.off : F.help}>
			<Loaded answer={state.answer}>
				{(data) => {
					/** @type {OrderFlow} */
					const saved =
						data.value && Array.isArray(data.value.statuses) && Array.isArray(data.value.moves) ? data.value : DEFAULT_FLOW;
					/** @type {OrderFlow} */
					const flow = state.draft ?? saved;
					/** @param {OrderFlow} next */
					const setFlow = (next) => state.setDraft(next);
					/** @param {number} index @param {Partial<OrderFlow['statuses'][number]>} patch */
					const setStatus = (index, patch) => {
						const old = flow.statuses[index]?.key ?? '';
						const key = patch.key;
						setFlow({
							statuses: flow.statuses.map((status, at) => (at === index ? { ...status, ...patch } : status)),
							// a renamed key keeps its moves
							moves:
								key === undefined
									? flow.moves
									: flow.moves.map((move) => ({
											from: move.from === old ? key : move.from,
											to: move.to === old ? key : move.to,
										})),
						});
					};
					/** @param {number} index */
					const removeStatus = (index) => {
						const key = flow.statuses[index]?.key;
						setFlow({
							statuses: flow.statuses.filter((_, at) => at !== index),
							moves: flow.moves.filter((move) => move.from !== key && move.to !== key),
						});
					};
					return (
						<div className="space-y-4">
							{flow.statuses.map((status, index) => {
								const targets = possibleTargets(flow, status.key);
								const ticked = flow.moves.filter((move) => move.from === status.key).map((move) => move.to);
								return (
									<div key={index} className="space-y-3 rounded-2xl bg-surface-2 p-3 sm:p-4">
										<EntryHead
											label={F.status}
											index={index}
											count={flow.statuses.length}
											onMove={(step) => setFlow({ ...flow, statuses: moved(flow.statuses, index, step) })}
											onRemove={() => removeStatus(index)}
										/>
										<div className="grid gap-3 md:grid-cols-3">
											<Input
												label={F.label}
												value={status.label}
												maxLength={60}
												onChange={(event) => setStatus(index, { label: event.target.value })}
											/>
											<Input
												label={F.key}
												value={status.key}
												maxLength={40}
												autoComplete="off"
												onChange={(event) => setStatus(index, { key: event.target.value })}
											/>
											<Select
												label={F.role}
												value={status.role}
												options={STATUS_ROLES.map((role) => ({
													value: role,
													label: F.roles[/** @type {keyof typeof F.roles} */ (role)],
												}))}
												onChange={(event) =>
													setStatus(index, {
														role: /** @type {import('../../core/model.js').StatusRole} */ (event.target.value),
													})
												}
											/>
										</div>
										{targets.length > 0 ? (
											<CheckboxGroup
												legend={F.moves}
												options={targets.map((target) => ({ value: target.key, label: target.label || target.key }))}
												value={ticked.filter((key) => targets.some((target) => target.key === key))}
												onChange={(next) =>
													setFlow({
														...flow,
														moves: [
															...flow.moves.filter((move) => move.from !== status.key),
															...next.map((to) => ({ from: status.key, to })),
														],
													})
												}
											/>
										) : (
											<p className="text-sm text-muted">{F.noMoves}</p>
										)}
									</div>
								);
							})}
							{resetShown && state.draft !== null ? <Callout tone="info">{F.resetNote}</Callout> : null}
							<SaveRow
								dirty={state.draft !== null}
								onCancel={() => {
									state.setDraft(null);
									setResetShown(false);
								}}
								onSave={async () => {
									// statuses saved without a key get one from their name; their moves follow
									const keys = new Map(flow.statuses.map((status) => [status.key, keyOf(status.key, status.label)]));
									/** @type {OrderFlow} */
									const next = {
										statuses: flow.statuses.map((status) => ({
											key: keyOf(status.key, status.label),
											label: status.label.trim(),
											role: status.role,
										})),
										moves: flow.moves.map((move) => ({
											from: keys.get(move.from) ?? move.from,
											to: keys.get(move.to) ?? move.to,
										})),
									};
									await state.save({ statuses: next.statuses, moves: allowedMoves(next) });
									setResetShown(false);
								}}>
								<Button
									size="sm"
									variant="secondary"
									disabled={flow.statuses.length >= 30}
									onClick={() =>
										setFlow({
											...flow,
											statuses: [...flow.statuses, { key: '', label: '', role: /** @type {const} */ ('open') }],
										})
									}>
									{L.add}
								</Button>
								<Button
									size="sm"
									variant="ghost"
									onClick={() => {
										setFlow(copyFlow(DEFAULT_FLOW));
										setResetShown(true);
									}}>
									{F.resetFlow}
								</Button>
							</SaveRow>
							<ListOutcome result={state.result} local={state.local} />
						</div>
					);
				}}
			</Loaded>
		</Card>
	);
}
