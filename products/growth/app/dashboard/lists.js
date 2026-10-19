'use client';
/**
 * Growth's merchant lists in Settings (`core/lists.js`; the kit's `GET|PUT /v1/dashboard/websites/:websiteId/lists/:list`):
 * one page per list of a switched-on feature: the entries are a table (the row menu moves one up or down or removes it),
 * a click on a row opens the entry's fields in a drawer that edits the draft only, Add, and the frame's Save bar saves
 * the whole list (a 422 lists the server's errors under the table). The editor is drawn from the list's fields, so every
 * list gets add, rename, reorder and remove the same way. Also the robots.txt online store preset (G12), one click.
 * @module
 */
import { useState } from 'react';
import {
	Button,
	Card,
	Checkbox,
	CheckboxGroup,
	DataTable,
	DataTableSkeleton,
	Drawer,
	EntryGroup,
	FieldGrid,
	Icon,
	Input,
	Select,
	TextArea,
	SaveBar,
} from '@ss/ui';
import { Loaded, SaveOutcome, call, useLoad } from '@ss/ui/dashboard';
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
 * The fields of one entry (or of one of its rows), in a grid; an entry's `rows` field is a stack of rows of its own.
 * @param {{ fields: Record<string, Field>, entry: Entry, at: string, errors: Record<string, string>,
 *   onChange: (entry: Entry) => void }} props `at`: the path of the entry in the server's errors (`/value/0`)
 */
function EntryFields({ fields, entry, at, errors, onChange }) {
	/** @param {string} name @param {any} value */
	const set = (name, value) => onChange({ ...entry, [name]: value });
	return (
		<FieldGrid>
			{Object.entries(fields).map(([name, field]) =>
				field.type === 'rows' ? (
					<div key={name} data-cell="" data-wide="" className="min-w-0 space-y-2">
						<p className="text-sm font-semibold">{wordsOf(name).label}</p>
						<RowStack
							fields={field.fields}
							rows={entry[name] ?? []}
							at={`${at}/${name}`}
							errors={errors}
							max={field.max}
							onChange={(rows) => set(name, rows)}
						/>
					</div>
				) : (
					<FieldInput
						key={name}
						name={name}
						field={field}
						value={entry[name]}
						{...(errors[`${at}/${name}`] ? { error: errors[`${at}/${name}`] } : {})}
						onChange={(value) => set(name, value)}
					/>
				),
			)}
		</FieldGrid>
	);
}

/**
 * The rows of an entry (a funnel's steps), each with its fields, up, down and remove, and Add.
 * @param {{ fields: Record<string, Field>, rows: Entry[], at: string, errors: Record<string, string>, max: number,
 *   onChange: (rows: Entry[]) => void }} props `at`: the path of the rows in the server's errors (`/value/0/steps`)
 */
function RowStack({ fields, rows, at, errors, max, onChange }) {
	return (
		<div className="space-y-3">
			{rows.map((row, index) => (
				<EntryGroup
					key={index}
					compact
					title={`${index + 1}. ${row.name || L.untitled}`}
					first={index === 0}
					last={index === rows.length - 1}
					texts={{ moveUp: L.up, moveDown: L.down, remove: L.remove }}
					onMove={(step) => onChange(moved(rows, index, step))}
					onRemove={() => onChange(rows.filter((_, other) => other !== index))}>
					<EntryFields
						fields={fields}
						entry={row}
						at={`${at}/${index}`}
						errors={errors}
						onChange={(next) => onChange(rows.map((other, i) => (i === index ? next : other)))}
					/>
				</EntryGroup>
			))}
			<Button
				size="sm"
				variant="secondary"
				disabled={rows.length >= max}
				onClick={() => onChange([...rows, blankEntry(fields, rows)])}>
				{L.add}
			</Button>
		</div>
	);
}

/** The field that names an entry, first found in a list (a goal's name, a conversion action's event, a check). */
const NAME_FIELDS = ['name', 'event', 'text', 'check'];

/** @param {Record<string, Field>} fields @returns {string} */
const nameField = (fields) => NAME_FIELDS.find((name) => name in fields) ?? 'name';

/**
 * The columns of a list's table beside the name (headers: `TEXTS.lists.columns.<key>`).
 * @typedef {{ key: string, render: (entry: Entry) => import('react').ReactNode, kind?: 'number', low?: boolean }} Column
 */

/** @param {string} field @returns {(entry: Entry) => string} */
const plain = (field) => (entry) => String(entry[field] ?? '');

/** A time of the editor (`2026-12-01T09:00`) as the table shows it. @param {string} field @returns {(entry: Entry) => string} */
const when = (field) => (entry) => String(entry[field] ?? '').replace('T', ' ');

/** @type {Record<ListName, Column[]>} */
const COLUMNS = {
	goals: [
		{ key: 'key', low: true, render: plain('key') },
		{ key: 'kind', render: (entry) => choiceLabel(String(entry.kind)) },
		{ key: 'match', render: plain('match') },
	],
	funnels: [
		{ key: 'key', low: true, render: plain('key') },
		{ key: 'steps', kind: 'number', render: (entry) => (Array.isArray(entry.steps) ? entry.steps.length : 0) },
	],
	consent_categories: [
		{ key: 'key', low: true, render: plain('key') },
		{ key: 'mode', render: (entry) => choiceLabel(String(entry.mode)) },
	],
	announcements: [
		{ key: 'key', low: true, render: plain('key') },
		{ key: 'from', render: when('startsAt') },
		{ key: 'until', render: when('endsAt') },
	],
	conversion_actions: [
		{ key: 'meta', render: plain('meta') },
		{ key: 'google', low: true, render: plain('google') },
		{ key: 'tiktok', low: true, render: plain('tiktok') },
	],
	verification_tags: [{ key: 'content', render: plain('content') }],
	seo_ignored: [{ key: 'page', render: (entry) => String(entry.page ?? '') || L.columns.everyPage }],
};

