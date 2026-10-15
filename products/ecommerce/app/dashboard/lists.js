'use client';
/**
 * Settings list editors (Ecommerce's list settings, `adapters/lists.js`): couriers, policies, delivery zones, tax rules, booking
 * hours and role prices, and the pieces the order flow editor (`./flow-editor.js`), the condition grades editor (`./grades.js`) and the
 * item types editor (`./item-types.js`) share. Each list is read with `GET /v1/dashboard/websites/:websiteId/lists/:list` and saved whole
 * with `PUT … { value }`; a 422 lists the server's check errors, which are shown under the editor.
 * @module
 */
import { useState } from 'react';
import {
	Button,
	Callout,
	Card,
	CheckboxGroup,
	FieldGrid,
	Icon,
	IconButton,
	Input,
	Select,
	TextArea,
	describeProblem,
} from '@ss/ui';
import { exponentOf, fromDecimal, toDecimal } from '../../core/money.js';
import { UNIT_STATE_LIMITS } from '../../core/unit-states.js';
import { call, fill, useLoad } from './api.js';
import { cleanLines, keyOf, splitIds, taxRegionLine, taxRegionOf } from './drafts.js';
import { Loaded } from './parts.js';
import { TEXTS } from './texts.js';

/** @typedef {Record<string, any>} Item */
/** @typedef {import('../../core/model.js').OrderFlow} OrderFlow */
/** @typedef {{ websiteId: string, off?: boolean }} EditorProps */

const L = TEXTS.lists;

/**
 * A copy of `items` with the entry at `index` moved by `step` (-1 up, 1 down).
 * @template T
 * @param {T[]} items
 * @param {number} index
 * @param {number} step
 */
