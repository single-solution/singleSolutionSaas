'use client';
/**
 * Settings → Catalog: the item types editor (`item_types` list of `catalog`, PLAN 0.8.10 dynamic model §1). The list
 * shows each type's name, key, kind and parts, with Edit and a More menu (move, remove); a type's every field is edited
 * in a dialog (PLAN 0.6: secondary forms in dialogs): name and key, kind (physical goods, digital goods or a service),
 * whether it is offered, the parts its items have (only those of its kind; each works while its feature is on),
 * numbered units (the unit fields their numbers take, picked from stock or typed, and the step they are needed before),
 * selling in a unit of its own (the unit, and the step, least and most a shopper buys, typed as numbers of the
 * unit; no numbered units then) and, when the type names them, the product and variant fields its items take. Done keeps the type in the list; Save
 * list saves the whole list (up to 50 types) with `PUT …/lists/item_types`, and the server checks it again (the fields
 * it names, the types products and categories use, units and measured stock).
 *
 * Field ids are typed (`att_…`): the dashboard shows no business data (PLAN 0.4.3) and has no route that reads the
 * website's fields, so they are entered as tags, as the grades editor takes category ids.
 * @module
 */
import { useState } from 'react';
import { ActionMenu, Badge, Button, Card, Checkbox, Dialog, FieldGrid, Input, Paged, Select } from '@ss/ui';
import { FIELD_LIMITS } from '../../core/fields.js';
import { ELEMENTS, ITEM_KINDS, TYPE_LIMITS, UNIT_CAPTURES, elementFor } from '../../core/item-types.js';
import { MAX_DECIMALS, MAX_UNIT_LABEL, STANDARD_UNITS } from '../../core/measure.js';
import { Loaded, fill } from '@ss/ui/dashboard';
import { blankType, cleanType, keyOf, loadType, typeProblems } from './drafts.js';
import { IdTags, ListOutcome, SaveRow, moved, useList } from './lists.js';
import { TEXTS } from './texts.js';

/** @typedef {import('./drafts.js').TypeDraft} TypeDraft */

const L = TEXTS.lists;
const T = L.itemTypes;

/** The parts a type switches on, without its numbered units, its measure and its quantities (edited on their own). */
const PARTS = /** @type {Array<Exclude<import('../../core/item-types.js').Element, 'units' | 'measure' | 'quantity'>>} */ (
	ELEMENTS.filter((element) => element !== 'units' && element !== 'measure' && element !== 'quantity')
);

/**
 * Every field of one type (the dialog's body).
 * @param {{ draft: TypeDraft, set: (patch: Partial<TypeDraft>) => void, problems: ReturnType<typeof typeProblems>,
 *   tried: boolean }} props `tried`: Done was pressed (the missing name is shown from then on)
 */
