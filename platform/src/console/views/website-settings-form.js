'use client';
/**
 * The pieces every section of Website settings shares: `useSectionForm` (the draft of one section, its dirty state,
 * the save with the version the person read, and the answers: field errors, a stale version), `SectionForm` (the
 * section's cards with the floating Save bar and the problem on top) and `Summary` rows that open a right drawer for
 * nested things (an address, the opening hours, a list of documents). Words come from `texts/console.js`.
 * @module
 */
import { useEffect, useState } from 'react';
import { Button, Callout, FormError, SaveBar, SettingRow, describeProblem, fieldErrors, useToast } from '@ss/ui';
import { WEBSITE_SETTINGS as T } from '../../texts/console.js';
import { apiFetch } from '../client.js';
import { api } from '../paths.js';

/** @typedef {import('@ss/contracts').WebsiteSettings} WebsiteSettings */
/** @typedef {import('@ss/ui/problems').Problem} Problem */

/**
 * The same value with `value` at `path` (objects and arrays are copied along the way, never changed).
 * @template T
 * @param {T} target
 * @param {ReadonlyArray<string | number>} path
 * @param {unknown} value
 * @returns {T}
 */
export const setIn = (target, path, value) => {
	const [head, ...rest] = path;
	if (head === undefined) return /** @type {T} */ (value);
	const copy = Array.isArray(target) ? [...target] : { .../** @type {object} */ (target) };
	/** @type {any} */ (copy)[head] = setIn(/** @type {any} */ (target)?.[head], rest, value);
	return /** @type {T} */ (copy);
};

/** @param {unknown} a @param {unknown} b */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The state of one section's form.
 * @template {Record<string, any>} S
 * @param {{ manage: { merchantId: string, websiteId: string }, section: string, saved: S, version: number,
 *   onSaved: (answer: { settings: WebsiteSettings, readiness: any[] }) => void, onStale: () => void }} input
 */
export const useSectionForm = ({ manage, section, saved, version, onSaved, onStale }) => {
	const toast = useToast();
	const [draft, setDraft] = useState(saved);
	const [saving, setSaving] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	// a new saved copy (after a save here, or a reload) is the new starting point
	useEffect(() => {
		setDraft(saved);
		setProblem(null);
	}, [saved]);
	const errors = fieldErrors(problem, { base: `/${section}/` });
	const dirty = !same(draft, saved);
	return {
		draft,
		setDraft,
		dirty,
		saving,
		problem,
		errors,
		/** The error of the field at a path of the section (`['address', 'city']`). @param {ReadonlyArray<string | number>} path */
		error: (path) => errors[path.join('.')],
		/** Change the value at a path of the section. @param {ReadonlyArray<string | number>} path @param {unknown} value */
		change: (path, value) => setDraft((old) => setIn(old, path, value)),
		discard: () => {
			setDraft(saved);
			setProblem(null);
		},
		save: async () => {
			setSaving(true);
			setProblem(null);
			const result = await apiFetch(api.websiteSettingsSection(manage.merchantId, manage.websiteId, section), {
				method: 'PUT',
				body: { version, value: draft },
			});
			setSaving(false);
			if (result.ok) {
				onSaved(result.data);
				toast.show({ title: T.saved });
				return;
			}
			if (result.status === 409) onStale();
			setProblem(result.problem);
			if (result.status !== 422) toast.show({ tone: 'danger', title: describeProblem(result.problem) });
		},
	};
};

/**
 * One section: its cards (in the card flow of the inner-sidebar layout), the problem a save answered and the floating
 * Save bar. A section the person may not change is read-only (every control disabled).
 * @param {{ form: ReturnType<typeof useSectionForm>, canWrite: boolean, onReload: () => void, stale: boolean,
 *   children: import('react').ReactNode }} props
 */
export function SectionForm({ form, canWrite, onReload, stale, children }) {
	return (
		<>
			{stale ? (
				<Callout
					tone="warning"
					className="col-span-full"
					actions={
						<Button size="sm" variant="secondary" onClick={onReload}>
							{T.reload}
						</Button>
					}>
					{T.stale}
				</Callout>
			) : form.problem && form.problem.status !== 409 ? (
				<FormError problem={form.problem} className="col-span-full" />
			) : null}
			{!canWrite ? (
				<Callout tone="info" className="col-span-full">
					{T.readOnly}
				</Callout>
			) : null}
			<fieldset disabled={!canWrite || form.saving} className="contents">
				{children}
			</fieldset>
			<SaveBar
				show={canWrite && form.dirty}
				onSave={() => void form.save()}
				onDiscard={form.discard}
				saving={form.saving}
				message={T.unsaved}
				saveLabel={T.save}
				discardLabel={T.discard}
			/>
		</>
	);
}

/**
 * A row for something nested: its label, a one-line summary of what it holds and an Edit button that opens the
 * drawer.
 * @param {{ label: import('react').ReactNode, description?: import('react').ReactNode, summary: import('react').ReactNode,
 *   onEdit: () => void, error?: string, editLabel?: string }} props
 */
export function SummaryRow({ label, description, summary, onEdit, error, editLabel = T.edit }) {
	return (
		<SettingRow label={label} {...(description ? { description } : {})}>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<span className="min-w-0 text-sm break-words text-fg">{summary}</span>
				<Button size="sm" variant="secondary" onClick={onEdit}>
					{editLabel}
				</Button>
			</div>
			{error ? (
				<p role="alert" className="text-help text-danger">
					{error}
				</p>
			) : null}
		</SettingRow>
	);
}
