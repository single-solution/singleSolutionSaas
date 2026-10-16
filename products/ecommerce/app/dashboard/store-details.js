'use client';
/**
 * The Store details editor (Settings → Store details, the `store_details` list): name and tagline, logo and icon (kept
 * in the merchant's own storage; uploaded here straight to the bucket), contacts, address, opening hours with dated
 * exceptions (the booking schedules' shape), social links, time zone and language. The record is read with
 * `GET /v1/dashboard/websites/:websiteId/lists/store_details` and saved whole with `PUT … { value }`; a 422 lists the
 * server's check errors under the editor. The two files have their own routes (`./store-details/files`, `uploads`,
 * `logo`, `icon`) and change at once, not with Save.
 * @module
 */
import { useState } from 'react';
import { Button, Callout, Card, FieldGrid, Input, Select, TextArea } from '@ss/ui';
import { Loaded, call, fill, useLoad } from '@ss/ui/dashboard';
import { countryChoices } from '../../core/address.js';
import { STORE_LIMITS } from '../../core/store-details.js';
import { ListOutcome, SaveRow, useList } from './lists.js';
import { cleanLines } from './drafts.js';
import { TEXTS } from './texts.js';

/** @typedef {Record<string, any>} Item */

const S = TEXTS.lists.storeDetails;
const BLANK_WINDOW = Object.freeze({ day: 1, start: '09:00', end: '17:00' });

/** @param {Item} range a time range as typed: `HH:MM-HH:MM` */
const rangeLine = (range) => `${range.start}-${range.end}`;
/** @param {string} line */
const rangeOfLine = (line) => {
	const [start = '', end = ''] = line.split('-').map((part) => part.trim());
	return { start, end };
};

/**
 * The saved record as the draft the editor changes: the hours' exceptions and the social links as lines of text.
 * @param {Item} saved
 */
export const draftOf = (saved) => ({
	name: saved.name ?? '',
	tagline: saved.tagline ?? '',
	email: saved.email ?? '',
	phone: saved.phone ?? '',
	whatsapp: saved.whatsapp ?? '',
	address: {
		line1: '',
		line2: '',
		area: '',
		city: '',
		region: '',
		postalCode: '',
		country: '',
		...(saved.address ?? {}),
	},
	weekly: Array.isArray(saved.hours?.weekly) ? saved.hours.weekly : [],
	// one dated exception per line: `YYYY-MM-DD Name | HH:MM-HH:MM, HH:MM-HH:MM` (no hours = closed all day)
	exceptions: (Array.isArray(saved.hours?.exceptions) ? saved.hours.exceptions : [])
		.map(
			(/** @type {Item} */ entry) =>
				`${entry.date} ${entry.name ?? ''}`.trim() +
				((entry.hours ?? []).length > 0 ? ` | ${entry.hours.map(rangeLine).join(', ')}` : ''),
		)
		.join('\n'),
	// one link per line: `Name | https://…`
	social: (Array.isArray(saved.social) ? saved.social : [])
		.map((/** @type {Item} */ link) => `${link.label} | ${link.url}`)
		.join('\n'),
	timeZone: saved.timeZone ?? '',
	language: saved.language ?? '',
});

/**
 * The record to save from the draft; the logo and icon stay as they are saved (they change through their own routes).
 * @param {Item} draft @param {Item} saved
 */
export const valueOf = (draft, saved) => ({
	name: String(draft.name).trim(),
	tagline: String(draft.tagline).trim(),
	logo: saved.logo ?? null,
	icon: saved.icon ?? null,
	email: String(draft.email).trim(),
	phone: String(draft.phone).trim(),
	whatsapp: String(draft.whatsapp).trim(),
	address: Object.fromEntries(Object.entries(draft.address).map(([part, text]) => [part, String(text ?? '').trim()])),
	hours: {
		weekly: draft.weekly.map((/** @type {Item} */ window) => ({
			day: Number(window.day),
			start: String(window.start ?? ''),
			end: String(window.end ?? ''),
		})),
		exceptions: cleanLines(String(draft.exceptions).split('\n')).map((line) => {
			const [head = '', hours = ''] = line.split('|');
			const [date = '', ...name] = head.trim().split(/\s+/);
			return { date, name: name.join(' '), hours: cleanLines(hours.split(',')).map(rangeOfLine) };
		}),
	},
	social: cleanLines(String(draft.social).split('\n')).map((line) => {
		const at = line.indexOf('|');
		return { label: (at < 0 ? '' : line.slice(0, at)).trim(), url: (at < 0 ? line : line.slice(at + 1)).trim() };
	}),
	timeZone: String(draft.timeZone).trim(),
	language: String(draft.language).trim(),
});