function TypeFields({ draft, set, problems, tried }) {
	const keyError =
		problems.key === 'invalid'
			? T.keyInvalid
			: problems.key === 'taken'
				? T.keyTaken
				: problems.key === 'built_in'
					? T.keyBuiltIn
					: undefined;
	const physical = elementFor('units', draft.kind);
	const measure = draft.measure;
	/** @param {Partial<TypeDraft['measure']>} patch */
	const setMeasure = (patch) => set({ measure: { ...measure, ...patch } });
	return (
		<div className="space-y-6">
			<FieldGrid>
				<Input
					label={T.name}
					required
					value={draft.name}
					maxLength={TYPE_LIMITS.name}
					error={tried && problems.name ? T.nameMissing : undefined}
					onChange={(event) => set({ name: event.target.value })}
				/>
				<Input
					label={T.key}
					help={T.keyHelp}
					value={draft.key}
					placeholder={keyOf('', draft.name)}
					maxLength={40}
					autoComplete="off"
					spellCheck={false}
					error={keyError}
					onChange={(event) => set({ key: event.target.value.toLowerCase() })}
				/>
				<Select
					label={T.kind}
					help={T.kindHelp}
					value={draft.kind}
					options={ITEM_KINDS.map((kind) => ({ value: kind, label: T.kinds[kind] }))}
					onChange={(event) => set({ kind: /** @type {TypeDraft['kind']} */ (event.target.value) })}
				/>
				<Checkbox
					label={T.active}
					help={T.activeHelp}
					checked={draft.active}
					onChange={(event) => set({ active: event.target.checked })}
				/>
			</FieldGrid>
			<fieldset className="min-w-0 space-y-3">
				<legend className="mb-1 text-sm font-bold text-fg">{T.parts}</legend>
				<p className="text-xs text-muted">{T.partsHelp}</p>
				<FieldGrid>
					{PARTS.filter((part) => elementFor(part, draft.kind)).map((part) => (
						<Checkbox
							key={part}
							label={T.elements[part]}
							help={T.elementHelp[part]}
							checked={draft.elements[part]}
							onChange={(event) => set({ elements: { ...draft.elements, [part]: event.target.checked } })}
						/>
					))}
				</FieldGrid>
			</fieldset>
			{physical ? (
				<fieldset className="min-w-0 space-y-3">
					<legend className="mb-1 text-sm font-bold text-fg">{T.measure}</legend>
					<Checkbox
						label={T.measureOn}
						help={T.measureHelp}
						checked={measure.on}
						onChange={(event) => setMeasure({ on: event.target.checked })}
					/>
					{measure.on ? (
						<FieldGrid>
							<Input
								label={T.unit}
								help={T.unitHelp}
								required
								value={measure.unit}
								maxLength={MAX_UNIT_LABEL}
								error={problems.measure === 'unit' && tried ? T.unitMissing : undefined}
								onChange={(event) => setMeasure({ unit: event.target.value })}
							/>
							<Select
								label={T.decimals}
								help={T.decimalsHelp}
								value={measure.decimals}
								options={Array.from({ length: MAX_DECIMALS + 1 }, (_, n) => ({ value: String(n), label: String(n) }))}
								onChange={(event) => setMeasure({ decimals: event.target.value })}
							/>
							<Input
								label={T.step}
								help={T.stepHelp}
								inputMode="decimal"
								value={measure.step}
								error={problems.measure === 'step' ? T.stepInvalid : undefined}
								onChange={(event) => setMeasure({ step: event.target.value })}
							/>
							<Input
								label={T.least}
								inputMode="decimal"
								value={measure.min}
								error={problems.measure === 'min' ? T.leastInvalid : undefined}
								onChange={(event) => setMeasure({ min: event.target.value })}
							/>
							<Input
								label={T.most}
								help={T.mostHelp}
								inputMode="decimal"
								value={measure.max}
								error={problems.measure === 'max' ? T.mostInvalid : undefined}
								onChange={(event) => setMeasure({ max: event.target.value })}
							/>
							<Select
								label={T.standard}
								help={T.standardHelp}
								value={measure.standardCode}
								options={[
									{ value: '', label: T.standardNone },
									...Object.keys(STANDARD_UNITS).map((code) => ({
										value: code,
										label: T.standardCodes[/** @type {keyof typeof T.standardCodes} */ (code)] ?? code,
									})),
								]}
								onChange={(event) => setMeasure({ standardCode: event.target.value })}
							/>
							{measure.standardCode ? (
								<Input
									label={T.standardAmount}
									inputMode="decimal"
									value={measure.standardAmount}
									error={problems.measure === 'standard' ? T.standardAmountInvalid : undefined}
									onChange={(event) => setMeasure({ standardAmount: event.target.value })}
								/>
							) : null}
						</FieldGrid>
					) : null}
				</fieldset>
			) : null}
			{measure.on && physical ? null : (
				<fieldset className="min-w-0 space-y-3">
					<legend className="mb-1 text-sm font-bold text-fg">{T.quantity}</legend>
					<p className="text-xs text-muted">{T.quantityHelp}</p>
					<FieldGrid>
						<Input
							label={T.quantityStep}
							inputMode="numeric"
							value={draft.quantity.step}
							error={problems.quantity === 'step' ? T.quantityStepInvalid : undefined}
							onChange={(event) => set({ quantity: { ...draft.quantity, step: event.target.value } })}
						/>
						<Input
							label={T.quantityLeast}
							inputMode="numeric"
							value={draft.quantity.min}
							error={problems.quantity === 'min' ? T.quantityLeastInvalid : undefined}
							onChange={(event) => set({ quantity: { ...draft.quantity, min: event.target.value } })}
						/>
						<Input
							label={T.quantityMost}
							help={T.quantityMostHelp}
							inputMode="numeric"
							value={draft.quantity.max}
							error={problems.quantity === 'max' ? T.quantityMostInvalid : undefined}
							onChange={(event) => set({ quantity: { ...draft.quantity, max: event.target.value } })}
						/>
					</FieldGrid>
				</fieldset>
			)}
			{physical && !measure.on ? (
				<fieldset className="min-w-0 space-y-3">
					<legend className="mb-1 text-sm font-bold text-fg">{T.units}</legend>
					<Checkbox
						label={T.unitsOn}
						help={T.unitsHelp}
						checked={draft.units.on}
						onChange={(event) => set({ units: { ...draft.units, on: event.target.checked } })}
					/>
					{draft.units.on ? (
						<FieldGrid>
							<Select
								label={T.capture}
								value={draft.units.capture}
								options={UNIT_CAPTURES.map((capture) => ({ value: capture, label: T.captures[capture] }))}
								onChange={(event) =>
									set({
										units: {
											...draft.units,
											capture: /** @type {TypeDraft['units']['capture']} */ (event.target.value),
										},
									})
								}
							/>
							<Select
								label={T.requiredBefore}
								help={draft.units.capture === 'stock' ? T.requiredBeforeStock : T.requiredBeforeHelp}
								disabled={draft.units.capture === 'stock'}
								value={draft.units.capture === 'stock' ? 'packed' : draft.units.requiredBefore}
								options={[
									{ value: 'packed', label: T.stages.packed },
									{ value: 'shipped', label: T.stages.shipped },
									{ value: '', label: T.stages.never },
								]}
								onChange={(event) =>
									set({
										units: {
											...draft.units,
											requiredBefore: /** @type {TypeDraft['units']['requiredBefore']} */ (event.target.value),
										},
									})
								}
							/>
							<IdTags
								label={T.unitFields}
								help={fill(T.unitFieldsHelp, { max: FIELD_LIMITS.unitFields })}
								values={draft.units.fieldIds}
								max={FIELD_LIMITS.unitFields}
								none={T.plainSerials}
								onChange={(fieldIds) => set({ units: { ...draft.units, fieldIds } })}
							/>
						</FieldGrid>
					) : null}
				</fieldset>
			) : null}
			<fieldset className="min-w-0 space-y-3">
				<legend className="mb-1 text-sm font-bold text-fg">{T.fields}</legend>
				<Checkbox
					label={T.fieldsNamed}
					help={T.fieldsNamedHelp}
					checked={draft.fieldsNamed}
					onChange={(event) => set({ fieldsNamed: event.target.checked })}
				/>
				{draft.fieldsNamed ? (
					<FieldGrid>
						<IdTags
							label={T.fieldIds}
							help={T.fieldIdsHelp}
							values={draft.fieldIds}
							max={TYPE_LIMITS.fields}
							none={T.noFields}
							onChange={(fieldIds) => set({ fieldIds })}
						/>
					</FieldGrid>
				) : null}
			</fieldset>
		</div>
	);
}

