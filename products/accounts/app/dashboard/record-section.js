'use client';
/**
 * A list of the merchant's own records in Settings (the consents, the custom fields), drawn as rich rows: each record is
 * a `Row` (icon, name, state dot, one line of facts, a value) with a menu to move it up or down or delete it. A click on a
 * row opens its fields in place, right under it (a second click closes them); Add opens a blank record at the top. An
 * empty list is an empty state with the one Add action. The list lives in the merchant database: a record is saved by
 * itself with `PUT <base>/<key>` and the order with `PUT <base>`; a database that is not connected says how to connect it.
 * @module
 */
import { Fragment, useState } from 'react';
import {
	ActionMenu,
	Button,
	Callout,
	Card,
	EmptyState,
	FieldGrid,
	Form,
	Row,
	RowListSkeleton,
	Section,
	describeProblem,
} from '@ss/ui';
import { Outcome, SaveOutcome, call, fill, useLoad } from '@ss/ui/dashboard';
import { TEXTS } from './texts.js';

/** @typedef {import('@ss/ui').IconName} IconName */
/** @typedef {{ key: string, isNew: boolean }} BaseDraft a record being edited, `isNew` while its key can still change */
/**
 * The words of one kind of record.
 * @typedef {{ add: string, editTitle: string, delete: string, up: string, down: string, none: string,
 *   needsDatabase: string }} RecordTexts
 */

/**
 * @template {{ key: string }} Item
 * @template {BaseDraft} Draft
 * @param {{ base: string, title: string, description: string, icon: IconName, texts: RecordTexts, blank: Draft,
 *   draftOf: (item: Item) => Draft, bodyOf: (draft: Draft) => Record<string, unknown>, ready: (draft: Draft) => boolean,
 *   rowOf: (item: Item) => Omit<Parameters<typeof Row>[0], 'onSelect' | 'selected' | 'trailing'>,
 *   fields: (draft: Draft, edit: (patch: Partial<Draft>) => void) => import('react').ReactNode }} props `blank`: a new
 *   record (its key is typed); `draftOf`: a saved record as a draft; `bodyOf`: what is saved; `ready`: whether the draft
 *   can be saved; `rowOf`: how a record looks in the list; `fields`: the draft's fields
 */
export function RecordSection({ base, title, description, icon, texts: T, blank, draftOf, bodyOf, ready, rowOf, fields }) {
	const { answer, reload } = useLoad(base);
	// the record being edited: a saved one opens under its row, a new one at the top
	const [draft, setDraft] = useState(/** @type {Draft | null} */ (null));
	const [saving, setSaving] = useState(false);
	const [result, setResult] = useState(/** @type {import('@ss/ui/dashboard').Answer | null} */ (null));
	const [problem, setProblem] = useState(/** @type {any} */ (null));
	/** @param {Partial<Draft>} patch */
	const edit = (patch) => setDraft({ .../** @type {Draft} */ (draft), ...patch });
	/** @param {Draft} next */
	const open = (next) => {
		setProblem(null);
		setDraft(next);
	};
	const close = () => setDraft(null);
	const save = async () => {
		if (!draft) return;
		setSaving(true);
		const next = await call('PUT', `${base}/${encodeURIComponent(draft.key)}`, bodyOf(draft));
		setSaving(false);
		if (!next.ok) return setProblem(next);
		setResult(next);
		close();
		reload();
	};
	/**
	 * Move a record one place up or down: the whole order is saved.
	 * @param {Item[]} items @param {number} index @param {-1 | 1} by
	 */
	const move = async (items, index, by) => {
		const keys = items.map((item) => item.key);
		const [moved] = keys.splice(index, 1);
		keys.splice(index + by, 0, /** @type {string} */ (moved));
		setResult(await call('PUT', base, { order: keys }));
		reload();
	};
	/** @param {Item} item */
	const remove = async (item) => {
		setResult(await call('DELETE', `${base}/${encodeURIComponent(item.key)}`));
		if (draft && !draft.isNew && draft.key === item.key) close();
		reload();
	};
	/** @type {Item[]} */
	const items = answer?.ok ? answer.data.items : [];
	const empty = answer?.ok === true && items.length === 0 && draft === null;
	const editor = draft ? (
		<Form onSubmit={save} aria-label={draft.isNew ? T.add : T.editTitle} className="px-2.5 pt-2 pb-4">
			<div className="space-y-4">
				<FieldGrid>{fields(draft, edit)}</FieldGrid>
				<SaveOutcome result={problem} />
				<div className="flex flex-wrap justify-end gap-2">
					<Button variant="secondary" onClick={close}>
						{TEXTS.cancel}
					</Button>
					<Button type="submit" loading={saving} disabled={!ready(draft)}>
						{TEXTS.save}
					</Button>
				</div>
			</div>
		</Form>
	) : null;
	return (
		<Section
			title={title}
			description={description}
			actions={
				empty || draft?.isNew ? null : (
					<Button size="sm" onClick={() => open({ ...blank })}>
						{T.add}
					</Button>
				)
			}>
			{!answer ? (
				<Card padded={false} bodyClassName="p-2">
					<RowListSkeleton rows={3} label={TEXTS.loading} />
				</Card>
			) : !answer.ok ? (
				<Callout tone="info">
					{answer.problem?.type?.endsWith('database_not_connected') ? T.needsDatabase : describeProblem(answer.problem)}
				</Callout>
			) : (
				<Card padded={false} bodyClassName="p-2">
					{draft?.isNew ? editor : null}
					{empty ? (
						<EmptyState
							compact
							icon={icon}
							title={T.none}
							action={
								<Button size="sm" onClick={() => open({ ...blank })}>
									{T.add}
								</Button>
							}
						/>
					) : null}
					{items.map((item, index) => {
						const look = rowOf(item);
						const on = draft !== null && !draft.isNew && draft.key === item.key;
						return (
							<Fragment key={item.key}>
								<Row
									{...look}
									selected={on}
									onSelect={() => (on ? close() : open(draftOf(item)))}
									trailing={
										<ActionMenu
											floating
											label={fill(TEXTS.rowActions, { name: typeof look.title === 'string' ? look.title : item.key })}
											items={[
												{ label: T.up, disabled: index === 0, onSelect: () => void move(items, index, -1) },
												{
													label: T.down,
													disabled: index === items.length - 1,
													onSelect: () => void move(items, index, 1),
												},
												{ label: T.delete, danger: true, onSelect: () => void remove(item) },
											]}
										/>
									}
								/>
								{on ? editor : null}
							</Fragment>
						);
					})}
				</Card>
			)}
			<Outcome result={result} />
		</Section>
	);
}