export const moved = (items, index, step) => {
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
export const amountOf = (text, currency, empty) => {
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
export const decimalOf = (amount, currency) =>
	typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0 ? toDecimal(amount, currency) : '';

/**
 * Up, down and remove buttons of one entry.
 * @param {{ label: string, index: number, count: number, onMove: (step: number) => void, onRemove: () => void }} props
 */
export function EntryHead({ label, index, count, onMove, onRemove }) {
	return (
		<div className="flex flex-wrap items-center gap-1">
			<span className="mr-auto text-sm font-bold">{`${label} ${index + 1}`}</span>
			<IconButton label={L.up} disabled={index === 0} onClick={() => onMove(-1)}>
				<Icon name="arrowUp" size={14} />
			</IconButton>
			<IconButton label={L.down} disabled={index === count - 1} onClick={() => onMove(1)}>
				<Icon name="arrowDown" size={14} />
			</IconButton>
			<Button size="sm" variant="ghost" onClick={onRemove}>
				{L.remove}
			</Button>
		</div>
	);
}

/**
 * Ids entered as tags: Enter, a comma or leaving the field adds what was typed; pasting several adds them all; each tag
 * has a remove button, and Backspace in the empty field removes the last one.
 * @param {{ label: string, help: string, values: string[], max: number, none: string,
 *   onChange: (next: string[]) => void }} props `none`: what no id means
 */
export function IdTags({ label, help, values, max, none, onChange }) {
	const [text, setText] = useState('');
	/** @param {string} typed */
	const add = (typed) => {
		const found = splitIds(typed).filter((id) => !values.includes(id) && id.length <= 64);
		if (found.length > 0) onChange([...values, ...found].slice(0, max));
		setText('');
	};
	return (
		<div data-cell="" data-wide="" className="min-w-0 space-y-2">
			<Input
				label={label}
				help={help}
				aside={values.length > 0 ? fill(L.count, { count: values.length, max }) : none}
				value={text}
				autoComplete="off"
				disabled={values.length >= max}
				onChange={(event) => {
					const next = event.target.value;
					if (/[\s,;]/.test(next)) add(next);
					else setText(next);
				}}
				onKeyDown={(event) => {
					if (event.key === 'Enter') {
						event.preventDefault();
						add(text);
					} else if (event.key === 'Backspace' && text === '' && values.length > 0) onChange(values.slice(0, -1));
				}}
				onBlur={() => add(text)}
			/>
			{values.length > 0 ? (
				<ul className="flex flex-wrap gap-2">
					{values.map((id) => (
						<li key={id} className="inline-flex items-center gap-1 rounded-lg bg-surface-2 py-0.5 pl-2.5 pr-1 text-xs">
							<code className="break-all">{id}</code>
							<button
								type="button"
								aria-label={fill(L.removeId, { id })}
								onClick={() => onChange(values.filter((value) => value !== id))}
								className="ss-motion ss-press rounded-md p-1 text-muted hover:bg-surface-3 hover:text-fg focus-visible:outline-2 focus-visible:outline-focus">
								<Icon name="close" size={12} />
							</button>
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}

/**
 * The outcome of a save: local errors, the server's check errors, another problem, or saved.
 * @param {{ result: import('./api.js').Answer | null, local: string[] }} props
 */
export function ListOutcome({ result, local }) {
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
export function SaveRow({ dirty, onSave, onCancel, children }) {
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
export const useList = (websiteId, list) => {
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
export function ListEditor({
	websiteId,
	list,
	title,
	help,
	itemLabel,
	max,
	blank,
	load = (item) => item,
	clean,
	check,
	off,
	render,
}) {
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
								<div key={index} data-entry="" className="space-y-3 rounded-xl bg-surface-2 p-4">
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
				<FieldGrid>
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
				</FieldGrid>
			)}
		/>
	);
}

const US = L.unitStates;

/**
 * The merchant's unit states (`unit_states`, feature grades_serials, E38): a name and a key; in stock and sold are
 * fixed.
 * @param {EditorProps} props
 */
export function UnitStatesEditor({ websiteId, off }) {
	return (
		<ListEditor
			websiteId={websiteId}
			list="unit_states"
			title={US.title}
			help={US.help}
			itemLabel={US.item}
			max={UNIT_STATE_LIMITS.states}
			off={off}
			blank={() => ({ key: '', label: '' })}
			clean={(state) => ({ key: keyOf(state.key, state.label), label: String(state.label ?? '').trim() })}
			render={(state, set) => (
				<FieldGrid>
					<Input
						label={US.label}
						value={state.label ?? ''}
						maxLength={UNIT_STATE_LIMITS.label}
						onChange={(event) => set({ label: event.target.value })}
					/>
					<Input
						label={US.key}
						value={state.key ?? ''}
						maxLength={40}
						autoComplete="off"
						onChange={(event) => set({ key: event.target.value })}
					/>
				</FieldGrid>
			)}
		/>
	);
}

const AR = L.addressRegions;

/**
 * The region names checkout offers per country (`address_regions`): a country and its regions, one per line; an
 * address in a listed country picks one of them (exact names, so zones and tax rules match them).
 * @param {EditorProps} props
 */
export function AddressRegionsEditor({ websiteId, off }) {
	return (
		<ListEditor
			websiteId={websiteId}
			list="address_regions"
			title={AR.title}
			help={AR.help}
			itemLabel={AR.item}
			max={50}
			off={off}
			blank={() => ({ country: '', names: [] })}
			load={(entry) => ({ country: entry.country ?? '', names: Array.isArray(entry.names) ? entry.names : [] })}
			clean={(entry) => ({ country: String(entry.country ?? '').trim(), names: cleanLines(entry.names) })}
			render={(entry, set) => (
				<FieldGrid>
					<Input
						label={AR.country}
						value={entry.country}
						maxLength={60}
						onChange={(event) => set({ country: event.target.value })}
					/>
					<TextArea
						label={AR.names}
						rows={4}
						value={entry.names.join('\n')}
						onChange={(event) => set({ names: event.target.value.split('\n') })}
					/>
				</FieldGrid>
			)}
		/>
	);
}

const P = L.policies;

/**
 * The shop's policies (`policies`, feature checkout, E27): a title, a key that names its page and the text, with the
 * placeholders the server fills; the merchant adds, renames, reorders and removes them.
 * @param {EditorProps} props
 */
export function PoliciesEditor({ websiteId, off }) {
	return (
		<ListEditor
			websiteId={websiteId}
			list="policies"
			title={P.title}
			help={P.help}
			itemLabel={P.item}
			max={20}
			off={off}
			blank={() => ({ key: '', title: '', text: '' })}
			clean={(policy) => ({
				key: keyOf(policy.key, policy.title),
				title: String(policy.title ?? '').trim(),
				text: String(policy.text ?? ''),
			})}
			render={(policy, set) => (
				<>
					<FieldGrid>
						<Input
							label={P.name}
							value={policy.title ?? ''}
							maxLength={80}
							onChange={(event) => set({ title: event.target.value })}
						/>
						<Input
							label={P.key}
							value={policy.key ?? ''}
							maxLength={40}
							autoComplete="off"
							onChange={(event) => set({ key: event.target.value })}
						/>
					</FieldGrid>
					<TextArea
						label={P.text}
						value={policy.text ?? ''}
						rows={8}
						onChange={(event) => set({ text: event.target.value })}
					/>
				</>
			)}
		/>
	);
}

const Z = L.zones;

/** The kinds of place a zone may list (`match`), in the editor's order. */
const PLACE_KINDS = Object.freeze(/** @type {const} */ (['countries', 'regions', 'cities', 'areas', 'postcodes']));

/**
 * Delivery zones: the places each delivers to (countries, regions, cities, areas, postcode starts; one per line), the
 * fee and free-over amount (typed as decimals in the shop currency, saved as minor units) and the delivery days
 * (`delivery_zones`).
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
			blank={() => ({
				key: '',
				name: '',
				...Object.fromEntries(PLACE_KINDS.map((kind) => [kind, []])),
				fee: '',
				freeOver: '',
				minDays: '1',
				maxDays: '3',
			})}
			load={(zone) => ({
				...zone,
				...Object.fromEntries(PLACE_KINDS.map((kind) => [kind, Array.isArray(zone.match?.[kind]) ? zone.match[kind] : []])),
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
				match: Object.fromEntries(PLACE_KINDS.map((kind) => [kind, cleanLines(zone[kind])])),
				fee: amountOf(zone.fee, currency, 0),
				freeOver: amountOf(zone.freeOver, currency, 0),
				minDays: Number(String(zone.minDays).trim() || 0),
				maxDays: Number(String(zone.maxDays).trim() || zone.minDays || 0),
			})}
			render={(zone, set) => (
				<FieldGrid>
					<Input label={Z.name} value={zone.name ?? ''} onChange={(event) => set({ name: event.target.value })} />
					<Input
						label={Z.key}
						value={zone.key ?? ''}
						maxLength={40}
						autoComplete="off"
						onChange={(event) => set({ key: event.target.value })}
					/>
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
					{PLACE_KINDS.map((kind) => (
						<TextArea
							key={kind}
							label={Z[kind]}
							rows={3}
							value={zone[kind].join('\n')}
							onChange={(event) => set({ [kind]: event.target.value.split('\n') })}
						/>
					))}
				</FieldGrid>
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
				<FieldGrid>
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
				</FieldGrid>
			)}
		/>
	);
}

const X = L.taxRules;

/**
 * Tax rules: a name, a percent, the category ids it applies to and the regions (`Country, Region, City, Postcode
 * start` per line, the parts after the country optional); empty lists apply everywhere (`tax_rules`, `core/taxes.js`).
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
				regions: (Array.isArray(rule.regions) ? rule.regions : []).map((/** @type {Item} */ region) => taxRegionLine(region)),
			})}
			clean={(rule) => {
				const percent = String(rule.percent).trim();
				return {
					name: String(rule.name ?? '').trim(),
					percent: percent === '' ? Number.NaN : Number(percent),
					categoryIds: cleanLines(rule.categoryIds),
					regions: cleanLines(rule.regions).map(taxRegionOf),
				};
			}}
			check={(rules) =>
				rules
					.filter((rule) => !Number.isFinite(Number(String(rule.percent).trim() || Number.NaN)))
					.map((rule) => fill(X.badPercent, { rule: rule.name || X.item }))
			}
			render={(rule, set) => (
				<FieldGrid>
					<Input label={X.name} value={rule.name} maxLength={60} onChange={(event) => set({ name: event.target.value })} />
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
				</FieldGrid>
			)}
		/>
	);
}

const R = L.rolePrices;

/**
 * Role prices (PLAN 0.8.10 E19, E31, `role_prices`, feature role_pricing): an Accounts role, either the percent off the
 * goods its signed-in shoppers get (0–90) or its price list (a fixed price per product, or per variant, in the shop
 * currency), and the label quotes, orders and invoices show (empty: the server's default).
 * @param {EditorProps & { currency: string }} props
 */
export function RolePricesEditor({ websiteId, off, currency }) {
	const step = exponentOf(currency) === 0 ? '1' : String(10 ** -exponentOf(currency));
	/** @param {Item} entry */
	const badPercent = (entry) => {
		const percent = Number(String(entry.percent).trim() || Number.NaN);
		return !Number.isFinite(percent) || percent < 0 || percent > 90;
	};
	/** @param {Item} row */
	const badPrice = (row) =>
		!/^prd_[A-Za-z0-9_-]{1,64}$/.test(String(row.productId ?? '').trim()) ||
		!/^(var_[A-Za-z0-9_-]{1,64})?$/.test(String(row.variantId ?? '').trim()) ||
		amountOf(row.price, currency, null) === undefined ||
		amountOf(row.price, currency, null) === null;
	return (
		<ListEditor
			websiteId={websiteId}
			list="role_prices"
			title={R.title}
			help={R.help}
			itemLabel={R.item}
			max={20}
			off={off}
			blank={() => ({ role: '', kind: 'percent', percent: '', prices: [], label: '' })}
			load={(entry) => ({
				role: entry.role ?? '',
				kind: entry.kind === 'prices' ? 'prices' : 'percent',
				percent: entry.kind === 'prices' ? '' : String(entry.percent ?? ''),
				prices: (Array.isArray(entry.prices) ? entry.prices : []).map((/** @type {Item} */ row) => ({
					productId: row.productId ?? '',
					variantId: row.variantId ?? '',
					price: decimalOf(row.price, currency),
				})),
				label: entry.label ?? '',
			})}
			clean={(entry) => {
				const role = String(entry.role ?? '').trim();
				const label = String(entry.label ?? '').trim();
				if (entry.kind === 'prices')
					return {
						role,
						kind: 'prices',
						prices: /** @type {Item[]} */ (entry.prices).map((row) => ({
							productId: String(row.productId ?? '').trim(),
							variantId: String(row.variantId ?? '').trim() || null,
							price: amountOf(row.price, currency, null),
						})),
						label,
					};
				const percent = String(entry.percent).trim();
				return { role, kind: 'percent', percent: percent === '' ? Number.NaN : Number(percent), label };
			}}
			check={(entries) =>
				entries.flatMap((entry) => {
					const name = String(entry.role ?? '').trim() || R.item;
					if (entry.kind !== 'prices') return badPercent(entry) ? [fill(R.badPercent, { role: name })] : [];
					/** @type {Item[]} */
					const rows = entry.prices;
					if (rows.length === 0) return [fill(R.noPrices, { role: name })];
					return rows.some(badPrice) ? [fill(R.badPrice, { role: name, currency })] : [];
				})
			}
			render={(entry, set) => {
				/** @type {Item[]} */
				const rows = entry.prices;
				/** @param {number} at @param {Item} patch */
				const setRow = (at, patch) => set({ prices: rows.map((row, index) => (index === at ? { ...row, ...patch } : row)) });
				return (
					<div className="space-y-3">
						<FieldGrid>
							<Input
								label={R.role}
								help={R.roleHelp}
								value={entry.role}
								maxLength={40}
								autoComplete="off"
								onChange={(event) => set({ role: event.target.value })}
							/>
							<Select
								label={R.kind}
								value={entry.kind}
								options={[
									{ value: 'percent', label: R.kindPercent },
									{ value: 'prices', label: R.kindPrices },
								]}
								onChange={(event) => set({ kind: event.target.value })}
							/>
							{entry.kind === 'prices' ? null : (
								<Input
									label={R.percent}
									type="number"
									min={0}
									max={90}
									step="0.01"
									inputMode="decimal"
									value={entry.percent}
									onChange={(event) => set({ percent: event.target.value })}
								/>
							)}
							<Input
								label={R.label}
								help={R.labelHelp}
								value={entry.label}
								maxLength={60}
								onChange={(event) => set({ label: event.target.value })}
							/>
						</FieldGrid>
						{entry.kind === 'prices' ? (
							<div className="space-y-2">
								<p className="text-sm text-muted">{R.pricesHelp}</p>
								{rows.map((row, at) => (
									<div key={at} data-price="" className="flex flex-wrap items-end gap-2">
										<Input
											label={R.productId}
											value={row.productId}
											maxLength={70}
											autoComplete="off"
											onChange={(event) => setRow(at, { productId: event.target.value })}
										/>
										<Input
											label={R.variantId}
											help={R.variantIdHelp}
											value={row.variantId}
											maxLength={70}
											autoComplete="off"
											onChange={(event) => setRow(at, { variantId: event.target.value })}
										/>
										<Input
											label={fill(R.price, { currency })}
											type="number"
											min={0}
											step={step}
											inputMode="decimal"
											value={row.price}
											onChange={(event) => setRow(at, { price: event.target.value })}
										/>
										<IconButton
											label={R.removePrice}
											onClick={() => set({ prices: rows.filter((_, index) => index !== at) })}>
											<Icon name="close" size={14} />
										</IconButton>
									</div>
								))}
								<Button
									size="sm"
									variant="ghost"
									disabled={rows.length >= 500}
									onClick={() => set({ prices: [...rows, { productId: '', variantId: '', price: '' }] })}>
									{R.addPrice}
								</Button>
							</div>
						) : null}
					</div>
				);
			}}
		/>
	);
}

const S = L.segments;

/** The fields a segment rule reads, in the order the editor offers them (`core/customer-segments.js`). */
const SEGMENT_FIELD_KINDS = Object.freeze({
	tag: 'text',
	orders: 'number',
	spent: 'money',
	last_order: 'days',
	city: 'text',
	region: 'text',
	country: 'text',
	guest: 'flag',
	blocked: 'flag',
	loyalty: 'flag',
	field: 'value',
});
/** The operators of each kind. */
const SEGMENT_OPS = Object.freeze({
	text: ['is', 'is_not'],
	number: ['gte', 'lte'],
	money: ['gte', 'lte'],
	days: ['within', 'not_within'],
	flag: ['is'],
	value: ['is', 'is_not', 'set', 'not_set'],
});

/**
 * A rule's draft from a saved rule: `field` (a customer field is `field` with its id in `fieldId`), `op`, `value` as text.
 * @param {Item} rule @param {string} currency
 */
const ruleDraft = (rule, currency) => {
	const custom = String(rule.field ?? '').startsWith('field:');
	const field = custom ? 'field' : String(rule.field ?? 'tag');
	const value = rule.value;
	return {
		field,
		fieldId: custom ? String(rule.field).slice('field:'.length) : '',
		op: String(rule.op ?? 'is'),
		value: field === 'spent' ? decimalOf(value, currency) : value === null || value === undefined ? '' : String(value),
	};
};

/**
 * A rule as saved, from its draft (undefined: the value is not one).
 * @param {Item} draft @param {string} currency
 */
const ruleOf = (draft, currency) => {
	const kind = SEGMENT_FIELD_KINDS[/** @type {keyof typeof SEGMENT_FIELD_KINDS} */ (draft.field)] ?? 'text';
	const field = draft.field === 'field' ? `field:${String(draft.fieldId ?? '').trim()}` : draft.field;
	const text = String(draft.value ?? '').trim();
	if (kind === 'flag') return { field, op: 'is', value: text !== 'false' };
	if (kind === 'value' && (draft.op === 'set' || draft.op === 'not_set')) return { field, op: draft.op, value: null };
	if (kind === 'money') {
		const amount = amountOf(text, currency, null);
		return amount === undefined || amount === null ? undefined : { field, op: draft.op, value: amount };
	}
	if (kind === 'number' || kind === 'days')
		return /^\d{1,12}$/.test(text) ? { field, op: draft.op, value: Number(text) } : undefined;
	return text === '' ? undefined : { field, op: draft.op, value: text };
};

/**
 * Saved customer segments (E11, `customer_segments`, feature checkout): each a name, a key, whether every rule or any
 * one must match, and rules over tags, orders, spend, the last order, place, guest, blocked, loyalty and customer
 * fields. A website starts with today's three (loyalty, active, guest). The customers widget lists each segment.
 * @param {EditorProps & { currency: string }} props
 */
export function SegmentsEditor({ websiteId, off, currency }) {
	const step = exponentOf(currency) === 0 ? '1' : String(10 ** -exponentOf(currency));
	return (
		<ListEditor
			websiteId={websiteId}
			list="customer_segments"
			title={S.title}
			help={S.help}
			itemLabel={S.item}
			max={30}
			off={off}
			blank={() => ({ key: '', name: '', match: 'all', rules: [{ field: 'tag', fieldId: '', op: 'is', value: '' }] })}
			load={(segment) => ({
				key: segment.key ?? '',
				name: segment.name ?? '',
				match: segment.match === 'any' ? 'any' : 'all',
				rules: (Array.isArray(segment.rules) ? segment.rules : []).map((rule) => ruleDraft(rule, currency)),
			})}
			clean={(segment) => ({
				key: keyOf(segment.key, segment.name),
				name: String(segment.name ?? '').trim(),
				match: segment.match === 'any' ? 'any' : 'all',
				rules: /** @type {Item[]} */ (segment.rules).map((rule) => ruleOf(rule, currency) ?? rule),
			})}
			check={(segments) =>
				segments.flatMap((segment, index) =>
					/** @type {Item[]} */ (segment.rules)
						.filter((rule) => ruleOf(rule, currency) === undefined)
						.map(() => fill(S.badRule, { segment: String(segment.name ?? '').trim() || `${S.item} ${index + 1}` })),
				)
			}
			render={(segment, set) => {
				/** @type {Item[]} */
				const rules = segment.rules;
				/** @param {number} at @param {Item} patch */
				const setRule = (at, patch) =>
					set({ rules: rules.map((rule, index) => (index === at ? { ...rule, ...patch } : rule)) });
				return (
					<div className="space-y-3">
						<FieldGrid>
							<Input
								label={S.name}
								value={segment.name}
								maxLength={60}
								onChange={(event) => set({ name: event.target.value })}
							/>
							<Input
								label={S.key}
								help={S.keyHelp}
								value={segment.key}
								maxLength={40}
								autoComplete="off"
								onChange={(event) => set({ key: event.target.value })}
							/>
							<Select
								label={S.match}
								value={segment.match}
								options={[
									{ value: 'all', label: S.matchAll },
									{ value: 'any', label: S.matchAny },
								]}
								onChange={(event) => set({ match: event.target.value })}
							/>
						</FieldGrid>
						{rules.map((rule, at) => {
							const kind = SEGMENT_FIELD_KINDS[/** @type {keyof typeof SEGMENT_FIELD_KINDS} */ (rule.field)] ?? 'text';
							const ops = /** @type {readonly string[]} */ (SEGMENT_OPS[kind]);
							return (
								<div key={at} data-rule="" className="flex flex-wrap items-end gap-2">
									<Select
										label={S.field}
										value={rule.field}
										options={Object.keys(SEGMENT_FIELD_KINDS).map((field) => ({
											value: field,
											label: S.fields[/** @type {keyof typeof S.fields} */ (field)],
										}))}
										onChange={(event) => {
											const next = event.target.value;
											const nextKind = SEGMENT_FIELD_KINDS[/** @type {keyof typeof SEGMENT_FIELD_KINDS} */ (next)];
											setRule(at, {
												field: next,
												op: SEGMENT_OPS[nextKind][0],
												value: nextKind === 'flag' ? 'true' : '',
											});
										}}
									/>
									{kind === 'value' ? (
										<Input
											label={S.fieldId}
											help={S.fieldIdHelp}
											value={rule.fieldId}
											maxLength={64}
											autoComplete="off"
											onChange={(event) => setRule(at, { fieldId: event.target.value })}
										/>
									) : null}
									{ops.length > 1 ? (
										<Select
											label={S.op}
											value={rule.op}
											options={ops.map((op) => ({ value: op, label: S.ops[/** @type {keyof typeof S.ops} */ (op)] }))}
											onChange={(event) => setRule(at, { op: event.target.value })}
										/>
									) : null}
									{kind === 'flag' ? (
										<Select
											label={S.value}
											value={rule.value === 'false' ? 'false' : 'true'}
											options={[
												{ value: 'true', label: S.yes },
												{ value: 'false', label: S.no },
											]}
											onChange={(event) => setRule(at, { value: event.target.value })}
										/>
									) : rule.op === 'set' || rule.op === 'not_set' ? null : (
										<Input
											label={kind === 'money' ? fill(S.amount, { currency }) : kind === 'days' ? S.days : S.value}
											value={rule.value}
											{...(kind === 'money'
												? { type: 'number', min: 0, step, inputMode: 'decimal' }
												: kind === 'number' || kind === 'days'
													? { type: 'number', min: 0, step: '1', inputMode: 'numeric' }
													: { maxLength: 80 })}
											onChange={(event) => setRule(at, { value: event.target.value })}
										/>
									)}
									<IconButton
										label={S.removeRule}
										disabled={rules.length === 1}
										onClick={() => set({ rules: rules.filter((_, index) => index !== at) })}>
										<Icon name="close" size={14} />
									</IconButton>
								</div>
							);
						})}
						<Button
							size="sm"
							variant="ghost"
							disabled={rules.length >= 10}
							onClick={() => set({ rules: [...rules, { field: 'tag', fieldId: '', op: 'is', value: '' }] })}>
							{S.addRule}
						</Button>
					</div>
				);
			}}
		/>
	);
}
