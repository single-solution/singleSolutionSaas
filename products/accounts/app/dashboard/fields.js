'use client';
/**
 * Settings → Custom fields (PLAN 0.8.6): the merchant's own profile fields (text, number, date, choice), shown at
 * sign-up (required ones must be filled) and in My account. They live in the merchant database, so they need it
 * connected, and merchants edit them only while the Custom fields feature is on.
 * @module
 */
import { useState } from 'react';
import { Badge, Button, Callout, Card, Checkbox, Input, Section, Select, Skeleton, TextArea, describeProblem } from '@ss/ui';
import { call, useLoad } from './api.js';
import { TEXTS } from './texts.js';

/** @typedef {'text' | 'number' | 'date' | 'choice'} FieldType */
/** @typedef {{ key: string, label: string, type: FieldType, options: string[], required: boolean }} CustomField */
/** A field being edited: options as one text, `isNew` while its key can still change. @typedef {{ key: string, label: string, type: FieldType, options: string, required: boolean, isNew: boolean }} Draft */

const TYPES = /** @type {const} */ (['text', 'number', 'date', 'choice']);
/** @type {Draft} */
const EMPTY = { key: '', label: '', type: 'text', options: '', required: false, isNew: true };
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
	const [result, setResult] = useState(/** @type {import('./api.js').Answer | null} */ (null));
	/** @param {Partial<Draft>} patch */
	const edit = (patch) => setDraft({ .../** @type {Draft} */ (draft), ...patch });
	return (
		<Section
			title={TEXTS.settings.fieldsTitle}
			description={TEXTS.settings.fieldsHelp}
			actions={
				<Button size="sm" onClick={() => setDraft({ ...EMPTY })}>
					{T.add}
				</Button>
			}>
			{!answer ? (
				<Skeleton lines={2} label={TEXTS.loading} />
			) : !answer.ok ? (
				<Callout tone="info">
					{answer.problem?.type?.endsWith('database_not_connected') ? T.needsDatabase : describeProblem(answer.problem)}
				</Callout>
			) : (
				<Card>
					{answer.data.items.length === 0 ? <p className="text-sm text-muted">{T.none}</p> : null}
					<ul className="divide-y divide-line">
						{answer.data.items.map((/** @type {CustomField} */ item) => (
							<li key={item.key} className="flex flex-wrap items-center gap-2 py-3">
								<span className="min-w-0 flex-1">
									<span className="font-semibold">{item.label}</span>{' '}
									<code className="text-xs text-muted">{item.key}</code>
								</span>
								<Badge tone="info">{TEXTS.settings.fieldTypes[item.type]}</Badge>
								{item.required ? <Badge tone="warning">{T.required_badge}</Badge> : null}
								<Button
									size="sm"
									variant="secondary"
									onClick={() => setDraft({ ...item, options: item.options.join('\n'), isNew: false })}>
									{T.edit}
								</Button>
								<Button
									size="sm"
									variant="ghost"
									onClick={async () => {
										setResult(await call('DELETE', `${base}/${encodeURIComponent(item.key)}`));
										reload();
									}}>
									{T.delete}
								</Button>
							</li>
						))}
					</ul>
				</Card>
			)}
			{draft ? (
				<Card>
					<div className="grid gap-3 md:grid-cols-3">
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
					</div>
					{draft.type === 'choice' ? (
						<TextArea
							label={T.options}
							rows={4}
							value={draft.options}
							onChange={(event) => edit({ options: event.target.value })}
						/>
					) : null}
					<div className="mt-3">
						<Checkbox
							label={T.required}
							checked={draft.required}
							onChange={(event) => edit({ required: event.target.checked })}
						/>
					</div>
					<div className="mt-4 flex gap-2">
						<Button
							disabled={draft.key === '' || draft.label.trim() === ''}
							onClick={async () => {
								const next = await call('PUT', `${base}/${encodeURIComponent(draft.key)}`, {
									label: draft.label.trim(),
									type: draft.type,
									options: draft.type === 'choice' ? splitOptions(draft.options) : [],
									required: draft.required,
								});
								setResult(next);
								if (next.ok) {
									setDraft(null);
									reload();
								}
							}}>
							{TEXTS.save}
						</Button>
						<Button variant="ghost" onClick={() => setDraft(null)}>
							{TEXTS.cancel}
						</Button>
					</div>
				</Card>
			) : null}
			{result ? (
				result.ok ? (
					<Callout tone="success">{TEXTS.saved}</Callout>
				) : (
					<Callout tone="danger">{describeProblem(result.problem)}</Callout>
				)
			) : null}
		</Section>
	);
}
