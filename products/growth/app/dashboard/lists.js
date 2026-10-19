'use client';
/**
 * Growth's merchant lists in Settings (`core/lists.js`; the kit's `GET|PUT /v1/dashboard/websites/:websiteId/lists/:list`):
 * one card per list of a switched-on feature, each entry with its fields, up, down and remove, Add, and Save for the
 * whole list (a 422 lists the server's errors under the card). The editor is drawn from the list's fields, so every list
 * gets add, rename, reorder and remove the same way. Also the robots.txt online store preset (G12), applied in one click.
 * @module
 */
import { useState } from 'react';
import {
	Button,
	Callout,
	Card,
	Checkbox,
	CheckboxGroup,
	EntryGroup,
	FieldGrid,
	Input,
	ItemSwitcher,
	Select,
	TextArea,
	describeProblem,
	SaveBar,
} from '@ss/ui';
import { SaveOutcome, call, useLoad } from '@ss/ui/dashboard';
import { LISTS } from '../../core/lists.js';
import { ONLINE_STORE_PRESET } from '../../core/seo.js';
import { TEXTS } from './texts.js';

/** @typedef {import('../../core/lists.js').ListName} ListName */
/** @typedef {import('../../core/lists.js').Field} Field */
/** @typedef {Record<string, any>} Entry */

const L = TEXTS.lists;

/**
 * A copy of `items` with the entry at `index` moved by `step` (-1 up, 1 down).
 * @template T
 * @param {T[]} items @param {number} index @param {number} step
 */
export const moved = (items, index, step) => {
	const to = index + step;
	if (to < 0 || to >= items.length) return items;
	const next = [...items];
	[next[index], next[to]] = [/** @type {T} */ (next[to]), /** @type {T} */ (next[index])];
	return next;
};

/**
 * A new entry of a list: each field's default (a new key is made unique).
 * @param {Record<string, Field>} fields
 * @param {Entry[]} [others]
 * @returns {Entry}
 */
const blankEntry = (fields, others = []) =>
	Object.fromEntries(
		Object.entries(fields).map(([name, field]) => {
			if (field.type === 'rows') return [name, Array.from({ length: field.min }, () => blankEntry(field.fields))];
			if (field.type === 'text' && name === 'key') {
				let n = others.length + 1;
				while (others.some((other) => other.key === `new_${n}`)) n += 1;
				return [name, `new_${n}`];
			}
			if (field.type === 'text') return [name, field.default ?? ''];
			if (field.type === 'choices' || field.type === 'paths') return [name, [...(field.default ?? [])]];
			if (field.type === 'time') return [name, ''];
			return [name, field.default];
		}),
	);

/**
 * The words of a field: its label and help (`TEXTS.lists.fields.<name>`).
 * @param {string} name
 */
const wordsOf = (name) =>
	/** @type {{ label: string, help?: string }} */ (/** @type {Record<string, unknown>} */ (L.fields)[name] ?? { label: name });

/**
 * The label of a choice (`TEXTS.lists.choices.<value>`), else the value.
 * @param {string} value
 */
const choiceLabel = (value) => /** @type {Record<string, string>} */ (L.choices)[value] ?? value;

/** Fields shown as several lines of text. */
const LONG = new Set(['scripts', 'description', 'text']);

/**
 * One field of an entry.
 * @param {{ name: string, field: Field, value: any, error?: string, onChange: (value: any) => void }} props
 */
