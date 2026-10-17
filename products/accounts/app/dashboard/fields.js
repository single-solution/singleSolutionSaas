'use client';
/**
 * Settings → Custom fields (PLAN 0.8.6, A6): the merchant's own profile fields of any type (text, long text, number,
 * date, one or several choices, yes/no, email address, web address), each with a help text and who sees it (the user
 * edits it, the user only sees it, or staff only), in the merchant's order. The fields the user edits are asked at
 * sign-up (required ones must be filled) and shown in My account. They live in the merchant database, so they need it
 * connected, and merchants edit them only while the Custom fields feature is on.
 * @module
 */
import { useState } from 'react';
import { Badge, Button, Callout, Card, Checkbox, Dialog, EmptyState, Form, Input, Section, Select, Skeleton, TextArea, describeProblem, ListRow, RowList } from '@ss/ui';
import { Outcome, SaveOutcome, call, useLoad } from '@ss/ui/dashboard';
import { TEXTS } from './texts.js';

/** @typedef {'text' | 'textarea' | 'number' | 'date' | 'choice' | 'multi_choice' | 'boolean' | 'email' | 'url'} FieldType */
/** @typedef {'edit' | 'view' | 'staff'} Visibility */
/** @typedef {{ key: string, label: string, type: FieldType, options: string[], required: boolean, visibility: Visibility, help: string }} CustomField */
/** A field being edited: options as one text, `isNew` while its key can still change. @typedef {Omit<CustomField, 'options'> & { options: string, isNew: boolean }} Draft */

const TYPES = /** @type {const} */ (['text', 'textarea', 'number', 'date', 'choice', 'multi_choice', 'boolean', 'email', 'url']);
const VISIBILITY = /** @type {const} */ (['edit', 'view', 'staff']);
/** The types whose fields have options. */
const CHOICES = ['choice', 'multi_choice'];
/** @type {Draft} */
const EMPTY = { key: '', label: '', type: 'text', options: '', required: false, visibility: 'edit', help: '', isNew: true };
const T = TEXTS.settings.field;

/**
 * Options typed as one text: split on commas or line breaks, trimmed, empty ones dropped.
 * @param {string} text
 */
const splitOptions = (text) =>
	text
		.split(/[,\n]/)
		.map((option) => option.trim())
		.filter((option) => option !== '');

