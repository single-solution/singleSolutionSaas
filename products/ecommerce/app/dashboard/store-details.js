'use client';
/**
 * The Store details editor (Settings → Store details, the `store_details` list): name and tagline, the pictures (logo,
 * dark logo, icon, favicon, dark favicon: kept in the merchant's own storage; uploaded here straight to the bucket),
 * contacts with more phone numbers, address, opening hours with dated exceptions (the booking schedules' shape), social
 * links, time zone and language. The record is read with `GET /v1/dashboard/websites/:websiteId/lists/store_details`
 * and saved whole with `PUT … { value }`; a 422 lists the server's check errors under the editor. The pictures have
 * their own routes (`./store-details/files`, `uploads`, and one per picture) and change at once, not with Save.
 * @module
 */
import { useState } from 'react';
import { Button, Card, EntryGroup, FieldGrid, Input, KeyValueList, ManagedNote, Select, TextArea, useToast } from '@ss/ui';
import { Loaded, call, fill, useLoad } from '@ss/ui/dashboard';
import { countryChoices } from '../../core/address.js';
import { STORE_FILES, STORE_LIMITS } from '../../core/store-details.js';
import { ListOutcome, SaveRow, useList } from './lists.js';
import { cleanLines } from './drafts.js';
import { TEXTS } from './texts.js';

/** @typedef {Record<string, any>} Item */
/** @typedef {import('../../core/store-details.js').StoreFileName} StoreFileName */

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
 * The saved record as the draft the editor changes: the hours' exceptions, the phones and the social links as lines of
 * text.
 * @param {Item} saved
 */
export const draftOf = (saved) => ({
	name: saved.name ?? '',
	tagline: saved.tagline ?? '',
	email: saved.email ?? '',
	phone: saved.phone ?? '',
	// one more phone per line: `Name | number` (the name is optional: a line with a number only has none)
	phones: (Array.isArray(saved.phones) ? saved.phones : [])
		.map((/** @type {Item} */ entry) => (entry.label ? `${entry.label} | ${entry.number}` : String(entry.number)))
		.join('\n'),
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
 * The record to save from the draft; the pictures stay as they are saved (they change through their own routes).
 * @param {Item} draft @param {Item} saved
 */
export const valueOf = (draft, saved) => ({
	name: String(draft.name).trim(),
	tagline: String(draft.tagline).trim(),
	...Object.fromEntries(STORE_FILES.map((name) => [name, saved[name] ?? null])),
	email: String(draft.email).trim(),
	phone: String(draft.phone).trim(),
	phones: cleanLines(String(draft.phones).split('\n')).map((line) => {
		const at = line.indexOf('|');
		return { label: (at < 0 ? '' : line.slice(0, at)).trim(), number: (at < 0 ? line : line.slice(at + 1)).trim() };
	}),
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
 * One of the pictures: what it is for, its image, an upload and a remove button. A change is made at once.
 * @param {{ websiteId: string, name: StoreFileName, file: Item | null, onChanged: () => void }} props
 */
function FileField({ websiteId, name, file, onChanged }) {
	const base = `/v1/dashboard/websites/${websiteId}/store-details`;
	const [busy, setBusy] = useState(false);
	const [alt, setAlt] = useState(file?.alt ?? '');
	const toast = useToast();
	/** A failed upload is a toast, not a message in the page. */
	const failed = () => toast.show({ tone: 'danger', title: TEXTS.saveFailed, description: S.uploadFailed });
	/** @param {File | undefined} chosen */
	const send = async (chosen) => {
		if (!chosen) return;
		setBusy(true);
		const signed = await call('POST', `${base}/uploads`, { for: name, type: chosen.type, size: chosen.size });
		if (!signed.ok) {
			failed();
			return setBusy(false);
		}
		const { method, url, headers } = signed.data.upload;
		try {
			const put = await fetch(url, { method, headers, body: chosen });
			if (!put.ok) throw new Error('upload');
		} catch {
			failed();
			return setBusy(false);
		}
		const kept = await call('PUT', `${base}/${name}`, { key: signed.data.key, alt });
		setBusy(false);
		if (!kept.ok) return failed();
		onChanged();
	};
	return (
		<EntryGroup data-file={name} title={S.files[name].title}>
			<p className="text-sm text-muted">{S.files[name].help}</p>
			{file?.url ? (
				<img src={file.url} alt={file.alt ?? ''} className="h-16 w-auto max-w-full rounded-lg bg-surface-3 object-contain" />
			) : (
				<p className="text-sm text-muted">{S.noFile}</p>
			)}
			<Input label={S.alt} value={alt} maxLength={STORE_LIMITS.alt} onChange={(event) => setAlt(event.target.value)} />
			<div className="flex flex-wrap items-center gap-2">
				<Input
					type="file"
					hideLabel
					label={S.files[name].title}
					accept="image/jpeg,image/png,image/webp,image/avif"
					disabled={busy}
					fieldClassName="min-w-0 flex-1 basis-64"
					onChange={(event) => send(event.target.files?.[0])}
				/>
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
		</EntryGroup>
	);
}

/**
 * The record while the Portal owns it: where it is set, with a link, and what it says.
 * @param {{ record: Item, websiteId: string, portal?: string }} props
 */
function FromPortal({ record, websiteId, portal }) {
	const href = portal ? `${portal.replace(/\/+$/, '')}/websites/${encodeURIComponent(websiteId)}/settings#business` : undefined;
	const address = [record.address?.line1, record.address?.city, record.address?.country].filter(Boolean).join(', ');
	return (
		<div className="space-y-4">
			<ManagedNote title={S.managedTitle} {...(href ? { href } : {})} linkLabel={S.managedOpen}>
				{S.managed}
			</ManagedNote>
			<KeyValueList
				items={[
					{ label: S.name, value: record.name || '—' },
					{ label: S.email, value: record.email || '—' },
					{ label: S.phone, value: record.phone || '—' },
					{ label: S.address, value: address || '—' },
					{ label: S.timeZone, value: record.timeZone || '—' },
				]}
			/>
		</div>
	);
}

/**
 * The Store details editor. While the Portal holds the website's settings the record is its Business and Brand
 * sections (`portal: true`): a note where it is set and what it says, not a form.
 * @param {{ websiteId: string, off?: boolean, portal?: string }} props `portal`: the Portal's address
 */
export function StoreDetailsEditor({ websiteId, off, portal }) {
	const state = useList(websiteId, 'store_details');
	const files = useLoad(`/v1/dashboard/websites/${websiteId}/store-details/files`);
	return (
		<Card title={S.title} subtitle={off ? TEXTS.settings.off : S.help}>
			<Loaded answer={state.answer}>
				{(data) => {
					const saved = /** @type {Item} */ (data.value ?? {});
					if (saved.portal === true) return <FromPortal record={saved} websiteId={websiteId} portal={portal} />;
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
					const fileViews = /** @type {Record<StoreFileName, Item | null>} */ (files.answer?.ok ? files.answer.data : {});
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
							<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
								{STORE_FILES.map((name) => (
									<FileField
										key={name}
										websiteId={websiteId}
										name={name}
										file={fileViews[name] ?? null}
										onChanged={files.reload}
									/>
								))}
							</div>
							<p className="text-sm font-semibold">{S.contact}</p>
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
							<TextArea
								label={S.phones}
								help={S.phonesHelp}
								rows={2}
								value={draft.phones}
								onChange={(event) => set({ phones: event.target.value })}
							/>
							<p className="text-sm font-semibold">{S.address}</p>
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
							<p className="text-sm font-semibold">{S.hours}</p>
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
