'use client';
/**
 * Settings → Templates (PLAN 0.8.5): the merchant and our admins write every template per template key, channel and
 * language. Templates live in the merchant database, so they need it connected. A WhatsApp template at Meta lists the
 * buttons that take a value (PLAN 0.8.10 N1). Every message the products send is listed too, with its state (parity
 * P1): the product's default words, the merchant's edited version, switched off, or (WhatsApp) not set up; the
 * merchant edits it, resets it to the default or switches it off on a channel (Accounts' messages are always sent).
 * They are rich rows (icon, name, state dot, a line of facts, the language) with a menu; a row opens in a drawer, whose
 * many fields (words, flags, WhatsApp buttons, a live preview) do not fit in the list; an empty list is an empty state
 * with the one Add action.
 * @module
 */
import { useId, useState } from 'react';
import {
	ActionMenu,
	Button,
	Callout,
	Card,
	Checkbox,
	ConfirmDialog,
	Drawer,
	EmptyState,
	EntryGroup,
	FieldGrid,
	Form,
	Input,
	Row,
	RowListSkeleton,
	Section,
	Select,
	TextArea,
	Toolbar,
	describeProblem,
} from '@ss/ui';
import { LONG_VALUE_LIMIT, VALUE_LIMIT, isTitled } from '@ss/contracts/templates';
import { CHANNELS } from '../../core/channels.js';
import { MAX_BUTTONS, fillText, templateRows, valueNamesOf } from '../../core/templates.js';
import { SaveOutcome, call, fill, useLoad } from '@ss/ui/dashboard';
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
 * The buttons of a WhatsApp template at Meta that take a value, edited in the template's drawer.
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
				<EntryGroup key={at} texts={{ remove: T.removeButton }} onRemove={() => onChange(buttons.filter((_, i) => i !== at))}>
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
				</EntryGroup>
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
 * A live preview of the template's words: a sample for every value it uses (a long value in a larger box), and the
 * subject, message and buttons as a recipient gets them (optional sections shown only with a sample).
 * @param {{ template: Template, longValues: string[] }} props
 */
function TemplatePreview({ template, longValues }) {
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
		<EntryGroup title={T.preview}>
			<p className="text-sm text-muted">{names.length > 0 ? T.previewHelp : T.previewNoValues}</p>
			{names.length > 0 ? (
				<FieldGrid>
					{names.map((name) =>
						longValues.includes(name) ? (
							<TextArea
								key={name}
								label={name}
								value={samples[name] ?? ''}
								maxLength={LONG_VALUE_LIMIT}
								onChange={(event) => setSamples({ ...samples, [name]: event.target.value })}
							/>
						) : (
							<Input
								key={name}
								label={name}
								value={samples[name] ?? ''}
								maxLength={VALUE_LIMIT}
								onChange={(event) => setSamples({ ...samples, [name]: event.target.value })}
							/>
						),
					)}
				</FieldGrid>
			) : null}
			<EntryGroup compact aria-live="polite" className="text-sm text-fg">
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
			</EntryGroup>
		</EntryGroup>
	);
}

/**
 * A draft in the template drawer: `fixed` for a product's message (its key, channel and default language are set),
 * with its name, values and long values; `isNew` until the merchant's version exists.
 * @typedef {Template & { isNew: boolean, fixed: boolean, name?: string, values?: string[], longValues?: string[] }} Draft
 */

/** The state dot of each state of a product's message: sent with the default words, edited, switched off, not set up. */
const STATE_TONES = Object.freeze(
	/** @type {const} */ ({ default: 'success', edited: 'accent', off: 'neutral', not_set_up: 'warning' }),
);

/** The icon of each channel's row. */
const CHANNEL_ICONS = Object.freeze(
	/** @type {Record<string, import('@ss/ui').IconName>} */ ({
		email: 'mail',
		sms: 'message',
		whatsapp: 'message',
		push: 'bell',
		staff_push: 'bell',
	}),
);