function FieldInput({ name, field, value, error, onChange }) {
	const words = wordsOf(name);
	const common = { label: words.label, ...(words.help ? { help: words.help } : {}), ...(error ? { error } : {}) };
	switch (field.type) {
		case 'choice':
			return (
				<Select
					{...common}
					value={String(value)}
					options={field.choices.map((choice) => ({ value: choice, label: choiceLabel(choice) }))}
					onChange={(event) => onChange(event.target.value)}
				/>
			);
		case 'choices':
			return (
				<CheckboxGroup
					legend={words.label}
					{...(words.help ? { help: words.help } : {})}
					{...(error ? { error } : {})}
					options={field.choices.map((choice) => ({ value: choice, label: choiceLabel(choice) }))}
					value={Array.isArray(value) ? value : []}
					onChange={onChange}
				/>
			);
		case 'flag':
			return <Checkbox {...common} checked={value === true} onChange={(event) => onChange(event.target.checked)} />;
		case 'number':
			return (
				<Input
					{...common}
					type="number"
					min={field.min}
					max={field.max}
					value={String(value)}
					onChange={(event) => onChange(Number(event.target.value))}
				/>
			);
		case 'paths':
			return (
				<TextArea
					{...common}
					rows={3}
					value={(Array.isArray(value) ? value : []).join('\n')}
					onChange={(event) => onChange(event.target.value.split('\n'))}
				/>
			);
		case 'time':
			return (
				<Input
					{...common}
					type="datetime-local"
					value={String(value ?? '')}
					onChange={(event) => onChange(event.target.value)}
				/>
			);
		case 'text':
			return LONG.has(name) ? (
				<TextArea
					{...common}
					rows={name === 'scripts' ? 4 : 2}
					value={String(value ?? '')}
					onChange={(event) => onChange(event.target.value)}
				/>
			) : (
				<Input {...common} value={String(value ?? '')} onChange={(event) => onChange(event.target.value)} />
			);
		default:
			return null;
	}
}

/**
 * The entries of a list (or of an entry's rows), each with its fields. With `one` (a list, not an entry's rows) only
 * the picked entry is shown, from a strip of tabs (a select when there are many), so a long list is not a long page.
 * @param {{ fields: Record<string, Field>, entries: Entry[], at: string, errors: Record<string, string>, max: number,
 *   label: (entry: Entry, index: number) => string, onChange: (entries: Entry[]) => void, one?: boolean }} props
 *   `at`: the path of the entries in the server's errors (`/value`, `/value/0/steps`)
 */
function Entries({ fields, entries, at, errors, max, label, onChange, one = false }) {
	/** @param {Entry} entry @param {number} index */
	const entryView = (entry, index) => (
		<EntryGroup
			key={index}
			compact
			title={label(entry, index)}
			first={index === 0}
			last={index === entries.length - 1}
			texts={{ moveUp: L.up, moveDown: L.down, remove: L.remove }}
			onMove={(step) => onChange(moved(entries, index, step))}
			onRemove={() => onChange(entries.filter((_, other) => other !== index))}>
			<FieldGrid>
				{Object.entries(fields).map(([name, field]) =>
					field.type === 'rows' ? (
						<div key={name} data-cell="" data-wide="" className="min-w-0 space-y-2">
							<p className="text-sm font-semibold">{wordsOf(name).label}</p>
							<Entries
								fields={field.fields}
								entries={entry[name] ?? []}
								at={`${at}/${index}/${name}`}
								errors={errors}
								max={field.max}
								label={(row, rowIndex) => `${rowIndex + 1}. ${row.name || L.untitled}`}
								onChange={(rows) =>
									onChange(entries.map((other, i) => (i === index ? { ...other, [name]: rows } : other)))
								}
							/>
						</div>
					) : (
						<FieldInput
							key={name}
							name={name}
							field={field}
							value={entry[name]}
							{...(errors[`${at}/${index}/${name}`] ? { error: errors[`${at}/${index}/${name}`] } : {})}
							onChange={(value) =>
								onChange(entries.map((other, i) => (i === index ? { ...other, [name]: value } : other)))
							}
						/>
					),
				)}
			</FieldGrid>
		</EntryGroup>
	);
	const add = () => onChange([...entries, blankEntry(fields, entries)]);
	if (one)
		return (
			<ItemSwitcher
				items={entries}
				legend={L.entries}
				nameOf={label}
				addLabel={L.add}
				addDisabled={entries.length >= max}
				onAdd={add}
				renderItem={entryView}
			/>
		);
	return (
		<div className="space-y-3">
			{entries.map(entryView)}
			<Button size="sm" variant="secondary" disabled={entries.length >= max} onClick={add}>
				{L.add}
			</Button>
		</div>
	);
}

/** The words that name an entry in its head. @param {Entry} entry @param {number} index */
const entryLabel = (entry, index) =>
	`${index + 1}. ${String(entry.name ?? entry.event ?? entry.text ?? entry.check ?? '') || L.untitled}`;

/**
 * One list's card: its entries, Save for the whole list, and what the server said.
 * @param {{ websiteId: string, name: ListName }} props
 */