/** @param {{ websiteId: string }} props */
export function FieldsSection({ websiteId }) {
	const base = `/v1/dashboard/websites/${websiteId}/fields`;
	const { answer, reload } = useLoad(base);
	const [draft, setDraft] = useState(/** @type {Draft | null} */ (null));
	const [result, setResult] = useState(/** @type {import('@ss/ui/dashboard').Answer | null} */ (null));
	const [problem, setProblem] = useState(/** @type {any} */ (null));
	/** @param {Partial<Draft>} patch */
	const edit = (patch) => setDraft({ .../** @type {Draft} */ (draft), ...patch });
	/** @param {Draft} next */
	const open = (next) => {
		setProblem(null);
		setDraft(next);
	};
	const save = async () => {
		if (!draft) return;
		const next = await call('PUT', `${base}/${encodeURIComponent(draft.key)}`, {
			label: draft.label.trim(),
			type: draft.type,
			options: CHOICES.includes(draft.type) ? splitOptions(draft.options) : [],
			required: draft.required,
			visibility: draft.visibility,
			help: draft.help.trim(),
		});
		if (!next.ok) return setProblem(next);
		setResult(next);
		setDraft(null);
		reload();
	};
	/**
	 * Move a field one place up or down: the whole order is saved.
	 * @param {CustomField[]} items @param {number} index @param {-1 | 1} by
	 */
	const move = async (items, index, by) => {
		const keys = items.map((item) => item.key);
		const [moved] = keys.splice(index, 1);
		keys.splice(index + by, 0, /** @type {string} */ (moved));
		setResult(await call('PUT', base, { order: keys }));
		reload();
	};
	return (
		<Section
			title={TEXTS.settings.fieldsTitle}
			description={TEXTS.settings.fieldsHelp}
			actions={
				<Button size="sm" onClick={() => open({ ...EMPTY })}>
					{T.add}
				</Button>
			}>
			{!answer ? (
				<Skeleton lines={2} label={TEXTS.loading} />
			) : !answer.ok ? (
				<Callout tone="info">
					{answer.problem?.type?.endsWith('database_not_connected') ? T.needsDatabase : describeProblem(answer.problem)}
				</Callout>
			) : answer.data.items.length === 0 ? (
				<EmptyState compact icon="user" kind="settings" title={T.none} />
			) : (
				<Card>
					<RowList>
						{answer.data.items.map(
							(/** @type {CustomField} */ item, /** @type {number} */ index, /** @type {CustomField[]} */ items) => (
								<ListRow
									key={item.key}
									wrap
									title={item.label}
									status={
										<>
											<Badge kind="settings">{TEXTS.settings.fieldTypes[item.type]}</Badge>
											<Badge>{TEXTS.settings.fieldVisibility[item.visibility]}</Badge>
											{item.required ? <Badge>{T.required_badge}</Badge> : null}
										</>
									}
									meta={<code className="break-all">{item.key}</code>}
									action={
										<Button
											size="sm"
											variant="secondary"
											onClick={() => open({ ...item, options: item.options.join('\n'), isNew: false })}>
											{T.edit}
										</Button>
									}
									moreLabel={`${T.more}: ${item.label}`}
									more={[
										{ label: T.up, disabled: index === 0, onSelect: () => move(items, index, -1) },
										{ label: T.down, disabled: index === items.length - 1, onSelect: () => move(items, index, 1) },
										{
											label: T.delete,
											danger: true,
											onSelect: async () => {
												setResult(await call('DELETE', `${base}/${encodeURIComponent(item.key)}`));
												reload();
											},
										},
									]}
								/>
							),
						)}
					</RowList>
				</Card>
			)}
			<Outcome result={result} />
			<Dialog open={draft !== null} onClose={() => setDraft(null)} title={draft?.isNew === false ? T.editTitle : T.add}>
				{draft ? (
					<Form onSubmit={save} aria-label={draft.isNew ? T.add : T.editTitle}>
						<Input
							label={T.key}
							value={draft.key}
							maxLength={40}
							disabled={!draft.isNew}
							autoComplete="off"
							onChange={(event) => edit({ key: event.target.value.trim() })}
						/>
						<Input
							label={T.label}
							value={draft.label}
							maxLength={80}
							onChange={(event) => edit({ label: event.target.value })}
						/>
						<Select
							label={T.type}
							value={draft.type}
							options={TYPES.map((value) => ({ value, label: TEXTS.settings.fieldTypes[value] }))}
							onChange={(event) => edit({ type: /** @type {FieldType} */ (event.target.value) })}
						/>
						<Select
							label={T.visibility}
							value={draft.visibility}
							options={VISIBILITY.map((value) => ({ value, label: TEXTS.settings.fieldVisibility[value] }))}
							onChange={(event) => edit({ visibility: /** @type {Visibility} */ (event.target.value) })}
						/>
						<Input
							label={T.help}
							value={draft.help}
							maxLength={200}
							onChange={(event) => edit({ help: event.target.value })}
						/>
						<Checkbox
							label={T.required}
							checked={draft.required}
							onChange={(event) => edit({ required: event.target.checked })}
						/>
						{CHOICES.includes(draft.type) ? (
							<TextArea
								label={T.options}
								rows={4}
								value={draft.options}
								onChange={(event) => edit({ options: event.target.value })}
							/>
						) : null}
						<SaveOutcome result={problem} />
						<div className="flex flex-wrap gap-2">
							<Button type="submit" disabled={draft.key === '' || draft.label.trim() === ''}>
								{TEXTS.save}
							</Button>
							<Button variant="ghost" onClick={() => setDraft(null)}>
								{TEXTS.cancel}
							</Button>
						</div>
					</Form>
				) : null}
			</Dialog>
		</Section>
	);
}
