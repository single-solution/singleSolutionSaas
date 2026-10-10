'use client';
/**
 * Settings → Templates (PLAN 0.8.5): the merchant and our admins write every template per template key, channel and
 * language. Templates live in the merchant database, so they need it connected. A WhatsApp template at Meta lists the
 * buttons that take a value (PLAN 0.8.10 N1).
 * @module
 */
import { useState } from 'react';
import {
	ActionMenu,
	Badge,
	Button,
	Callout,
	Card,
	Checkbox,
	ConfirmDialog,
	Dialog,
	EmptyState,
	FieldGrid,
	Form,
	Input,
	Section,
	Select,
	Skeleton,
	TextArea,
	describeProblem,
} from '@ss/ui';
import { fillText, valueNamesOf } from '../../core/templates.js';
import { call, fill, useLoad } from './api.js';
import { TEXTS } from './texts.js';

/** @typedef {{ index: number, type: string, value: string }} TemplateButton */
/**
 * @typedef {{ key: string, channel: string, language: string, subject: string, text: string, required: boolean,
 *   urgent: boolean, providerTemplate: string, buttons: TemplateButton[] }} Template
 */

const CHANNELS = /** @type {const} */ (['email', 'sms', 'whatsapp', 'push', 'staff_push']);
/** @type {Template} */
const EMPTY = {
	key: '',
	channel: 'email',
	language: 'default',
	subject: '',
	text: '',
	required: false,
	urgent: false,
	providerTemplate: '',
	buttons: [],
};
const T = TEXTS.settings.template;
/** Most buttons a template at Meta has. */
const MAX_BUTTONS = 10;

/**
 * The buttons of a WhatsApp template at Meta that take a value, edited in the template's dialog.
 * @param {{ buttons: TemplateButton[], onChange: (buttons: TemplateButton[]) => void }} props
 */
function ButtonsEditor({ buttons, onChange }) {
	/** @param {number} at @param {Partial<TemplateButton>} patch */
	const set = (at, patch) => onChange(buttons.map((button, i) => (i === at ? { ...button, ...patch } : button)));
	const free = Array.from({ length: MAX_BUTTONS }, (_, index) => index).find(
		(index) => !buttons.some((button) => button.index === index),
	);
	return (
		<div className="space-y-3">
			<div>
				<p className="text-sm font-semibold text-fg">{T.buttons}</p>
				<p className="text-sm text-muted">{T.buttonsHelp}</p>
			</div>
			{buttons.map((button, at) => (
				<div key={at} className="space-y-3 rounded-2xl bg-surface-2 p-4">
					<FieldGrid>
						<Input
							label={T.buttonIndex}
							type="number"
							min={0}
							max={MAX_BUTTONS - 1}
							value={String(button.index)}
							onChange={(event) => set(at, { index: Number(event.target.value) })}
						/>
						<Select
							label={T.buttonType}
							value={button.type}
							options={[
								{ value: 'copy_code', label: T.buttonTypes.copy_code },
								{ value: 'url', label: T.buttonTypes.url },
							]}
							onChange={(event) => set(at, { type: event.target.value })}
						/>
						<Input
							label={T.buttonValue}
							value={button.value}
							maxLength={2000}
							onChange={(event) => set(at, { value: event.target.value })}
						/>
					</FieldGrid>
					<Button size="sm" variant="ghost" onClick={() => onChange(buttons.filter((_, i) => i !== at))}>
						{T.removeButton}
					</Button>
				</div>
			))}
			<Button
				size="sm"
				variant="secondary"
				disabled={free === undefined}
				onClick={() => onChange([...buttons, { index: free ?? 0, type: 'copy_code', value: '' }])}>
				{T.addButton}
			</Button>
		</div>
	);
}

/**
 * A live preview of the template's words: a sample for every value it uses, and the subject, message and buttons as a
 * recipient gets them (optional sections shown only with a sample).
 * @param {{ template: Template }} props
 */
