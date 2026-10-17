'use client';
/**
 * Settings list editors (Ecommerce's list settings, `adapters/lists.js`): couriers, policies, delivery zones, tax rules, booking
 * schedules and role prices, and the pieces the order flow editor (`./flow-editor.js`), the condition grades editor (`./grades.js`) and the
 * item types editor (`./item-types.js`) share. Each list is read with `GET /v1/dashboard/websites/:websiteId/lists/:list` and saved whole
 * with `PUT … { value }`; a 422 lists the server's check errors, which are shown under the editor.
 * @module
 */
import { useState } from 'react';
import {
	Badge,
	Button,
	Card,
	EntryGroup,
	FieldGrid,
	Icon,
	IconButton,
	Input,
	ItemSwitcher,
	Select,
	TextArea,
	SaveRow as SharedSaveRow,
} from '@ss/ui';
import { COURIER_CONNECTIONS } from '../../core/couriers.js';
import { currencyDigits, fromDecimal, toDecimal } from '@ss/contracts/format';
import { UNIT_STATE_LIMITS } from '../../core/unit-states.js';
import { Loaded, SaveOutcome, call, fill, useLoad } from '@ss/ui/dashboard';
import { cleanLines, keyOf, splitIds, taxRegionLine, taxRegionOf } from './drafts.js';
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
						<li key={id}>
							<Badge
								removeLabel={fill(L.removeId, { id })}
								onRemove={() => onChange(values.filter((value) => value !== id))}>
								<code>{id}</code>
							</Badge>
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}

/**
 * The outcome of a save: Saved and a refused save are toasts; the check errors by row, and the editor's own, stay under the
 * editor.
 * @param {{ result: import('@ss/ui/dashboard').Answer | null, local: string[] }} props
 */
export const ListOutcome = ({ result, local }) => <SaveOutcome result={result} local={local} title={L.errors} />;

/**
 * Save and Cancel under an editor.
 * @param {{ dirty: boolean, onSave: () => Promise<void>, onCancel: () => void, children?: import('react').ReactNode }} props
 */
export const SaveRow = ({ dirty, onSave, onCancel, children }) => (
	<SharedSaveRow dirty={dirty} onSave={onSave} onCancel={onCancel} saveLabel={L.saveList} cancelLabel={TEXTS.cancel}>
		{children}
	</SharedSaveRow>
);

/**
 * Load and save one list: the saved value, the draft, the last outcome.
 * @param {string} websiteId
 * @param {string} list
 */
export const useList = (websiteId, list) => {
	const path = `/v1/dashboard/websites/${websiteId}/lists/${list}`;
	const { answer, reload } = useLoad(path);
	const [draft, setDraft] = useState(/** @type {any} */ (null));
	const [result, setResult] = useState(/** @type {import('@ss/ui/dashboard').Answer | null} */ (null));
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
							<ItemSwitcher
								items={items}
								legend={title}
								nameOf={(item, index) =>
									String(item.name ?? item.label ?? item.title ?? '') || `${itemLabel} ${index + 1}`
								}
								addLabel={L.add}
								addDisabled={items.length >= max}
								onAdd={() => setItems([...items, blank()])}
								emptyText={L.none}
								renderItem={(item, index) => (
									<EntryGroup
										key={index}
										data-entry=""
										title={`${itemLabel} ${index + 1}`}
										first={index === 0}
										last={index === items.length - 1}
										texts={{ moveUp: L.up, moveDown: L.down, remove: L.remove }}
										onMove={(step) => setItems(moved(items, index, step))}
										onRemove={() => setItems(items.filter((_, at) => at !== index))}>
										{render(item, (patch) => set(index, patch))}
									</EntryGroup>
								)}
							/>
							<SaveRow
								dirty={state.draft !== null}
								onCancel={() => state.setDraft(null)}
								onSave={async () => {
									const problems = check ? check(items) : [];
									if (problems.length > 0) return state.refuse(problems);
									await state.save(items.map(clean));
								}}
							/>
							<ListOutcome result={state.result} local={state.local} />
						</div>
					);
				}}
			</Loaded>
		</Card>
	);
}

