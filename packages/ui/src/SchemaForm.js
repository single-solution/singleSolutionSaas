'use client';
/**
 * SchemaForm renders a feature's settings form from its settings schema, with the `x-ui` hints: `widget`, `group`
 * (one titled card per group; settings without a group share one card, titled with the feature's `title`), `order`
 * (the settings with one come first, ascending), `placeholder` (for a list of choices: the text shown while none is chosen), `wide`,
 * `labels` (`country`: ISO country codes shown by name; or each choice's own words) and `suggestions` (a text offers
 * them and takes the merchant's own; a list of texts is a picker of them that adds what is typed); a setting's
 * `description` is its help text. A list of more than 12 choices (or `widget: 'tags'`) is a searchable picker; a
 * shorter one a group of checkboxes; a list without choices is typed one item per line (a list of on/off values as
 * JSON). Each card lists its settings as rows (PLAN 0.6, owner 2026-10-16): the label and the muted help on the left,
 * the control on the right; an on/off setting is a toggle, a choice of up to four is a segmented control, a longer one
 * a select; long text and lists take the whole row. Rows stack on a narrow card.
 *
 * With `onSave` it also shows the sticky Save changes bar (with Discard) while `dirty` is true.
 *
 * It is controlled: `values` holds the value of every setting, `onChange(name, value)` reports edits. Bounds show on
 * the inputs; the product checks every value when it is saved, and its field errors come in `errors`.
 * @module
 */
import { useId, useState } from 'react';
import { SaveBar, SettingList, SettingsCard } from './blocks.js';
import {
	CheckboxGroup,
	ChoicePicker,
	Input,
	RadioGroup,
	SegmentedControl,
	Select,
	SuggestInput,
	Switch,
	TextArea,
} from './fields.js';
import { cx } from './cx.js';
import { fieldsOf, groupFields, optionLabel } from './schema.js';

/** @typedef {import('./schema.js').SettingsSchema} SettingsSchema */
/** @typedef {import('./schema.js').SettingNode} SettingNode */
/** @typedef {import('./schema.js').FieldDescriptor} FieldDescriptor */

/**
 * The control of one setting, by its type and widget.
 * @param {{ id: string, label: string, node: SettingNode, widget: string, value: unknown,
 *   onChange: (value: unknown) => void, error: string | undefined, help: string | null, disabled: boolean,
 *   placeholder: string | null, aside: import('react').ReactNode }} props
 */
