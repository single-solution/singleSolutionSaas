'use client';
/**
 * Settings → Consents (A2): the merchant's consent list, in their order: each consent has the merchant's words next to
 * the box, a page to read, a version, required or not, and a purpose (an agreement such as the terms or a privacy
 * policy, or marketing, which is kept apart and never required). The terms consent is there from the start. The list
 * lives in the merchant database, so it needs it connected, and merchants edit it only while Consents is on.
 * @module
 */
import { useState } from 'react';
import {
	Badge,
	Button,
	Callout,
	Card,
	Checkbox,
	Dialog,
	EmptyState,
	Form,
	Input,
	Section,
	Select,
	Skeleton,
	describeProblem,
} from '@ss/ui';
import { Outcome, call, useLoad } from '@ss/ui/dashboard';
import { TEXTS } from './texts.js';

/** @typedef {'agreement' | 'marketing'} Purpose */
/** @typedef {{ key: string, label: string, url: string, version: string, required: boolean, purpose: Purpose }} Consent */
/** A consent being edited, `isNew` while its key can still change. @typedef {Consent & { isNew: boolean }} Draft */

const PURPOSES = /** @type {const} */ (['agreement', 'marketing']);
/** @type {Draft} */
const EMPTY = { key: '', label: '', url: '', version: '1', required: false, purpose: 'agreement', isNew: true };
const T = TEXTS.settings.consent;

/** @param {{ websiteId: string }} props */
export function ConsentsSection({ websiteId }) {
	const base = `/v1/dashboard/websites/${websiteId}/consents`;
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
			url: draft.url.trim(),
			version: draft.version.trim(),
			required: draft.purpose === 'agreement' && draft.required,
			purpose: draft.purpose,
		});
		if (!next.ok) return setProblem(next.problem);
		setResult(next);
		setDraft(null);
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
				<Skeleton lines={2} label={TEXTS.loading} />
			) : !answer.ok ? (
				<Callout tone="info">
					{answer.problem?.type?.endsWith('database_not_connected') ? T.needsDatabase : describeProblem(answer.problem)}
				</Callout>
			) : answer.data.items.length === 0 ? (
				<EmptyState compact icon="user" kind="settings" title={T.none} />
			) : (
				<Card>
					<ul className="divide-y divide-line-soft">
						{answer.data.items.map(
							(/** @type {Consent} */ item, /** @type {number} */ index, /** @type {Consent[]} */ items) => (
								<li key={item.key} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3 first:pt-0 last:pb-0">
									<span className="min-w-0 flex-[1_1_12rem]">
										<span className="block break-words text-sm font-semibold text-fg">{item.label}</span>
										<code className="block break-all text-xs text-muted">
											{item.key} · {T.versionShort} {item.version}
										</code>
									</span>
									<span className="flex flex-wrap gap-1.5">
										<Badge kind="settings">{TEXTS.settings.consentPurposes[item.purpose]}</Badge>
										{item.required ? <Badge>{T.required_badge}</Badge> : null}
									</span>
									<span className="flex flex-wrap gap-2">
										<Button
											size="sm"
											variant="ghost"
											disabled={index === 0}
											aria-label={`${T.up}: ${item.label}`}
											onClick={() => move(items, index, -1)}>
											{T.up}
										</Button>
										<Button
											size="sm"
											variant="ghost"
											disabled={index === items.length - 1}
											aria-label={`${T.down}: ${item.label}`}
											onClick={() => move(items, index, 1)}>
											{T.down}
										</Button>
										<Button size="sm" variant="secondary" onClick={() => open({ ...item, isNew: false })}>
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
									</span>
								</li>
							),
						)}
					</ul>
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
						{problem ? <Callout tone="danger">{describeProblem(problem)}</Callout> : null}
						<div className="flex flex-wrap gap-2">
							<Button
								type="submit"
								disabled={draft.key === '' || draft.label.trim() === '' || draft.version.trim() === ''}>
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