/** The filter value of the merchant's own templates (a product's id is the others). */
const OWN = '_own';

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
	const formId = useId();
	// the template in the drawer stays while the drawer closes; `shown` says whether the drawer is open
	const [draft, setDraft] = useState(/** @type {Draft | null} */ (null));
	const [shown, setShown] = useState(false);
	const [saving, setSaving] = useState(false);
	const [result, setResult] = useState(/** @type {import('@ss/ui/dashboard').Answer | null} */ (null));
	const [problem, setProblem] = useState(/** @type {any} */ (null));
	const [search, setSearch] = useState('');
	const [channel, setChannel] = useState('');
	const [product, setProduct] = useState('');
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
		setShown(true);
	};
	const close = () => setShown(false);
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
			...(message ? { name: message.name, values: message.values, longValues: message.longValues ?? [] } : {}),
		});
	};
	const save = async () => {
		if (!draft) return;
		const { isNew: _isNew, fixed: _fixed, name: _name, values: _values, longValues: _longValues, ...template } = draft;
		const atMeta = template.channel === 'whatsapp' && template.providerTemplate.trim() !== '';
		setSaving(true);
		const next = await call('PUT', base, { ...template, buttons: atMeta ? template.buttons : [] });
		setSaving(false);
		if (!next.ok) return setProblem(next);
		setResult(next);
		close();
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
	/** @param {import('../../core/templates.js').TemplateRow} row */
	const editRow = (row) =>
		row.message
			? openRow(row)
			: row.template && open({ ...row.template, buttons: row.template.buttons ?? [], isNew: false, fixed: false });
	/** The row's menu: Edit first (so that every row has one), then what the row can do. @param {import('../../core/templates.js').TemplateRow} row */
	const menuOf = (row) => {
		const edit = { label: row.state === 'not_set_up' ? T.setUp : T.edit, onSelect: () => editRow(row) };
		/** @type {Array<{ label: string, onSelect: () => void, danger?: boolean }>} */
		const more = row.message
			? [
					...(row.template && row.defaults
						? [
								{
									label: T.reset,
									onSelect: () => setDeleting({ key: row.key, channel: row.channel, language: 'default', reset: true }),
								},
							]
						: []),
					...(row.template && !row.defaults
						? [
								{
									label: T.delete,
									danger: true,
									onSelect: () => setDeleting({ key: row.key, channel: row.channel, language: 'default', reset: false }),
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
						onSelect: () => setDeleting({ key: row.key, channel: row.channel, language: row.language, reset: false }),
					},
				];
		return [edit, ...more];
	};
	/**
	 * A message or template as a row: the channel's icon, its name, a dot with the state of a product's message, one line
	 * of facts (channel, product, flags, key and words; the help of a message not set up in place of them) and the language.
	 * @param {import('../../core/templates.js').TemplateRow} row
	 */
	const rowFacts = (row) => {
		const words = wordsOf(row);
		const channelName = TEXTS.settings.channels[/** @type {typeof CHANNELS[number]} */ (row.channel)];
		const preview = words ? words.subject || words.text : '';
		return {
			lead: { icon: CHANNEL_ICONS[row.channel] ?? 'mail', tone: /** @type {const} */ ('primary') },
			title: row.message ? row.message.name : row.key,
			...(row.message
				? {
						status: {
							tone: STATE_TONES[/** @type {keyof typeof STATE_TONES} */ (row.state)],
							label: T.states[/** @type {keyof typeof T.states} */ (row.state)],
						},
					}
				: {}),
			...(words
				? {
						meta: [
							channelName,
							row.message ? productName(row.message.productId) : T.own,
							...(words.required ? [T.required_badge] : []),
							...(words.urgent ? [T.urgent_badge] : []),
							...(words.sensitive ? [T.sensitive_badge] : []),
							...(words.providerTemplate ? [fill(T.atMeta, { name: words.providerTemplate })] : []),
							...(words.buttons?.length ? [fill(T.buttonsCount, { count: words.buttons.length })] : []),
							row.message ? `${row.key} · ${preview}` : preview,
						],
					}
				: { warning: { tone: /** @type {const} */ ('warning'), text: `${channelName} · ${T.notSetUpHelp}` } }),
			value: row.language === 'default' ? T.default : row.language,
		};
	};
	const term = search.trim().toLowerCase();
	const shownRows = rows.filter(
		(row) =>
			(channel === '' || row.channel === channel) &&
			(product === '' || (row.message ? row.message.productId === product : product === OWN)) &&
			(row.key.toLowerCase().includes(term) || (row.message?.name ?? '').toLowerCase().includes(term)),
	);
	const productIds = [...new Set(rows.flatMap((row) => (row.message ? [row.message.productId] : [])))];
	return (
		<Section
			title={TEXTS.settings.templatesTitle}
			description={TEXTS.settings.templatesHelp}
			actions={
				answer?.ok && rows.length === 0 ? null : (
					<Button size="sm" onClick={() => open({ ...EMPTY, isNew: true, fixed: false })}>
						{T.add}
					</Button>
				)
			}>
			{!answer ? (
				<Card padded={false} bodyClassName="p-2">
					<RowListSkeleton rows={4} label={TEXTS.loading} />
				</Card>
			) : !answer.ok ? (
				<Callout tone="info">
					{answer.problem?.type?.endsWith('database_not_connected') ? T.needsDatabase : describeProblem(answer.problem)}
				</Callout>
			) : rows.length === 0 ? (
				<EmptyState
					compact
					icon="mail"
					kind="settings"
					title={T.none}
					action={
						<Button size="sm" onClick={() => open({ ...EMPTY, isNew: true, fixed: false })}>
							{T.add}
						</Button>
					}
				/>
			) : (
				<Card padded={false} className="overflow-hidden">
					<Toolbar
						search={{ onSearch: setSearch, value: search, label: T.search, placeholder: T.search, delay: 0 }}
						filters={[
							{
								id: 'channel',
								label: T.channel,
								allLabel: fill(T.allChannels, { count: rows.length }),
								value: channel,
								onChange: setChannel,
								options: CHANNELS.map((value) => ({
									value,
									label: fill(T.channelCount, {
										channel: TEXTS.settings.channels[value],
										count: rows.filter((row) => row.channel === value).length,
									}),
								})),
							},
							{
								id: 'product',
								label: T.columns.product,
								value: product,
								onChange: setProduct,
								options: [
									...productIds.map((value) => ({ value, label: productName(value) })),
									...(rows.some((row) => !row.message) ? [{ value: OWN, label: T.own }] : []),
								],
							},
						]}
					/>
					<div className="ss-scroll max-h-[36rem] overflow-y-auto p-2">
						{shownRows.length === 0 ? (
							<EmptyState compact title={T.noMatch} />
						) : (
							shownRows.map((row) => {
								const look = rowFacts(row);
								return (
									<Row
										key={`${row.key}|${row.channel}|${row.language}`}
										{...look}
										onSelect={() => editRow(row)}
										trailing={
											<ActionMenu floating label={fill(TEXTS.rowActions, { name: look.title })} items={menuOf(row)} />
										}
									/>
								);
							})
						)}
					</div>
				</Card>
			)}
			{unavailable.length > 0 ? (
				<Callout tone="info">
					{fill(T.unavailable, { products: unavailable.map((id) => productName(id)).join(', ') })}
				</Callout>
			) : null}
			<SaveOutcome result={result} />
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
			<Drawer
				open={shown}
				onClose={close}
				size="lg"
				title={title}
				closeLabel={TEXTS.cancel}
				footer={
					<>
						<Button variant="secondary" onClick={close}>
							{TEXTS.cancel}
						</Button>
						<Button type="submit" form={formId} loading={saving} disabled={!draft}>
							{TEXTS.save}
						</Button>
					</>
				}>
				{draft ? (
					<Form id={formId} onSubmit={save} aria-label={title}>
						{draft.fixed ? (
							<p className="text-sm text-muted">
								{fill(T.fixed, {
									key: draft.key,
									channel: TEXTS.settings.channels[/** @type {typeof CHANNELS[number]} */ (draft.channel)],
								})}
								{draft.values?.length
									? ` ${fill(T.valuesHelp, { values: draft.values.map((v) => `{${v}}`).join(', ') })}`
									: ''}
								{draft.longValues?.length
									? ` ${fill(T.longValuesHelp, { values: draft.longValues.map((v) => `{${v}}`).join(', ') })}`
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
						<TemplatePreview template={draft} longValues={draft.longValues ?? []} />
						<SaveOutcome result={problem} />
					</Form>
				) : null}
			</Drawer>
		</Section>
	);
}