function NodeControl({ id, label, node, widget, value, onChange, error, help, disabled, placeholder, aside }) {
	const [jsonText, setJsonText] = useState(() => (value === undefined ? '' : JSON.stringify(value, null, 2)));
	const [jsonError, setJsonError] = useState(/** @type {string | null} */ (null));
	const common = { id, error, help, aside, disabled };
	const ph = placeholder ?? undefined;

	if (node.type === 'boolean') {
		return (
			<Switch
				id={id}
				label={label}
				checked={value === true}
				disabled={disabled}
				onChange={(next) => onChange(next)}
				description={help}
				error={error}
				aside={aside}
			/>
		);
	}

	if (node.type === 'integer' || node.type === 'number') {
		return (
			<Input
				{...common}
				label={label}
				type="number"
				inputMode={node.type === 'integer' ? 'numeric' : 'decimal'}
				step={node.type === 'integer' ? 1 : 'any'}
				min={node.minimum}
				max={node.maximum}
				value={typeof value === 'number' ? String(value) : ''}
				placeholder={ph}
				onChange={(e) => {
					const raw = e.currentTarget.value;
					onChange(raw === '' ? undefined : Number(raw));
				}}
			/>
		);
	}

	if (node.type === 'string') {
		const text = typeof value === 'string' ? value : '';
		if (node.enum && (widget === 'segmented' || widget === 'radio' || widget === 'select')) {
			const options = node.enum.map((v) => ({ value: String(v), label: optionLabel(v, node['x-ui']?.labels) }));
			// a few short choices are one segmented control; longer words need the room of a radio list
			if (widget === 'segmented' && options.every((o) => o.label.length <= 16))
				return (
					<SegmentedControl
						legend={label}
						options={options}
						value={text}
						onChange={(v) => onChange(v)}
						help={help}
						error={error}
						disabled={disabled}
					/>
				);
			if (widget === 'segmented' || widget === 'radio')
				return (
					<RadioGroup
						legend={label}
						options={options}
						value={text}
						onChange={(v) => onChange(v)}
						help={help}
						error={error}
						disabled={disabled}
					/>
				);
			return (
				<Select {...common} label={label} options={options} value={text} onChange={(e) => onChange(e.currentTarget.value)} />
			);
		}
		const suggestions = node['x-ui']?.suggestions;
		if (widget === 'suggest' && suggestions)
			return (
				<SuggestInput
					{...common}
					label={label}
					suggestions={suggestions}
					value={text}
					maxLength={node.maxLength}
					placeholder={ph}
					onChange={(e) => onChange(e.currentTarget.value)}
				/>
			);
		if (widget === 'textarea')
			return (
				<TextArea
					{...common}
					label={label}
					value={text}
					maxLength={node.maxLength}
					placeholder={ph}
					onChange={(e) => onChange(e.currentTarget.value)}
					aside={aside ?? (node.maxLength ? `${text.length}/${node.maxLength}` : undefined)}
				/>
			);
		return (
			<Input
				{...common}
				label={label}
				type={widget === 'url' || widget === 'email' ? widget : 'text'}
				value={text}
				maxLength={node.maxLength}
				placeholder={ph}
				autoComplete="off"
				onChange={(e) => onChange(e.currentTarget.value)}
			/>
		);
	}

	if (node.type === 'array') {
		const list = Array.isArray(value) ? value : [];
		const items = node.items;
		if (items?.enum) {
			const labels = node['x-ui']?.labels;
			const options = items.enum.map((v) => ({ value: String(v), label: optionLabel(v, labels) }));
			const shared = {
				legend: label,
				value: list.map(String),
				/** @param {string[]} next */
				onChange: (next) => onChange(items.type === 'integer' || items.type === 'number' ? next.map(Number) : next),
				help,
				error,
				disabled,
			};
			// a long list is searchable; named choices (countries) are listed by name
			return widget === 'tags' ? (
				<ChoicePicker
					{...shared}
					options={labels ? [...options].sort((a, b) => a.label.localeCompare(b.label)) : options}
					{...(ph ? { emptyText: ph } : {})}
				/>
			) : (
				<CheckboxGroup {...shared} options={options} />
			);
		}
		const suggestions = node['x-ui']?.suggestions;
		if (items?.type === 'string' && suggestions)
			return (
				<ChoicePicker
					legend={label}
					options={suggestions.map((v) => ({ value: v, label: v }))}
					value={list.map(String)}
					onChange={(next) => onChange(next)}
					help={help}
					error={error}
					disabled={disabled}
					allowOwn
					{...(ph ? { emptyText: ph } : {})}
				/>
			);
		if (items && (items.type === 'string' || items.type === 'integer' || items.type === 'number')) {
			return (
				<TextArea
					{...common}
					label={label}
					rows={3}
					value={list.join('\n')}
					placeholder={ph ?? 'One per line'}
					aside={aside}
					onChange={(e) => {
						const lines = e.currentTarget.value.split('\n').map((l) => l.trim());
						const kept = lines.filter((l, i) => l !== '' || i === lines.length - 1).filter((l) => l !== '');
						onChange(items.type === 'string' ? kept : kept.map(Number));
					}}
				/>
			);
		}
	}

	// a list of on/off values: JSON
	return (
		<TextArea
			{...common}
			label={label}
			rows={5}
			className="font-mono text-xs"
			value={jsonText}
			error={jsonError ?? error}
			onChange={(e) => {
				const text = e.currentTarget.value;
				setJsonText(text);
				try {
					onChange(JSON.parse(text));
					setJsonError(null);
				} catch {
					setJsonError('Enter valid JSON.');
				}
			}}
		/>
	);
}