const C = L.couriers;

/**
 * Couriers: a name, a tracking link template with `{tracking}` and the courier API connection its shipments are booked
 * through (`courier_1` … `courier_5`, or none; E25) (`couriers`, feature checkout).
 * @param {EditorProps} props
 */
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
			blank={() => ({ key: '', name: '', trackingUrl: 'https://', connection: '' })}
			clean={(courier) => ({
				key: keyOf(courier.key, courier.name),
				name: String(courier.name ?? '').trim(),
				trackingUrl: String(courier.trackingUrl ?? '').trim(),
				connection: String(courier.connection ?? ''),
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
					<Select
						label={C.connection}
						value={courier.connection ?? ''}
						options={[
							{ value: '', label: C.byHand },
							...COURIER_CONNECTIONS.map((name, index) => ({ value: name, label: fill(C.keys, { n: index + 1 }) })),
						]}
						onChange={(event) => set({ connection: event.target.value })}
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

/** A new rate as the editor holds it. @param {string} kind */
const blankRate = (kind) => ({
	key: '',
	name: '',
	kind,
	price: '',
	freeOver: '',
	minDays: '',
	maxDays: '',
	by: 'none',
	min: '',
	max: '',
	locations: [],
});

/**
 * Delivery zones: the places each delivers to (countries, regions, cities, areas, postcode starts; one per line) and
 * its named rates (fixed-choices E5): each a name, a kind (delivery or pickup at the pickup places, some or all), a
 * price and free-over amount (typed as decimals in the shop currency, saved as minor units), its days, and when it is
 * offered (always, by the package's grams or by the goods' value) (`delivery_zones`).
 * @param {EditorProps & { currency: string }} props
 */
export function ZonesEditor({ websiteId, off, currency }) {
	const step = currencyDigits(currency) === 0 ? '1' : String(10 ** -currencyDigits(currency));
	/** The days as typed: '' = not said. @param {unknown} text */
	const daysOf = (text) => (String(text ?? '').trim() === '' ? null : Number(String(text).trim()));
	/** @param {Item} rate */
	const amounts = (rate) => [
		{ text: rate.price, empty: 0 },
		{ text: rate.freeOver, empty: 0 },
		...(rate.by === 'value'
			? [
					{ text: rate.min, empty: 0 },
					{ text: rate.max, empty: 0 },
				]
			: []),
	];
	/** A rate's limit as typed: grams, or a decimal amount. @param {Item} rate @param {'min' | 'max'} end */
	const limitOf = (rate, end) =>
		rate.by === 'value' ? amountOf(rate[end], currency, 0) : Number(String(rate[end] ?? '').trim() || 0);
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
				rates: [{ ...blankRate('delivery'), key: 'standard', name: Z.standard, minDays: '1', maxDays: '3' }],
			})}
			load={(zone) => ({
				...zone,
				...Object.fromEntries(PLACE_KINDS.map((kind) => [kind, Array.isArray(zone.match?.[kind]) ? zone.match[kind] : []])),
				rates: (Array.isArray(zone.rates) ? zone.rates : []).map((/** @type {Item} */ rate) => ({
					key: rate.key ?? '',
					name: rate.name ?? '',
					kind: rate.kind ?? 'delivery',
					price: decimalOf(rate.price, currency),
					freeOver: rate.freeOver ? decimalOf(rate.freeOver, currency) : '',
					minDays: rate.minDays === null || rate.minDays === undefined ? '' : String(rate.minDays),
					maxDays: rate.maxDays === null || rate.maxDays === undefined ? '' : String(rate.maxDays),
					by: rate.condition?.by ?? 'none',
					min: rate.condition?.by === 'value' ? decimalOf(rate.condition.min, currency) : String(rate.condition?.min || ''),
					max:
						rate.condition?.by === 'value'
							? rate.condition.max
								? decimalOf(rate.condition.max, currency)
								: ''
							: String(rate.condition?.max || ''),
					locations: Array.isArray(rate.locations) ? rate.locations : [],
				})),
			})}
			check={(zones) =>
				zones.flatMap((zone, index) =>
					(Array.isArray(zone.rates) ? zone.rates : []).flatMap((/** @type {Item} */ rate) =>
						amounts(rate)
							.filter((entry) => amountOf(entry.text, currency, entry.empty) === undefined)
							.map((entry) =>
								fill(Z.badAmount, {
									zone: `${zone.name || `${Z.item} ${index + 1}`} / ${rate.name || Z.rate}`,
									value: String(entry.text),
									currency,
								}),
							),
					),
				)
			}
			clean={(zone) => ({
				key: keyOf(zone.key, zone.name),
				name: String(zone.name ?? '').trim(),
				match: Object.fromEntries(PLACE_KINDS.map((kind) => [kind, cleanLines(zone[kind])])),
				rates: (Array.isArray(zone.rates) ? zone.rates : []).map((/** @type {Item} */ rate) => ({
					key: keyOf(rate.key, rate.name),
					name: String(rate.name ?? '').trim(),
					kind: rate.kind,
					price: amountOf(rate.price, currency, 0),
					freeOver: amountOf(rate.freeOver, currency, 0),
					minDays: daysOf(rate.minDays),
					maxDays: daysOf(rate.maxDays) ?? daysOf(rate.minDays),
					condition:
						rate.by === 'none'
							? { by: 'none', min: 0, max: 0 }
							: { by: rate.by, min: limitOf(rate, 'min'), max: limitOf(rate, 'max') },
					locations: rate.kind === 'pickup' ? cleanLines(rate.locations) : [],
				})),
			})}
			render={(zone, set) => (
				<>
					<FieldGrid>
						<Input label={Z.name} value={zone.name ?? ''} onChange={(event) => set({ name: event.target.value })} />
						<Input
							label={Z.key}
							value={zone.key ?? ''}
							maxLength={40}
							autoComplete="off"
							onChange={(event) => set({ key: event.target.value })}
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
					<RatesPart rates={zone.rates} currency={currency} step={step} onChange={(rates) => set({ rates })} />
				</>
			)}
		/>
	);
}