function TemplatePreview({ template }) {
	const [samples, setSamples] = useState(/** @type {Record<string, string>} */ ({}));
	const titled = template.channel === 'email' || template.channel === 'push' || template.channel === 'staff_push';
	const buttons = template.channel === 'whatsapp' && template.providerTemplate.trim() !== '' ? template.buttons : [];
	const names = valueNamesOf(
		[titled ? template.subject : '', template.text, ...buttons.map((button) => button.value)].join('\n'),
	).filter((name) => name !== 'unsubscribeUrl');
	// a value without a sample stays as written
	const values = {
		...Object.fromEntries(Object.entries(samples).filter(([, value]) => value !== '')),
		unsubscribeUrl: T.sampleUnsubscribe,
	};
	return (
		<div className="space-y-3 rounded-2xl bg-surface-2 p-4">
			<div>
				<p className="text-sm font-semibold text-fg">{T.preview}</p>
				<p className="text-sm text-muted">{names.length > 0 ? T.previewHelp : T.previewNoValues}</p>
			</div>
			{names.length > 0 ? (
				<FieldGrid>
					{names.map((name) => (
						<Input
							key={name}
							label={name}
							value={samples[name] ?? ''}
							maxLength={1000}
							onChange={(event) => setSamples({ ...samples, [name]: event.target.value })}
						/>
					))}
				</FieldGrid>
			) : null}
			<div className="space-y-2 rounded-xl bg-surface p-3 text-sm text-fg" aria-live="polite">
				{titled ? <p className="font-semibold break-words">{fillText(template.subject, values)}</p> : null}
				<p className="whitespace-pre-wrap break-words">{fillText(template.text, values)}</p>
				{buttons.map((button) => (
					<p key={button.index} className="text-muted break-words">
						{fill(T.previewButton, {
							index: button.index,
							type: T.buttonTypes[/** @type {'url' | 'copy_code'} */ (button.type)] ?? button.type,
							value: fillText(button.value, values),
						})}
					</p>
				))}
			</div>
		</div>
	);
}