/**
 * A type's line in the list: name and key, kind and parts, and its actions.
 * @param {{ type: TypeDraft, index: number, count: number, onEdit: () => void, onMove: (step: number) => void,
 *   onRemove: () => void }} props
 */
function TypeRow({ type, index, count, onEdit, onMove, onRemove }) {
	const name = type.name.trim() || T.unnamed;
	const parts = [
		...PARTS.filter((part) => elementFor(part, type.kind) && type.elements[part]).map((part) => T.elements[part]),
		...(type.measure.on && elementFor('measure', type.kind)
			? [T.soldBy.replace('{unit}', type.measure.unit.trim())]
			: type.units.on && elementFor('units', type.kind)
				? [T.unitsOn]
				: []),
		...(type.measure.on && elementFor('measure', type.kind)
			? []
			: type.quantity.step.trim() !== '1' || type.quantity.min.trim() !== '1'
				? [fill(T.quantityRule, { step: type.quantity.step.trim(), min: type.quantity.min.trim() })]
				: []),
	];
	return (
		<li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0">
			<span className="min-w-0 flex-[1_1_16rem]">
				<span className="flex flex-wrap items-center gap-x-2 gap-y-1">
					<span className="font-semibold text-fg">{name}</span>
					<code className="text-xs text-muted">{keyOf(type.key, type.name)}</code>
					<Badge kind="product">{T.kinds[type.kind]}</Badge>
					{type.active ? null : <Badge>{T.notOffered}</Badge>}
				</span>
				<span className="block text-sm text-muted">{parts.length > 0 ? parts.join(' · ') : T.noParts}</span>
			</span>
			<span className="flex items-center gap-1">
				<Button size="sm" variant="secondary" onClick={onEdit}>
					{T.edit}
				</Button>
				<ActionMenu
					label={fill(T.more, { type: name })}
					items={[
						{ label: L.up, disabled: index === 0, onSelect: () => onMove(-1) },
						{ label: L.down, disabled: index === count - 1, onSelect: () => onMove(1) },
						{ label: L.remove, danger: true, onSelect: onRemove },
					]}
				/>
			</span>
		</li>
	);
}