/**
 * The rates of one zone, in the order the cart offers them (the first is picked first).
 * @param {{ rates: Item[], currency: string, step: string, onChange: (rates: Item[]) => void }} props
 */
function RatesPart({ rates, currency, step, onChange }) {
	/** @param {number} index @param {Item} patch */
	const set = (index, patch) => onChange(rates.map((rate, at) => (at === index ? { ...rate, ...patch } : rate)));
	return (
		<div className="space-y-3">
			<p className="text-sm font-semibold">{Z.rates}</p>
			<p className="text-sm text-muted">{Z.ratesHelp}</p>
			{rates.map((rate, index) => (
				<EntryGroup
					key={index}
					data-rate=""
					compact
					title={`${Z.rate} ${index + 1}`}
					first={index === 0}
					last={index === rates.length - 1}
					texts={{ moveUp: L.up, moveDown: L.down, remove: L.remove }}
					onMove={(step) => onChange(moved(rates, index, step))}
					onRemove={() => onChange(rates.filter((_, at) => at !== index))}>
					<FieldGrid>
						<Input
							label={Z.rateName}
							value={rate.name}
							maxLength={60}
							onChange={(event) => set(index, { name: event.target.value })}
						/>
						<Input
							label={Z.key}
							value={rate.key}
							maxLength={40}
							autoComplete="off"
							onChange={(event) => set(index, { key: event.target.value })}
						/>
						<Select
							label={Z.kind}
							value={rate.kind}
							options={[
								{ value: 'delivery', label: Z.kinds.delivery },
								{ value: 'pickup', label: Z.kinds.pickup },
							]}
							onChange={(event) => set(index, { kind: event.target.value })}
						/>
						<Input
							label={fill(Z.price, { currency })}
							type="number"
							min={0}
							step={step}
							inputMode="decimal"
							value={rate.price}
							onChange={(event) => set(index, { price: event.target.value })}
						/>
						<Input
							label={fill(Z.freeOver, { currency })}
							type="number"
							min={0}
							step={step}
							inputMode="decimal"
							value={rate.freeOver}
							onChange={(event) => set(index, { freeOver: event.target.value })}
						/>
						<Input
							label={Z.minDays}
							type="number"
							min={0}
							value={rate.minDays}
							onChange={(event) => set(index, { minDays: event.target.value })}
						/>
						<Input
							label={Z.maxDays}
							type="number"
							min={0}
							value={rate.maxDays}
							onChange={(event) => set(index, { maxDays: event.target.value })}
						/>
						<Select
							label={Z.by}
							value={rate.by}
							options={[
								{ value: 'none', label: Z.conditions.none },
								{ value: 'weight', label: Z.conditions.weight },
								{ value: 'value', label: fill(Z.conditions.value, { currency }) },
							]}
							onChange={(event) => set(index, { by: event.target.value, min: '', max: '' })}
						/>
						{rate.by === 'none' ? null : (
							<>
								<Input
									label={rate.by === 'weight' ? Z.minGrams : fill(Z.minValue, { currency })}
									type="number"
									min={0}
									step={rate.by === 'weight' ? '1' : step}
									value={rate.min}
									onChange={(event) => set(index, { min: event.target.value })}
								/>
								<Input
									label={rate.by === 'weight' ? Z.maxGrams : fill(Z.maxValue, { currency })}
									type="number"
									min={0}
									step={rate.by === 'weight' ? '1' : step}
									value={rate.max}
									onChange={(event) => set(index, { max: event.target.value })}
								/>
							</>
						)}
						{rate.kind === 'pickup' ? (
							<TextArea
								label={Z.locations}
								rows={2}
								value={rate.locations.join('\n')}
								onChange={(event) => set(index, { locations: event.target.value.split('\n') })}
							/>
						) : null}
					</FieldGrid>
				</EntryGroup>
			))}
			<div className="flex flex-wrap gap-2">
				<Button
					size="sm"
					variant="secondary"
					disabled={rates.length >= 20}
					onClick={() => onChange([...rates, blankRate('delivery')])}>
					{Z.addRate}
				</Button>
				<Button
					size="sm"
					variant="secondary"
					disabled={rates.length >= 20}
					onClick={() => onChange([...rates, blankRate('pickup')])}>
					{Z.addPickup}
				</Button>
			</div>
		</div>
	);
}

