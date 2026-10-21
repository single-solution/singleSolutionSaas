'use client';
/**
 * Settings → Custom fields (PLAN 0.8.6, A6): the merchant's own profile fields of any type (text, long text, number,
 * date, one or several choices, yes/no, email address, web address), each with a help text and who sees it (the user
 * edits it, the user only sees it, or staff only), in the merchant's order. The fields the user edits are asked at
 * sign-up (required ones must be filled) and shown in My account. They live in the merchant database, so they need it
 * connected, and merchants edit them only while the Custom fields feature is on. The fields are rich rows
 * (`record-section.js`); a click on a row opens its fields in place.
 * @module
 */
import { Checkbox, Input, Select, TextArea } from '@ss/ui';
import { RecordSection } from './record-section.js';
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

/**
 * A field as a row: an icon, its label, a dot while it is required, its type and who sees it, and its key.
 * @param {CustomField} item
 */
const rowOf = (item) => ({
	lead: { icon: /** @type {const} */ ('type'), tone: /** @type {const} */ ('primary') },
	title: item.label,
	...(item.required ? { status: { tone: /** @type {const} */ ('accent'), label: T.required_badge } } : {}),
	meta: [TEXTS.settings.fieldTypes[item.type], TEXTS.settings.fieldVisibility[item.visibility]],
	value: item.key,
});

/** @param {{ websiteId: string }} props */
export function FieldsSection({ websiteId }) {
	return (
		<RecordSection
			base={`/v1/dashboard/websites/${websiteId}/fields`}
			title={TEXTS.settings.fieldsTitle}
			description={TEXTS.settings.fieldsHelp}
			icon="type"
			texts={T}
			blank={EMPTY}
			draftOf={(/** @type {CustomField} */ item) => ({ ...item, options: item.options.join('\n'), isNew: false })}
			bodyOf={(draft) => ({
				label: draft.label.trim(),
				type: draft.type,
				options: CHOICES.includes(draft.type) ? splitOptions(draft.options) : [],
				required: draft.required,
				visibility: draft.visibility,
				help: draft.help.trim(),
			})}
			ready={(draft) => draft.key !== '' && draft.label.trim() !== ''}
			rowOf={rowOf}
			fields={(draft, edit) => (
				<>
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
				</>
			)}
		/>
	);
}
