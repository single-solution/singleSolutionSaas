'use client';
/**
 * Settings → Templates (PLAN 0.8.5): the merchant and our admins write every template per template key, channel and
 * language. Templates live in the merchant database, so they need it connected. A WhatsApp template at Meta lists the
 * buttons that take a value (PLAN 0.8.10 N1). Every message the products send is listed too, with its state (parity
 * P1): the product's default words, the merchant's edited version, switched off, or (WhatsApp) not set up; the
 * merchant edits it, resets it to the default or switches it off on a channel (Accounts' messages are always sent).
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
import { isTitled } from '@ss/contracts/templates';
import { CHANNELS } from '../../core/channels.js';
import { MAX_BUTTONS, fillText, templateRows, valueNamesOf } from '../../core/templates.js';
import { call, fill, useLoad } from './api.js';
import { TEXTS } from './texts.js';

/** @typedef {{ index: number, type: string, value: string }} TemplateButton */
/**
 * @typedef {{ key: string, channel: string, language: string, subject: string, text: string, required: boolean,
 *   urgent: boolean, sensitive: boolean, providerTemplate: string, buttons: TemplateButton[] }} Template
 */

/** @type {Template} */
const EMPTY = {
	key: '',
	channel: 'email',
	language: 'default',
	subject: '',
	text: '',
	required: false,
	urgent: false,
	sensitive: false,
	providerTemplate: '',
	buttons: [],
};
const T = TEXTS.settings.template;

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
				<div key={at} className="space-y-3 rounded-xl bg-surface-2 p-4">
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
	const titled = isTitled(template.channel);
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
		<div className="space-y-3 rounded-xl bg-surface-2 p-4">
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

/**
 * A draft in the template dialog: `fixed` for a product's message (its key, channel and default language are set),
 * with its name and values; `isNew` until the merchant's version exists.
 * @typedef {Template & { isNew: boolean, fixed: boolean, name?: string, values?: string[] }} Draft
 */

/** Badge tone of each state of a product's message. */
const STATE_TONES = Object.freeze({ default: 'neutral', edited: 'info', off: 'neutral', not_set_up: 'warning' });

/**
 * The words of a row as a list shows them: the merchant's version, else the product's default.
 * @param {import('../../core/templates.js').TemplateRow} row
 */
const wordsOf = (row) => row.template ?? row.defaults;