/**
 * `overridden` marks settings the website saved itself; with `onReset` they get a Reset link (back to the default).
 * `title` (and `description`) name the feature: with one group it is the card's title, with several it is a heading
 * above the group cards; `before` and `after` are shown above and below the cards. `onSave` shows the Save changes
 * bar while `dirty`.
 * @param {{ schema: SettingsSchema | null | undefined, values: Record<string, unknown>,
 *   onChange: (name: string, value: unknown) => void, errors?: Record<string, string>,
 *   overridden?: Record<string, boolean>, onReset?: (name: string) => void, disabled?: boolean, idPrefix?: string,
 *   emptyText?: string, className?: string, title?: import('react').ReactNode, description?: import('react').ReactNode,
 *   before?: import('react').ReactNode, after?: import('react').ReactNode, dirty?: boolean, saving?: boolean,
 *   onSave?: () => unknown, onDiscard?: () => void,
 *   saveTexts?: { message?: string, save?: string, discard?: string } }} props
 */
export function SchemaForm({
	schema,
	values,
	onChange,
	errors = {},
	overridden = {},
	onReset,
	disabled = false,
	idPrefix,
	emptyText = 'This feature has no settings.',
	className,
	title,
	description,
	before,
	after,
	dirty = false,
	saving = false,
	onSave,
	onDiscard,
	saveTexts = {},
}) {
	const auto = useId();
	const prefix = idPrefix ?? `sf${auto.replace(/[^a-zA-Z0-9_-]/g, '')}`;
	const fields = fieldsOf(schema);
	if (fields.length === 0) return <p className="text-sm text-muted">{emptyText}</p>;
	const groups = groupFields(fields);
	const single = groups.length === 1;

	/** @param {FieldDescriptor} field */
	const renderField = (field) => {
		const aside =
			overridden[field.name] === true && onReset && !disabled ? (
				<button
					type="button"
					onClick={() => onReset(field.name)}
					className="rounded text-xs font-semibold text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-focus">
					Reset
				</button>
			) : undefined;
		return (
			<div key={field.name} data-field={field.name} data-cell="" {...(field.wide ? { 'data-wide': '' } : {})}>
				<NodeControl
					id={`${prefix}-${field.name}`}
					label={field.title}
					node={field.node}
					widget={field.widget}
					value={values[field.name]}
					onChange={(next) => onChange(field.name, next)}
					error={errors[field.name]}
					help={field.help}
					placeholder={field.placeholder}
					disabled={disabled}
					aside={aside}
				/>
			</div>
		);
	};

	return (
		<div className={cx('min-w-0 space-y-4', className)}>
			{before}
			{!single && title ? (
				<div className="min-w-0 px-1">
					<h3 className="text-lead leading-6 font-semibold tracking-tight text-fg">{title}</h3>
					{description ? <p className="mt-0.5 text-sm text-muted">{description}</p> : null}
				</div>
			) : null}
			{groups.map((group, index) => {
				const cardTitle = single ? (title ?? (group.fields[0]?.grouped ? group.name : undefined)) : group.name;
				return (
					<SettingsCard
						key={group.name}
						id={`${prefix}-group-${index}`}
						title={cardTitle}
						{...(single && description ? { description } : {})}>
						<SettingList>{group.fields.map(renderField)}</SettingList>
					</SettingsCard>
				);
			})}
			{after}
			{onSave ? (
				<SaveBar
					show={dirty}
					saving={saving}
					onSave={onSave}
					onDiscard={onDiscard ?? (() => undefined)}
					{...(saveTexts.message ? { message: saveTexts.message } : {})}
					{...(saveTexts.save ? { saveLabel: saveTexts.save } : {})}
					{...(saveTexts.discard ? { discardLabel: saveTexts.discard } : {})}
				/>
			) : null}
		</div>
	);
}
