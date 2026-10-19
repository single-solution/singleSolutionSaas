'use client';
/**
 * Settings → Consents (A2): the merchant's consent list, in their order: each consent has the merchant's words next to
 * the box, a page to read, a version, required or not, and a purpose (an agreement such as the terms or a privacy
 * policy, or marketing, which is kept apart and never required). The terms consent is there from the start. The list
 * lives in the merchant database, so it needs it connected, and merchants edit it only while Consents is on.
 * @module
 */
import { useId, useState } from 'react';
import {
	Button,
	Callout,
	Card,
	Checkbox,
	DataTable,
	DataTableSkeleton,
	Drawer,
	Form,
	Input,
	Section,
	Select,
	StatusPill,
	describeProblem,
} from '@ss/ui';
import { Outcome, SaveOutcome, call, useLoad } from '@ss/ui/dashboard';
import { TEXTS } from './texts.js';

/** @typedef {'agreement' | 'marketing'} Purpose */
/** @typedef {{ key: string, label: string, url: string, version: string, required: boolean, purpose: Purpose }} Consent */
/** A consent being edited, `isNew` while its key can still change. @typedef {Consent & { isNew: boolean }} Draft */

const PURPOSES = /** @type {const} */ (['agreement', 'marketing']);
/** @type {Draft} */
const EMPTY = { key: '', label: '', url: '', version: '1', required: false, purpose: 'agreement', isNew: true };
const T = TEXTS.settings.consent;

/**
 * The columns of the consents table: the words next to the box, key, version, purpose, and a pill for a required one.
 * @type {Array<{ key: string, header: string, low?: boolean, render: (item: Consent) => import('react').ReactNode }>}
 */
const COLUMNS = [
	{ key: 'label', header: T.columns.label, render: (item) => item.label },
	{ key: 'key', header: T.columns.key, low: true, render: (item) => <code className="break-all">{item.key}</code> },
	{ key: 'version', header: T.columns.version, low: true, render: (item) => item.version },
	{ key: 'purpose', header: T.columns.purpose, render: (item) => TEXTS.settings.consentPurposes[item.purpose] },
	{
		key: 'required',
		header: T.columns.required,
		render: (item) => (item.required ? <StatusPill status="info">{T.required_badge}</StatusPill> : null),
	},
];

/** @param {{ websiteId: string }} props */
export function ConsentsSection({ websiteId }) {
	const base = `/v1/dashboard/websites/${websiteId}/consents`;
	const { answer, reload } = useLoad(base);
	const formId = useId();
	// the consent in the drawer stays while the drawer closes; `shown` says whether the drawer is open
	const [draft, setDraft] = useState(/** @type {Draft | null} */ (null));
	const [shown, setShown] = useState(false);
	const [saving, setSaving] = useState(false);
	const [result, setResult] = useState(/** @type {import('@ss/ui/dashboard').Answer | null} */ (null));
	const [problem, setProblem] = useState(/** @type {any} */ (null));
	/** @param {Partial<Draft>} patch */
	const edit = (patch) => setDraft({ .../** @type {Draft} */ (draft), ...patch });
	/** @param {Draft} next */
	const open = (next) => {
		setProblem(null);
		setDraft(next);
		setShown(true);
	};
	const close = () => setShown(false);
	const save = async () => {
		if (!draft) return;
		setSaving(true);
		const next = await call('PUT', `${base}/${encodeURIComponent(draft.key)}`, {
			label: draft.label.trim(),
			url: draft.url.trim(),
			version: draft.version.trim(),
			required: draft.purpose === 'agreement' && draft.required,
			purpose: draft.purpose,
		});
		setSaving(false);
		if (!next.ok) return setProblem(next);
		setResult(next);
		close();
		reload();
	};
	/**
	 * Move a consent one place up or down: the whole order is saved.
	 * @param {Consent[]} items @param {number} index @param {-1 | 1} by
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
			title={TEXTS.settings.consentsTitle}
			description={TEXTS.settings.consentsHelp}
			actions={
				<Button size="sm" onClick={() => open({ ...EMPTY })}>
					{T.add}
				</Button>
			}>
			{!answer ? (
				<DataTableSkeleton columns={COLUMNS.length} rows={3} menu label={TEXTS.loading} />
			) : !answer.ok ? (
				<Callout tone="info">
					{answer.problem?.type?.endsWith('database_not_connected') ? T.needsDatabase : describeProblem(answer.problem)}
				</Callout>
			) : (
				<Card padded={false} className="overflow-hidden">
					<DataTable
						caption={TEXTS.settings.consentsTitle}
						columns={COLUMNS}
						rows={/** @type {Consent[]} */ (answer.data.items)}
						rowKey={(item) => item.key}
						rowLabel={(item) => item.label}
						onRowClick={(item) => open({ ...item, isNew: false })}
						rowMenu={(item) => {
							/** @type {Consent[]} */
							const items = answer.data.items;
							const index = items.indexOf(item);
							return [
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
							];
						}}
						empty={T.none}
					/>
				</Card>
			)}
			<Outcome result={result} />
			<Drawer
				open={shown}
				onClose={close}
				title={draft?.isNew === false ? T.editTitle : T.add}
				closeLabel={TEXTS.cancel}
				footer={
					<>
						<Button variant="secondary" onClick={close}>
							{TEXTS.cancel}
						</Button>
						<Button
							type="submit"
							form={formId}
							loading={saving}
							disabled={!draft || draft.key === '' || draft.label.trim() === '' || draft.version.trim() === ''}>
							{TEXTS.save}
						</Button>
					</>
				}>
				{draft ? (
					<Form id={formId} onSubmit={save} aria-label={draft.isNew ? T.add : T.editTitle}>
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
							maxLength={200}
							onChange={(event) => edit({ label: event.target.value })}
						/>
						<Input
							label={T.url}
							type="url"
							value={draft.url}
							maxLength={2048}
							onChange={(event) => edit({ url: event.target.value })}
						/>
						<Input
							label={T.version}
							value={draft.version}
							maxLength={40}
							onChange={(event) => edit({ version: event.target.value })}
						/>
						<Select
							label={T.purpose}
							value={draft.purpose}
							options={PURPOSES.map((value) => ({ value, label: TEXTS.settings.consentPurposes[value] }))}
							onChange={(event) => edit({ purpose: /** @type {Purpose} */ (event.target.value) })}
						/>
						{draft.purpose === 'agreement' ? (
							<Checkbox
								label={T.required}
								checked={draft.required}
								onChange={(event) => edit({ required: event.target.checked })}
							/>
						) : null}
						<SaveOutcome result={problem} />
					</Form>
				) : null}
			</Drawer>
		</Section>
	);
}