/** @param {{ websiteId: string }} props */
export function TemplatesSection({ websiteId }) {
	const base = `/v1/dashboard/websites/${websiteId}/templates`;
	const messagesBase = `/v1/dashboard/websites/${websiteId}/messages`;
	const { answer, reload } = useLoad(base);
	const { answer: catalog, reload: reloadCatalog } = useLoad(messagesBase);
	const [draft, setDraft] = useState(/** @type {Draft | null} */ (null));
	const [result, setResult] = useState(/** @type {import('./api.js').Answer | null} */ (null));
	const [problem, setProblem] = useState(/** @type {any} */ (null));
	const [search, setSearch] = useState('');
	const [channel, setChannel] = useState('');
	const [deleting, setDeleting] = useState(
		/** @type {{ key: string, channel: string, language: string, reset: boolean } | null} */ (null),
	);
	const refresh = () => {
		reload();
		reloadCatalog();
	};
	/** @param {{ key: string, channel: string, language: string }} item */
	const remove = async (item) => {
		setResult(await call('DELETE', `${base}/${encodeURIComponent(item.key)}/${item.channel}/${item.language}`));
		setDeleting(null);
		refresh();
	};
	/** @param {import('../../core/templates.js').TemplateRow} row @param {boolean} off */
	const switchRow = async (row, off) => {
		setResult(await call('PUT', `${messagesBase}/${encodeURIComponent(row.key)}/${row.channel}`, { off }));
		refresh();
	};
	/** @param {Partial<Template>} patch */
	const edit = (patch) => setDraft({ .../** @type {Draft} */ (draft), ...patch });
	/** @param {Draft} next */
	const open = (next) => {
		setProblem(null);
		setDraft(next);
	};
	/**
	 * Open a product's message: the merchant's version, else the product's default words to start from (WhatsApp: an
	 * empty template to set up with its name at Meta).
	 * @param {import('../../core/templates.js').TemplateRow} row
	 */
	const openRow = (row) => {
		const words = wordsOf(row);
		const message = row.message;
		open({
			...EMPTY,
			key: row.key,
			channel: row.channel,
			language: 'default',
			subject: words?.subject ?? '',
			text: words?.text ?? '',
			required: words?.required ?? message?.required === true,
			urgent: words?.urgent ?? message?.urgent === true,
			sensitive: words?.sensitive ?? message?.sensitive === true,
			providerTemplate: words?.providerTemplate ?? '',
			buttons: words?.buttons ?? [],
			isNew: row.template === null,
			fixed: true,
			...(message ? { name: message.name, values: message.values } : {}),
		});
	};
	const save = async () => {
		if (!draft) return;
		const { isNew: _isNew, fixed: _fixed, name: _name, values: _values, ...template } = draft;
		const atMeta = template.channel === 'whatsapp' && template.providerTemplate.trim() !== '';
		const next = await call('PUT', base, { ...template, buttons: atMeta ? template.buttons : [] });
		if (!next.ok) return setProblem(next.problem);
		setResult(next);
		setDraft(null);
		refresh();
	};
	const title = draft?.fixed ? (draft.name ?? draft.key) : draft?.isNew === false ? T.editTitle : T.add;
	const rows = answer?.ok
		? templateRows({
				messages: catalog?.ok ? catalog.data.items : [],
				templates: answer.data.items,
				off: catalog?.ok ? catalog.data.off : [],
			})
		: [];
	/** The other products' names, from the Portal's directory. @type {Map<string, string>} */
	const names = new Map(
		(catalog?.ok ? /** @type {Array<{ productId: string, name: string }>} */ (catalog.data.products) : []).map((p) => [
			p.productId,
			p.name,
		]),
	);
	/** @param {string} id */
	const productName = (id) => names.get(id) ?? id;
	const unavailable = catalog?.ok ? /** @type {string[]} */ (catalog.data.unavailable) : [];
	return (
		<Section
			title={TEXTS.settings.templatesTitle}
			description={TEXTS.settings.templatesHelp}
			actions={
				<Button size="sm" onClick={() => open({ ...EMPTY, isNew: true, fixed: false })}>
					{T.add}
				</Button>
			}>
			{!answer ? (
				<Skeleton lines={2} label={TEXTS.loading} />
			) : !answer.ok ? (
				<Callout tone="info">
					{answer.problem?.type?.endsWith('database_not_connected') ? T.needsDatabase : describeProblem(answer.problem)}
				</Callout>
			) : rows.length === 0 ? (
				<EmptyState compact icon="mail" kind="settings" title={T.none} />
			) : (
				<Card>
					<FieldGrid className="mb-4">
						<Input label={T.search} type="search" value={search} onChange={(event) => setSearch(event.target.value)} />
						<Select
							label={T.channel}
							value={channel}
							options={[
								{ value: '', label: fill(T.allChannels, { count: rows.length }) },
								...CHANNELS.map((value) => ({
									value,
									label: fill(T.channelCount, {
										channel: TEXTS.settings.channels[value],
										count: rows.filter((row) => row.channel === value).length,
									}),
								})),
							]}
							onChange={(event) => setChannel(event.target.value)}
						/>
					</FieldGrid>
					{(() => {
						const term = search.trim().toLowerCase();
						const shown = rows.filter(
							(row) =>
								(channel === '' || row.channel === channel) &&
								(row.key.toLowerCase().includes(term) || (row.message?.name ?? '').toLowerCase().includes(term)),
						);
						return shown.length === 0 ? (
							<p className="text-sm text-muted">{T.noMatch}</p>
						) : (
							<ul className="divide-y divide-line-soft">
								{shown.map((row) => {
									const words = wordsOf(row);
									const preview = words ? words.subject || words.text : T.notSetUpHelp;
									const product = row.message;
									/** @type {Array<{ label: string, onSelect: () => void, danger?: boolean }>} */
									const more = product
										? [
												...(row.template && row.defaults
													? [
															{
																label: T.reset,
																onSelect: () =>
																	setDeleting({
																		key: row.key,
																		channel: row.channel,
																		language: 'default',
																		reset: true,
																	}),
															},
														]
													: []),
												...(row.template && !row.defaults
													? [
															{
																label: T.delete,
																danger: true,
																onSelect: () =>
																	setDeleting({
																		key: row.key,
																		channel: row.channel,
																		language: 'default',
																		reset: false,
																	}),
															},
														]
													: []),
												...(row.switchable
													? [
															row.state === 'off'
																? { label: T.switchOn, onSelect: () => void switchRow(row, false) }
																: { label: T.switchOff, onSelect: () => void switchRow(row, true) },
														]
													: []),
											]
										: [
												{
													label: T.duplicate,
													onSelect: () =>
														row.template &&
														open({
															...row.template,
															buttons: row.template.buttons ?? [],
															language: 'default',
															isNew: true,
															fixed: false,
														}),
												},
												{
													label: T.delete,
													danger: true,
													onSelect: () =>
														setDeleting({
															key: row.key,
															channel: row.channel,
															language: row.language,
															reset: false,
														}),
												},
											];
									return (
										<li
											key={`${row.key}|${row.channel}|${row.language}`}
											className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3 first:pt-0 last:pb-0">
											<span className="min-w-0 flex-[1_1_12rem]">
												<span className="block break-words text-sm font-semibold text-fg">
													{product ? product.name : row.key}
												</span>
												<span className="block truncate text-xs text-muted" title={words?.text ?? ''}>
													{product ? `${row.key} · ${preview}` : preview}
												</span>
											</span>
											<span className="flex flex-wrap gap-1.5">
												<Badge kind="settings">
													{TEXTS.settings.channels[/** @type {typeof CHANNELS[number]} */ (row.channel)]}
												</Badge>
												{product ? (
													<>
														<Badge>{productName(product.productId)}</Badge>
														<Badge tone={STATE_TONES[/** @type {keyof typeof STATE_TONES} */ (row.state)]}>
															{T.states[/** @type {keyof typeof T.states} */ (row.state)]}
														</Badge>
													</>
												) : (
													<Badge>{row.language === 'default' ? T.default : row.language}</Badge>
												)}
												{words?.required ? <Badge>{T.required_badge}</Badge> : null}
												{words?.urgent ? <Badge>{T.urgent_badge}</Badge> : null}
												{words?.sensitive ? <Badge>{T.sensitive_badge}</Badge> : null}
												{words?.providerTemplate ? (
													<Badge>{fill(T.atMeta, { name: words.providerTemplate })}</Badge>
												) : null}
												{words?.buttons?.length ? (
													<Badge>{fill(T.buttonsCount, { count: words.buttons.length })}</Badge>
												) : null}
											</span>
											<span className="flex flex-wrap items-center gap-2">
												<Button
													size="sm"
													variant="secondary"
													onClick={() =>
														product
															? openRow(row)
															: row.template &&
																open({
																	...row.template,
																	buttons: row.template.buttons ?? [],
																	isNew: false,
																	fixed: false,
																})
													}>
													{row.state === 'not_set_up' ? T.setUp : T.edit}
												</Button>
												{more.length > 0 ? (
													<ActionMenu size="sm" label={fill(T.more, { key: row.key })} items={more} />
												) : null}
											</span>
										</li>
									);
								})}
							</ul>
						);
					})()}
				</Card>
			)}
			{unavailable.length > 0 ? (
				<Callout tone="info">
					{fill(T.unavailable, { products: unavailable.map((id) => productName(id)).join(', ') })}
				</Callout>
			) : null}
			{result ? (
				result.ok ? (
					<Callout tone="success">{TEXTS.saved}</Callout>
				) : (
					<Callout tone="danger">{describeProblem(result.problem)}</Callout>
				)
			) : null}
			<ConfirmDialog
				open={deleting !== null}
				danger={deleting?.reset !== true}
				title={deleting?.reset ? T.resetTitle : T.deleteTitle}
				confirmLabel={deleting?.reset ? T.reset : T.delete}
				cancelLabel={TEXTS.cancel}
				onClose={() => setDeleting(null)}
				onConfirm={() => void (deleting && remove(deleting))}>
				{deleting
					? fill(deleting.reset ? T.resetText : T.deleteText, {
							key: deleting.key,
							channel: TEXTS.settings.channels[/** @type {typeof CHANNELS[number]} */ (deleting.channel)],
							language: deleting.language === 'default' ? T.default : deleting.language,
						})
					: null}
			</ConfirmDialog>
			<Dialog open={draft !== null} onClose={() => setDraft(null)} title={title} size="lg">
				{draft ? (
					<Form onSubmit={save} aria-label={title}>
						{draft.fixed ? (
							<p className="text-sm text-muted">
								{fill(T.fixed, {
									key: draft.key,
									channel: TEXTS.settings.channels[/** @type {typeof CHANNELS[number]} */ (draft.channel)],
								})}
								{draft.values?.length
									? ` ${fill(T.valuesHelp, { values: draft.values.map((v) => `{${v}}`).join(', ') })}`
									: ''}
							</p>
						) : (
							<>
								<Input
									label={T.key}
									value={draft.key}
									maxLength={64}
									onChange={(event) => edit({ key: event.target.value })}
								/>
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
							</>
						)}
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
						<Checkbox
							wide
							label={T.sensitive}
							checked={draft.sensitive}
							onChange={(event) => edit({ sensitive: event.target.checked })}
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
