'use client';
/**
 * Growth's merchant lists in Settings (`core/lists.js`; the kit's `GET|PUT /v1/dashboard/websites/:websiteId/lists/:list`):
 * one page per list of a switched-on feature: the entries are rich rows (icon, name, a dot when required fields are
 * empty, one line of facts, a value; the row menu moves one up or down or removes it), a click on a row opens the
 * entry's fields (a few fields in place under the row, a long editor in a drawer) that edit the draft only, Add, and
 * the frame's Save bar saves the whole list (a 422 lists the server's errors under the rows). An empty list is an empty
 * state with the one Add action. The editor is drawn from the list's fields, so every list gets add, rename, reorder
 * and remove the same way. Also the robots.txt online store preset (G12), one click.
 * @module
 */
import { Fragment, useState } from 'react';
import {
	ActionMenu,
	Button,
	Card,
	Checkbox,
	CheckboxGroup,
	Drawer,
	EmptyState,
	EntryGroup,
	FieldGrid,
	Icon,
	Input,
	Row,
	RowListSkeleton,
	Select,
	TextArea,
	SaveBar,
} from '@ss/ui';
import { Loaded, SaveOutcome, call, fill, useLoad } from '@ss/ui/dashboard';
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
 * @param {{ name: string, field: Field, value: any, error?: string, locked?: boolean, onChange: (value: any) => void }} props
 *   `locked`: the reader may not change it (it needs a permission they lack): shown read-only, with the reason
 */