/**
 * One of the two files: its picture, an upload and a remove button. A change is made at once.
 * @param {{ websiteId: string, name: 'logo' | 'icon', file: Item | null, onChanged: () => void }} props
 */
function FileField({ websiteId, name, file, onChanged }) {
	const base = `/v1/dashboard/websites/${websiteId}/store-details`;
	const [busy, setBusy] = useState(false);
	const [alt, setAlt] = useState(file?.alt ?? '');
	const [problem, setProblem] = useState('');
	/** @param {File | undefined} chosen */
	const send = async (chosen) => {
		if (!chosen) return;
		setBusy(true);
		setProblem('');
		const signed = await call('POST', `${base}/uploads`, { for: name, type: chosen.type, size: chosen.size });
		if (!signed.ok) {
			setProblem(S.uploadFailed);
			return setBusy(false);
		}
		const { method, url, headers } = signed.data.upload;
		try {
			const put = await fetch(url, { method, headers, body: chosen });
			if (!put.ok) throw new Error('upload');
		} catch {
			setProblem(S.uploadFailed);
			return setBusy(false);
		}
		const kept = await call('PUT', `${base}/${name}`, { key: signed.data.key, alt });
		setBusy(false);
		if (!kept.ok) return setProblem(S.uploadFailed);
		onChanged();
	};
	return (
		<div data-file={name} className="space-y-2 rounded-xl bg-surface-2 p-4">
			<p className="text-sm font-bold">{S[name]}</p>
			{file?.url ? (
				<img src={file.url} alt={file.alt ?? ''} className="h-16 w-auto max-w-full rounded-lg bg-surface-3 object-contain" />
			) : (
				<p className="text-sm text-muted">{S.noFile}</p>
			)}
			<Input label={S.alt} value={alt} maxLength={STORE_LIMITS.alt} onChange={(event) => setAlt(event.target.value)} />
			<div className="flex flex-wrap items-center gap-2">
				<label className="text-sm">
					<span className="sr-only">{S[name]}</span>
					<input
						type="file"
						accept="image/jpeg,image/png,image/webp,image/avif"
						disabled={busy}
						onChange={(event) => send(event.target.files?.[0])}
					/>
				</label>
				{file ? (
					<Button
						size="sm"
						variant="ghost"
						disabled={busy}
						onClick={async () => {
							setBusy(true);
							await call('DELETE', `${base}/${name}`);
							setBusy(false);
							onChanged();
						}}>
						{TEXTS.lists.remove}
					</Button>
				) : null}
			</div>
			{problem ? <Callout tone="danger">{problem}</Callout> : null}
		</div>
	);
}

/**
 * The Store details editor.
 * @param {{ websiteId: string, off?: boolean }} props
 */