export function ListCard({ websiteId, name }) {
	const spec = LISTS[name];
	const path = `/v1/dashboard/websites/${websiteId}/lists/${name}`;
	const { answer, reload } = useLoad(path);
	const [draft, setDraft] = useState(/** @type {Entry[] | null} */ (null));
	const [result, setResult] = useState(/** @type {import('@ss/ui/dashboard').Answer | null} */ (null));
	const words = /** @type {{ title: string, help: string }} */ (/** @type {Record<string, unknown>} */ (L)[name]);
	const saved = answer?.ok ? /** @type {Entry[]} */ (answer.data.value) : null;
	const entries = draft ?? saved;
	/** @type {Record<string, string>} */
	const errors = {};
	if (result && !result.ok)
		for (const error of /** @type {Array<{ path?: string, message?: string }>} */ (result.problem?.errors ?? []))
			if (error.path) errors[error.path] = String(error.message ?? '');
	return (
		<Card title={words.title} subtitle={words.help}>
			{entries === null ? (
				answer && !answer.ok ? (
					<Callout tone="danger">{describeProblem(answer.problem)}</Callout>
				) : null
			) : (
				<div className="space-y-3">
					<Entries
						fields={spec.fields}
						entries={entries}
						at="/value"
						errors={errors}
						max={spec.max}
						label={entryLabel}
						onChange={setDraft}
						one
					/>
					<SaveBar
						show={draft !== null}
						saveLabel={L.save}
						discardLabel={TEXTS.cancel}
						onDiscard={() => setDraft(null)}
						onSave={async () => {
							const next = await call('PUT', path, { value: draft });
							setResult(next);
							if (next.ok) {
								setDraft(null);
								reload();
							}
						}}
					/>
					<SaveOutcome result={result} format={() => (errors['/value'] ? [errors['/value']] : [])} />
				</div>
			)}
		</Card>
	);
}

/**
 * The robots.txt online store preset (G12): fills Keep search results out, the sort and filter parameters and the
 * private pages with a shop's, then reloads the page so the robots card shows them.
 * @param {{ websiteId: string }} props
 */
function StorePresetCard({ websiteId }) {
	const [result, setResult] = useState(/** @type {import('@ss/ui/dashboard').Answer | null} */ (null));
	return (
		<Card title={L.preset.title} subtitle={L.preset.help}>
			<Button
				variant="secondary"
				onClick={async () => {
					/** @type {import('@ss/ui/dashboard').Answer} */
					let last = { ok: true, data: null };
					for (const [name, value] of Object.entries(ONLINE_STORE_PRESET)) {
						last = await call(
							'PUT',
							`/v1/dashboard/websites/${websiteId}/settings/${encodeURIComponent(`robots_verification.${name}`)}`,
							{ value },
						);
						if (!last.ok) break;
					}
					setResult(last);
					if (last.ok && typeof window !== 'undefined') window.location.reload();
				}}>
				{L.preset.apply}
			</Button>
			<SaveOutcome result={result} />
		</Card>
	);
}

/** The feature or shared group each list belongs under (where its cards are listed in Settings). */
const HOME = /** @type {Record<ListName, string>} */ ({
	goals: 'conversion_funnel',
	funnels: 'conversion_funnel',
	consent_categories: 'tags',
	announcements: 'notice_bar',
	conversion_actions: 'pixels',
	verification_tags: 'robots_verification',
	seo_ignored: 'seo_checklist',
});

/**
 * The lists (and the online store preset) as the extras of Settings: each is a view of its own under the feature it
 * belongs to, which is listed while that feature is on.
 * @param {string} websiteId
 * @returns {Record<string, { items: Array<{ id: string, label: string, content: import('react').ReactNode }> }>}
 */
export const listExtras = (websiteId) => {
	/** @type {Record<string, { items: Array<{ id: string, label: string, content: import('react').ReactNode }> }>} */
	const out = {};
	/** @param {string} home @param {{ id: string, label: string, content: import('react').ReactNode }} item */
	const put = (home, item) => {
		out[home] = { items: [...(out[home]?.items ?? []), item] };
	};
	for (const name of /** @type {ListName[]} */ (Object.keys(LISTS)))
		put(HOME[name], {
			id: name,
			label: /** @type {{ title: string }} */ (/** @type {Record<string, unknown>} */ (L)[name]).title,
			content: <ListCard websiteId={websiteId} name={name} />,
		});
	put('robots_verification', { id: 'preset', label: L.preset.title, content: <StorePresetCard websiteId={websiteId} /> });
	return out;
};