function FieldInput({ name, field, value, error, locked = false, onChange }) {
	const words = wordsOf(name);
	const help = locked ? /** @type {{ locked?: string }} */ (words).locked : words.help;
	const common = { label: words.label, ...(help ? { help } : {}), ...(error ? { error } : {}) };
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
					disabled={locked}
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
 * @param {{ fields: Record<string, Field>, entry: Entry, at: string, errors: Record<string, string>, locked?: string[],
 *   onChange: (entry: Entry) => void }} props `at`: the path of the entry in the server's errors (`/value/0`); `locked`:
 *   the fields the reader may not change
 */
function EntryFields({ fields, entry, at, errors, locked = [], onChange }) {
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
						locked={locked.includes(name)}
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

/** @param {string} field @returns {(entry: Entry) => string} */
const plain = (field) => (entry) => String(entry[field] ?? '');

/** A time of the editor (`2026-12-01T09:00`) as a row says it. @param {string} field @returns {(entry: Entry) => string} */
const when = (field) => (entry) => String(entry[field] ?? '').replace('T', ' ');

/** `n` things in words: one, or the plural text with `{n}`. @param {{ one: string, other: string }} words @param {number} n */
const counted = (words, n) => (n === 1 ? words.one : fill(words.other, { n }));

/**
 * How a list's entries look as rows: the icon, the facts under the name (empty ones are left out) and the value at the
 * right (see `TEXTS.lists.columns` for the labels).
 * @typedef {{ icon: import('@ss/ui').IconName, meta: (entry: Entry) => string[], value?: (entry: Entry) => string }} Look
 */

/** @param {string} field @param {string} label @returns {(entry: Entry) => string} */
const labelled = (field, label) => (entry) => (entry[field] ? `${label}: ${entry[field]}` : '');

/** @type {Record<ListName, Look>} */
const LOOKS = {
	goals: {
		icon: 'trendingUp',
		meta: (entry) => [plain('key')(entry), plain('match')(entry)],
		value: (entry) => choiceLabel(String(entry.kind)),
	},
	funnels: {
		icon: 'filter',
		meta: (entry) => [plain('key')(entry)],
		value: (entry) => counted(L.stepsCount, Array.isArray(entry.steps) ? entry.steps.length : 0),
	},
	consent_categories: {
		icon: 'shield',
		meta: (entry) => [plain('key')(entry), plain('description')(entry)],
		value: (entry) => choiceLabel(String(entry.mode)),
	},
	announcements: {
		icon: 'bell',
		meta: (entry) => [
			plain('key')(entry),
			when('startsAt')(entry) && `${L.columns.from}: ${when('startsAt')(entry)}`,
			when('endsAt')(entry) && `${L.columns.until}: ${when('endsAt')(entry)}`,
		],
	},
	conversion_actions: {
		icon: 'zap',
		meta: (entry) => [
			labelled('meta', L.columns.meta)(entry),
			labelled('google', L.columns.google)(entry),
			labelled('tiktok', L.columns.tiktok)(entry),
		],
		value: (entry) => counted(L.pixelsCount, ['meta', 'google', 'tiktok'].filter((pixel) => entry[pixel]).length),
	},
	verification_tags: {
		icon: 'check',
		meta: (entry) => [plain('content')(entry)],
	},
	seo_ignored: {
		icon: 'search',
		meta: (entry) => [plain('page')(entry) || L.columns.everyPage],
	},
};

/**
 * One list's page: its entries as rich rows, the fields of the picked entry (under its row, or in a drawer when the
 * editor is long), the frame's Save bar for the whole list, and what the server said.
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
	/** The fields the server says this reader may not change (they need a permission the reader lacks). */
	const locked = answer?.ok && Array.isArray(answer.data.locked) ? /** @type {string[]} */ (answer.data.locked) : [];
	const entries = draft ?? saved ?? [];
	const nameKey = nameField(spec.fields);
	const look = LOOKS[name];
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
	// many fields, or rows of their own: a large drawer; a few fields open in place under their row
	const wide = Object.keys(spec.fields).length > 5 || Object.values(spec.fields).some((field) => field.type === 'rows');
	// a required text field that is still empty: the row says so with a dot
	const incomplete = (/** @type {Entry} */ entry) =>
		Object.entries(spec.fields).some(
			([key, field]) => field.type === 'text' && field.required === true && !String(entry[key] ?? '').trim(),
		);
	const add = () => {
		setDraft([...entries, blankEntry(spec.fields, entries)]);
		setOpened(entries.length);
	};
	const empty = answer?.ok === true && entries.length === 0;
	return (
		<Card
			{...(bare ? {} : { title: words.title })}
			subtitle={words.help}
			actions={
				empty ? null : (
					<Button size="sm" disabled={!answer?.ok || entries.length >= spec.max} onClick={add}>
						<Icon name="plus" size={14} />
						{L.add}
					</Button>
				)
			}>
			<div className="space-y-4">
				<Loaded answer={answer} skeleton={<RowListSkeleton rows={4} label={TEXTS.loading} />}>
					{() =>
						entries.length === 0 ? (
							<EmptyState
								compact
								icon={look.icon}
								title={L.none}
								action={
									<Button size="sm" onClick={add}>
										<Icon name="plus" size={14} />
										{L.add}
									</Button>
								}
							/>
						) : (
							<div>
								{entries.map((entry, index) => {
									const title = nameOf(entry);
									const on = opened === index;
									return (
										<Fragment key={index}>
											<Row
												lead={{ icon: look.icon, tone: 'primary' }}
												title={title}
												{...(incomplete(entry)
													? { status: { tone: /** @type {const} */ ('warning'), label: L.incomplete } }
													: {})}
												meta={look.meta(entry)}
												{...(look.value ? { value: look.value(entry) } : {})}
												selected={on}
												onSelect={() => setOpened(on && !wide ? null : index)}
												trailing={
													<ActionMenu
														floating
														label={fill(TEXTS.rowActions, { name: title })}
														items={[
															{
																label: L.up,
																disabled: index === 0,
																onSelect: () => setDraft(moved(entries, index, -1)),
															},
															{
																label: L.down,
																disabled: index === entries.length - 1,
																onSelect: () => setDraft(moved(entries, index, 1)),
															},
															{
																label: L.remove,
																danger: true,
																onSelect: () => {
																	setDraft(entries.filter((_, at) => at !== index));
																	setOpened(null);
																},
															},
														]}
													/>
												}
											/>
											{on && !wide ? (
												<div data-entry="" className="space-y-4 px-2.5 pt-2 pb-4">
													<EntryFields
														fields={spec.fields}
														entry={entry}
														at={`/value/${index}`}
														errors={errors}
														locked={locked}
														onChange={(next) => setDraft(entries.map((other, i) => (i === index ? next : other)))}
													/>
													<div className="flex justify-end">
														<Button onClick={() => setOpened(null)}>{L.done}</Button>
													</div>
												</div>
											) : null}
										</Fragment>
									);
								})}
							</div>
						)
					}
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
				open={wide && current !== undefined}
				onClose={() => setOpened(null)}
				title={current ? nameOf(current) : ''}
				size="lg"
				footer={<Button onClick={() => setOpened(null)}>{L.done}</Button>}>
				{wide && current && opened !== null ? (
					<div data-entry="" className="space-y-4">
						<EntryFields
							fields={spec.fields}
							entry={current}
							at={`/value/${opened}`}
							errors={errors}
							locked={locked}
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