/** What the dialog edits: which type (null = a new one), the working copy, whether Done was pressed. */
/** @typedef {{ open: boolean, index: number | null, draft: TypeDraft, tried: boolean }} Editing */

/**
 * Item types (`item_types`, feature catalog): the list, and each type's fields in a dialog.
 * @param {{ websiteId: string, off?: boolean }} props
 */
export function ItemTypesEditor({ websiteId, off }) {
	const state = useList(websiteId, 'item_types');
	const [editing, setEditing] = useState(
		/** @type {Editing} */ ({ open: false, index: null, draft: blankType(), tried: false }),
	);
	return (
		<Card title={T.title} subtitle={off ? TEXTS.settings.off : `${T.help} ${fill(L.max, { max: TYPE_LIMITS.types })}`}>
			<Loaded answer={state.answer}>
				{(data) => {
					/** @type {TypeDraft[]} */
					const items = state.draft ?? (Array.isArray(data.value) ? data.value : []).map(loadType);
					/** @param {TypeDraft[]} next */
					const setItems = (next) => state.setDraft(next);
					const otherKeys = items.filter((_, at) => at !== editing.index).map((type) => keyOf(type.key, type.name));
					const problems = typeProblems(editing.draft, otherKeys);
					/** @param {number | null} index @param {TypeDraft} draft */
					const open = (index, draft) => setEditing({ open: true, index, draft, tried: false });
					const close = () => setEditing({ ...editing, open: false });
					const done = () => {
						if (Object.keys(problems).length > 0) return setEditing({ ...editing, tried: true });
						setItems(
							editing.index === null
								? [...items, editing.draft]
								: items.map((type, at) => (at === editing.index ? editing.draft : type)),
						);
						close();
					};
					return (
						<div className="space-y-4">
							{items.length === 0 ? (
								<p className="text-sm text-muted">{T.none}</p>
							) : (
								<Paged
									items={items.map((type, index) => ({ type, index }))}
									pageSize={8}
									text={(entry) => entry.type.name}>
									{(page) => (
										<ul className="divide-y divide-line-soft">
											{page.map(({ type, index }) => (
												<TypeRow
													key={index}
													type={type}
													index={index}
													count={items.length}
													onEdit={() => open(index, type)}
													onMove={(step) => setItems(moved(items, index, step))}
													onRemove={() => setItems(items.filter((_, at) => at !== index))}
												/>
											))}
										</ul>
									)}
								</Paged>
							)}
							<SaveRow
								dirty={state.draft !== null}
								onCancel={() => state.setDraft(null)}
								onSave={() => state.save(items.map(cleanType))}>
								<Button
									size="sm"
									variant="secondary"
									disabled={items.length >= TYPE_LIMITS.types}
									onClick={() => open(null, blankType())}>
									{T.add}
								</Button>
								{state.draft !== null ? (
									<Badge tone="warning" dot className="self-center">
										{T.unsaved}
									</Badge>
								) : null}
							</SaveRow>
							<ListOutcome result={state.result} local={state.local} />
							<Dialog
								open={editing.open}
								onClose={close}
								size="lg"
								title={
									editing.index === null
										? T.newTitle
										: fill(T.editTitle, { type: editing.draft.name.trim() || T.unnamed })
								}
								description={T.dialogHelp}
								closeLabel={TEXTS.cancel}
								footer={
									<>
										<Button variant="secondary" onClick={close}>
											{TEXTS.cancel}
										</Button>
										<Button onClick={done}>{T.done}</Button>
									</>
								}>
								<TypeFields
									draft={editing.draft}
									tried={editing.tried}
									problems={problems}
									set={(patch) => setEditing((now) => ({ ...now, draft: { ...now.draft, ...patch } }))}
								/>
							</Dialog>
						</div>
					);
				}}
			</Loaded>
		</Card>
	);
}