/** @param {{ websiteId: string }} props */
export function TemplatesSection({ websiteId }) {
	const base = `/v1/dashboard/websites/${websiteId}/templates`;
	const { answer, reload } = useLoad(base);
	const [draft, setDraft] = useState(/** @type {(Template & { isNew: boolean }) | null} */ (null));
	const [result, setResult] = useState(/** @type {import('./api.js').Answer | null} */ (null));
	const [problem, setProblem] = useState(/** @type {any} */ (null));
	const [search, setSearch] = useState('');
	const [channel, setChannel] = useState('');
	const [deleting, setDeleting] = useState(/** @type {Template | null} */ (null));
	/** @param {Template} item */
	const remove = async (item) => {
		setResult(await call('DELETE', `${base}/${encodeURIComponent(item.key)}/${item.channel}/${item.language}`));
		setDeleting(null);
		reload();
	};
	/** @param {Partial<Template>} patch */
	const edit = (patch) => setDraft({ .../** @type {Template & { isNew: boolean }} */ (draft), ...patch });
	/** @param {Template & { isNew: boolean }} next */
	const open = (next) => {
		setProblem(null);
		setDraft(next);
	};
	const save = async () => {
		if (!draft) return;
		const { isNew: _isNew, ...template } = draft;
		const atMeta = template.channel === 'whatsapp' && template.providerTemplate.trim() !== '';
		const next = await call('PUT', base, { ...template, buttons: atMeta ? template.buttons : [] });
		if (!next.ok) return setProblem(next.problem);
		setResult(next);
		setDraft(null);
		reload();
	};
	const title = draft?.isNew === false ? T.editTitle : T.add;
	return (
		<Section
			title={TEXTS.settings.templatesTitle}
			description={TEXTS.settings.templatesHelp}
			actions={
				<Button size="sm" onClick={() => open({ ...EMPTY, isNew: true })}>
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
				<EmptyState compact icon="mail" kind="settings" title={T.none} />
			) : (
				<Card>
					<FieldGrid className="mb-4">
						<Input label={T.search} type="search" value={search} onChange={(event) => setSearch(event.target.value)} />
						<Select
							label={T.channel}
							value={channel}
							options={[
								{ value: '', label: fill(T.allChannels, { count: answer.data.items.length }) },
								...CHANNELS.map((value) => ({
									value,
									label: fill(T.channelCount, {
										channel: TEXTS.settings.channels[value],
										count: answer.data.items.filter((/** @type {Template} */ item) => item.channel === value).length,
									}),
								})),
							]}
							onChange={(event) => setChannel(event.target.value)}
						/>
					</FieldGrid>
					{(() => {
						const shown = answer.data.items.filter(
							(/** @type {Template} */ item) =>
								(channel === '' || item.channel === channel) &&
								item.key.toLowerCase().includes(search.trim().toLowerCase()),
						);
						return shown.length === 0 ? (
							<p className="text-sm text-muted">{T.noMatch}</p>
						) : (
							<ul className="divide-y divide-line-soft">
								{shown.map((/** @type {Template} */ item) => (
									<li
										key={`${item.key}|${item.channel}|${item.language}`}
										className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3 first:pt-0 last:pb-0">
										<span className="min-w-0 flex-[1_1_12rem]">
											<span className="block break-words text-sm font-semibold text-fg">{item.key}</span>
											<span className="block truncate text-xs text-muted" title={item.text}>
												{item.subject || item.text}
											</span>
										</span>
										<span className="flex flex-wrap gap-1.5">
											<Badge kind="settings">
												{TEXTS.settings.channels[/** @type {typeof CHANNELS[number]} */ (item.channel)]}
											</Badge>
											<Badge>{item.language === 'default' ? T.default : item.language}</Badge>
											{item.required ? <Badge>{T.required_badge}</Badge> : null}
											{item.urgent ? <Badge>{T.urgent_badge}</Badge> : null}
											{item.providerTemplate ? <Badge>{fill(T.atMeta, { name: item.providerTemplate })}</Badge> : null}
											{item.buttons?.length ? (
												<Badge>{fill(T.buttonsCount, { count: item.buttons.length })}</Badge>
											) : null}
										</span>
										<span className="flex flex-wrap items-center gap-2">
											<Button
												size="sm"
												variant="secondary"
												onClick={() => open({ ...item, buttons: item.buttons ?? [], isNew: false })}>
												{T.edit}
											</Button>
											<ActionMenu
												size="sm"
												label={fill(T.more, { key: item.key })}
												items={[
													{
														label: T.duplicate,
														onSelect: () =>
															open({
																...item,
																buttons: item.buttons ?? [],
																language: 'default',
																isNew: true,
															}),
													},
													{ label: T.delete, danger: true, onSelect: () => setDeleting(item) },
												]}
											/>
										</span>
									</li>
								))}
							</ul>
						);
					})()}
				</Card>
			)}
			{result ? (
				result.ok ? (
					<Callout tone="success">{TEXTS.saved}</Callout>
				) : (
					<Callout tone="danger">{describeProblem(result.problem)}</Callout>
				)
			) : null}
			<ConfirmDialog
				open={deleting !== null}
				danger
				title={T.deleteTitle}
				confirmLabel={T.delete}
				cancelLabel={TEXTS.cancel}
				onClose={() => setDeleting(null)}
				onConfirm={() => void (deleting && remove(deleting))}>
				{deleting
					? fill(T.deleteText, {
							key: deleting.key,
							channel: TEXTS.settings.channels[/** @type {typeof CHANNELS[number]} */ (deleting.channel)],
							language: deleting.language === 'default' ? T.default : deleting.language,
						})
					: null}
			</ConfirmDialog>
			<Dialog open={draft !== null} onClose={() => setDraft(null)} title={title} size="lg">
				{draft ? (
					<Form onSubmit={save} aria-label={title}>
						<Input label={T.key} value={draft.key} maxLength={64} onChange={(event) => edit({ key: event.target.value })} />
						<Select
							label={T.channel}
							value={draft.channel}
							options={CHANNELS.map((value) => ({ value, label: TEXTS.settings.channels[value] }))}
							onChange={(event) => edit({ channel: event.target.value })}
						/>
						<Input
							label={T.language}
							value={draft.language === 'default' ? '' : draft.language}
							maxLength={20}
							onChange={(event) => edit({ language: event.target.value.trim() || 'default' })}
						/>
						{draft.channel === 'whatsapp' ? (
							<Input
								label={T.providerTemplate}
								value={draft.providerTemplate}
								onChange={(event) => edit({ providerTemplate: event.target.value })}
							/>
						) : null}
						{draft.channel === 'whatsapp' && draft.providerTemplate.trim() !== '' ? (
							<ButtonsEditor buttons={draft.buttons} onChange={(buttons) => edit({ buttons })} />
						) : null}
						{draft.channel === 'sms' || draft.channel === 'whatsapp' ? null : (
							<Input
								wide
								label={T.subject}
								value={draft.subject}
								maxLength={200}
								onChange={(event) => edit({ subject: event.target.value })}
							/>
						)}
						<TextArea label={T.text} rows={6} value={draft.text} onChange={(event) => edit({ text: event.target.value })} />
						<Checkbox
							wide
							label={T.required}
							checked={draft.required}
							onChange={(event) => edit({ required: event.target.checked })}
						/>
						<Checkbox
							wide
							label={T.urgent}
							checked={draft.urgent}
							onChange={(event) => edit({ urgent: event.target.checked })}
						/>
						<TemplatePreview template={draft} />
						{problem ? <Callout tone="danger">{describeProblem(problem)}</Callout> : null}
						<div className="flex flex-wrap gap-2">
							<Button type="submit">{TEXTS.save}</Button>
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