/**
 * One list's page: its entries as a table, the drawer of the picked entry, the frame's Save bar for the whole list,
 * and what the server said.
 * @param {{ websiteId: string, name: ListName, bare?: boolean }} props `bare`: the page already says the title, so the
 *   card has none
 */
export function ListCard({ websiteId, name, bare = false }) {
	const spec = LISTS[name];
	const path = `/v1/dashboard/websites/${websiteId}/lists/${name}`;
	const { answer, reload } = useLoad(path);
	const [draft, setDraft] = useState(/** @type {Entry[] | null} */ (null));
	const [opened, setOpened] = useState(/** @type {number | null} */ (null));
	const [result, setResult] = useState(/** @type {import('@ss/ui/dashboard').Answer | null} */ (null));
	const words = /** @type {{ title: string, help: string }} */ (/** @type {Record<string, unknown>} */ (L)[name]);
	const saved = answer?.ok ? /** @type {Entry[]} */ (answer.data.value) : null;
	const entries = draft ?? saved ?? [];
	const nameKey = nameField(spec.fields);
	const columns = COLUMNS[name];
	/** @param {Entry} entry */
	const nameOf = (entry) => String(entry[nameKey] ?? '').trim() || L.untitled;
	/** @type {Record<string, string>} */
	const errors = {};
	if (result && !result.ok)
		for (const error of /** @type {Array<{ path?: string, message?: string }>} */ (result.problem?.errors ?? []))
			if (error.path) errors[error.path] = String(error.message ?? '');
	/** The server's errors as lines: an entry's are said with its name, since the drawer is closed after a save. */
	const lines = () =>
		Object.entries(errors).map(([at, message]) => {
			const [, index, field] = /^\/value\/(\d+)(?:\/([^/]+))?/.exec(at) ?? [];
			const entry = index === undefined ? undefined : entries[Number(index)];
			if (!entry) return message;
			return `${nameOf(entry)}${field ? `, ${wordsOf(field).label}` : ''}: ${message}`;
		});
	const current = opened === null ? undefined : entries[opened];
	// many fields, or rows of their own: a large drawer
	const wide = Object.keys(spec.fields).length > 5 || Object.values(spec.fields).some((field) => field.type === 'rows');
	return (
		<Card
			{...(bare ? {} : { title: words.title })}
			subtitle={words.help}
			actions={
				<Button
					size="sm"
					disabled={!answer?.ok || entries.length >= spec.max}
					onClick={() => {
						setDraft([...entries, blankEntry(spec.fields, entries)]);
						setOpened(entries.length);
					}}>
					<Icon name="plus" size={14} />
					{L.add}
				</Button>
			}>
			<div className="space-y-4">
				<Loaded answer={answer} skeleton={<DataTableSkeleton columns={columns.length + 1} rows={4} menu />}>
					{() => (
						<DataTable
							caption={words.title}
							columns={[
								{ key: 'name', header: wordsOf(nameKey).label, render: (row) => nameOf(row.entry) },
								...columns.map((column) => ({
									key: column.key,
									header: /** @type {Record<string, string>} */ (L.columns)[column.key] ?? column.key,
									...(column.kind ? { kind: column.kind } : {}),
									...(column.low ? { low: true } : {}),
									render: (/** @type {{ entry: Entry }} */ row) => column.render(row.entry),
								})),
							]}
							rows={entries.map((entry, index) => ({ entry, index }))}
							rowKey={(row) => String(row.index)}
							rowLabel={(row) => nameOf(row.entry)}
							onRowClick={(row) => setOpened(row.index)}
							rowMenu={(row) => [
								{ label: L.up, disabled: row.index === 0, onSelect: () => setDraft(moved(entries, row.index, -1)) },
								{
									label: L.down,
									disabled: row.index === entries.length - 1,
									onSelect: () => setDraft(moved(entries, row.index, 1)),
								},
								{
									label: L.remove,
									danger: true,
									onSelect: () => setDraft(entries.filter((_, at) => at !== row.index)),
								},
							]}
							empty={L.none}
						/>
					)}
				</Loaded>
				<SaveBar
					show={draft !== null}
					saveLabel={L.save}
					discardLabel={TEXTS.cancel}
					onDiscard={() => {
						setDraft(null);
						setOpened(null);
					}}
					onSave={async () => {
						setOpened(null);
						const next = await call('PUT', path, { value: draft });
						setResult(next);
						if (next.ok) {
							setDraft(null);
							reload();
						}
					}}
				/>
				<SaveOutcome result={result} format={lines} />
			</div>
			<Drawer
				open={current !== undefined}
				onClose={() => setOpened(null)}
				title={current ? nameOf(current) : ''}
				size={wide ? 'lg' : 'md'}
				footer={<Button onClick={() => setOpened(null)}>{L.done}</Button>}>
				{current && opened !== null ? (
					<div data-entry="" className="space-y-4">
						<EntryFields
							fields={spec.fields}
							entry={current}
							at={`/value/${opened}`}
							errors={errors}
							onChange={(next) => setDraft(entries.map((other, i) => (i === opened ? next : other)))}
						/>
					</div>
				) : null}
			</Drawer>
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
		<Card subtitle={L.preset.help}>
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
			content: <ListCard websiteId={websiteId} name={name} bare />,
		});
	put('robots_verification', { id: 'preset', label: L.preset.title, content: <StorePresetCard websiteId={websiteId} /> });
	return out;
};