export function StoreDetailsEditor({ websiteId, off }) {
	const state = useList(websiteId, 'store_details');
	const files = useLoad(`/v1/dashboard/websites/${websiteId}/store-details/files`);
	return (
		<Card title={S.title} subtitle={off ? TEXTS.settings.off : S.help}>
			<Loaded answer={state.answer}>
				{(data) => {
					const saved = /** @type {Item} */ (data.value ?? {});
					/** @type {Item} */
					const draft = state.draft ?? draftOf(saved);
					/** @param {Item} patch */
					const set = (patch) => state.setDraft({ ...draft, ...patch });
					/** @param {Item} patch */
					const setAddress = (patch) => set({ address: { ...draft.address, ...patch } });
					/** @param {number} index @param {Item} patch */
					const setWindow = (index, patch) =>
						set({
							weekly: draft.weekly.map((/** @type {Item} */ entry, /** @type {number} */ at) =>
								at === index ? { ...entry, ...patch } : entry,
							),
						});
					const fileViews = files.answer?.ok ? files.answer.data : { logo: null, icon: null };
					return (
						<div className="space-y-4">
							<FieldGrid>
								<Input
									label={S.name}
									value={draft.name}
									maxLength={STORE_LIMITS.name}
									onChange={(event) => set({ name: event.target.value })}
								/>
								<Input
									label={S.tagline}
									value={draft.tagline}
									maxLength={STORE_LIMITS.tagline}
									onChange={(event) => set({ tagline: event.target.value })}
								/>
							</FieldGrid>
							<div className="grid gap-3 sm:grid-cols-2">
								<FileField websiteId={websiteId} name="logo" file={fileViews.logo} onChanged={files.reload} />
								<FileField websiteId={websiteId} name="icon" file={fileViews.icon} onChanged={files.reload} />
							</div>
							<p className="text-sm font-bold">{S.contact}</p>
							<FieldGrid>
								<Input
									label={S.email}
									type="email"
									value={draft.email}
									maxLength={STORE_LIMITS.email}
									onChange={(event) => set({ email: event.target.value })}
								/>
								<Input
									label={S.phone}
									type="tel"
									value={draft.phone}
									maxLength={STORE_LIMITS.phone}
									onChange={(event) => set({ phone: event.target.value })}
								/>
								<Input
									label={S.whatsapp}
									type="tel"
									value={draft.whatsapp}
									maxLength={STORE_LIMITS.whatsapp}
									onChange={(event) => set({ whatsapp: event.target.value })}
								/>
							</FieldGrid>
							<p className="text-sm font-bold">{S.address}</p>
							<FieldGrid>
								<Select
									label={S.country}
									value={draft.address.country}
									options={[{ value: '', label: S.noCountry }, ...countryChoices()]}
									onChange={(event) => setAddress({ country: event.target.value })}
								/>
								{['line1', 'line2', 'area', 'city', 'region', 'postalCode'].map((part) => (
									<Input
										key={part}
										label={S.parts[/** @type {keyof typeof S.parts} */ (part)]}
										value={draft.address[part]}
										onChange={(event) => setAddress({ [part]: event.target.value })}
									/>
								))}
							</FieldGrid>
							<p className="text-sm font-bold">{S.hours}</p>
							<FieldGrid>
								<Input
									label={S.timeZone}
									help={S.timeZoneHelp}
									value={draft.timeZone}
									placeholder="America/New_York"
									onChange={(event) => set({ timeZone: event.target.value })}
								/>
								<Input
									label={S.language}
									help={S.languageHelp}
									value={draft.language}
									placeholder="en-US"
									onChange={(event) => set({ language: event.target.value })}
								/>
							</FieldGrid>
							{draft.weekly.map((/** @type {Item} */ window, /** @type {number} */ index) => (
								<div key={index} data-window="" className="flex flex-wrap items-end gap-2">
									<Select
										label={S.day}
										value={String(window.day ?? 1)}
										options={S.days.map((label, at) => ({ value: String(at + 1), label }))}
										onChange={(event) => setWindow(index, { day: Number(event.target.value) })}
									/>
									<Input
										label={S.from}
										type="time"
										value={window.start ?? ''}
										onChange={(event) => setWindow(index, { start: event.target.value })}
									/>
									<Input
										label={S.to}
										type="time"
										value={window.end ?? ''}
										onChange={(event) => setWindow(index, { end: event.target.value })}
									/>
									<Button
										size="sm"
										variant="ghost"
										onClick={() =>
											set({
												weekly: draft.weekly.filter(
													(/** @type {Item} */ _, /** @type {number} */ at) => at !== index,
												),
											})
										}>
										{TEXTS.lists.remove}
									</Button>
								</div>
							))}
							<Button
								size="sm"
								variant="secondary"
								disabled={draft.weekly.length >= 70}
								onClick={() => set({ weekly: [...draft.weekly, { ...BLANK_WINDOW }] })}>
								{S.addWindow}
							</Button>
							<TextArea
								label={S.exceptions}
								help={S.exceptionsHelp}
								rows={3}
								value={draft.exceptions}
								onChange={(event) => set({ exceptions: event.target.value })}
							/>
							<TextArea
								label={S.social}
								help={S.socialHelp}
								rows={3}
								value={draft.social}
								onChange={(event) => set({ social: event.target.value })}
							/>
							<SaveRow
								dirty={state.draft !== null}
								onCancel={() => state.setDraft(null)}
								onSave={() => state.save(valueOf(draft, saved))}
							/>
							<ListOutcome result={state.result} local={state.local} />
							<p className="text-sm text-muted">
								{fill(S.siteHelp, { read: '/v1/shop/store', json: '/v1/shop/store/business-json' })}
							</p>
						</div>
					);
				}}
			</Loaded>
		</Card>
	);
}