const B = L.bookingSchedules;

/**
 * Booking schedules (E30, `booking_schedules`): each a name and key, weekly windows (an ISO weekday 1 Monday – 7 Sunday
 * and a time range) and dated exceptions (a date, a name and its own windows; none = closed all day), in Chat's
 * office-hours shape. Services name the schedule they are booked on (the first when they name none).
 * @param {EditorProps} props
 */
export function BookingSchedulesEditor({ websiteId, off }) {
	/** A time range as typed: `HH:MM-HH:MM`. @param {Item} range */
	const rangeLine = (range) => `${range.start}-${range.end}`;
	/** @param {string} line */
	const rangeOfLine = (line) => {
		const [start = '', end = ''] = line.split('-').map((part) => part.trim());
		return { start, end };
	};
	return (
		<ListEditor
			websiteId={websiteId}
			list="booking_schedules"
			title={B.title}
			help={B.help}
			itemLabel={B.item}
			max={20}
			off={off}
			blank={() => ({ key: '', name: '', weekly: [{ day: 1, start: '09:00', end: '17:00' }], exceptions: '' })}
			load={(schedule) => ({
				key: schedule.key ?? '',
				name: schedule.name ?? '',
				weekly: Array.isArray(schedule.weekly) ? schedule.weekly : [],
				// one dated exception per line: `YYYY-MM-DD Name | HH:MM-HH:MM, HH:MM-HH:MM` (no hours = closed)
				exceptions: (Array.isArray(schedule.exceptions) ? schedule.exceptions : [])
					.map(
						(/** @type {Item} */ entry) =>
							`${entry.date} ${entry.name ?? ''}`.trim() +
							((entry.hours ?? []).length > 0 ? ` | ${entry.hours.map(rangeLine).join(', ')}` : ''),
					)
					.join('\n'),
			})}
			clean={(schedule) => ({
				key: keyOf(schedule.key, schedule.name),
				name: String(schedule.name ?? '').trim(),
				weekly: schedule.weekly.map((/** @type {Item} */ window) => ({
					day: Number(window.day),
					start: String(window.start ?? ''),
					end: String(window.end ?? ''),
				})),
				exceptions: cleanLines(String(schedule.exceptions ?? '').split('\n')).map((line) => {
					const [head = '', hours = ''] = line.split('|');
					const [date = '', ...name] = head.trim().split(/\s+/);
					return {
						date,
						name: name.join(' '),
						hours: cleanLines(hours.split(',')).map(rangeOfLine),
					};
				}),
			})}
			render={(schedule, set) => (
				<>
					<FieldGrid>
						<Input
							label={B.name}
							value={schedule.name}
							maxLength={80}
							onChange={(event) => set({ name: event.target.value })}
						/>
						<Input
							label={B.key}
							value={schedule.key}
							maxLength={40}
							autoComplete="off"
							onChange={(event) => set({ key: event.target.value })}
						/>
					</FieldGrid>
					<p className="text-sm font-semibold">{B.weekly}</p>
					{schedule.weekly.map((/** @type {Item} */ window, /** @type {number} */ index) => {
						/** @param {Item} patch */
						const change = (patch) =>
							set({
								weekly: schedule.weekly.map((/** @type {Item} */ entry, /** @type {number} */ at) =>
									at === index ? { ...entry, ...patch } : entry,
								),
							});
						return (
							<div key={index} data-window="" className="flex flex-wrap items-end gap-2">
								<Select
									label={B.day}
									value={String(window.day ?? 1)}
									options={B.days.map((label, at) => ({ value: String(at + 1), label }))}
									onChange={(event) => change({ day: Number(event.target.value) })}
								/>
								<Input
									label={B.from}
									type="time"
									value={window.start ?? ''}
									onChange={(event) => change({ start: event.target.value })}
								/>
								<Input
									label={B.to}
									type="time"
									value={window.end ?? ''}
									onChange={(event) => change({ end: event.target.value })}
								/>
								<Button
									size="sm"
									variant="ghost"
									onClick={() =>
										set({
											weekly: schedule.weekly.filter(
												(/** @type {Item} */ _, /** @type {number} */ at) => at !== index,
											),
										})
									}>
									{L.remove}
								</Button>
							</div>
						);
					})}
					<Button
						size="sm"
						variant="secondary"
						disabled={schedule.weekly.length >= 70}
						onClick={() => set({ weekly: [...schedule.weekly, { day: 1, start: '09:00', end: '17:00' }] })}>
						{B.addWindow}
					</Button>
					<TextArea
						label={B.exceptions}
						help={B.exceptionsHelp}
						rows={4}
						value={schedule.exceptions}
						onChange={(event) => set({ exceptions: event.target.value })}
					/>
				</>
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
	const step = currencyDigits(currency) === 0 ? '1' : String(10 ** -currencyDigits(currency));
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
	const step = currencyDigits(currency) === 0 ? '1' : String(10 ** -currencyDigits(currency));
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
