'use client';
/**
 * SchemaForm renders a feature's settings form from its settings schema with the `x-ui` hints: `widget`, `group`
 * (fieldsets), `order`, `help`, `placeholder` (for a list of choices: the text shown while none is chosen),
 * `advanced` (behind a disclosure), `hidden`, `wide` and `labels` (`country`: ISO country codes shown by name). A list
 * of more than 12 choices (or `widget: 'tags'`) is a searchable picker; a shorter one a group of checkboxes; a list
 * without choices is typed one item per line (a list of on/off values as JSON). Each group lays its fields out in the
 * responsive field grid (PLAN 0.6): short controls side by side, long text, lists and `wide` fields across the whole
 * row.
 *
 * It is controlled: `values` holds the value of every setting, `onChange(name, value)` reports edits. Bounds show on
 * the inputs; the product checks every value when it is saved, and its field errors come in `errors`.
 * @module
 */
import { useId, useState } from 'react';
import { Button } from './Button.js';
import { Checkbox, CheckboxGroup, ChoicePicker, FieldGrid, Input, RadioGroup, Select, Switch, TextArea } from './fields.js';
import { cx } from './cx.js';
import { Icon } from './icons.js';
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
		if (widget === 'checkbox')
			return (
				<Checkbox
					id={id}
					label={label}
					checked={value === true}
					disabled={disabled}
					onChange={(e) => onChange(e.currentTarget.checked)}
					help={help}
					error={error}
				/>
			);
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
		if (node.enum && (widget === 'radio' || widget === 'select')) {
			const options = node.enum.map((v) => ({ value: String(v), label: optionLabel(v, node['x-ui']?.labels) }));
			if (widget === 'radio')
				return (
					<RadioGroup
						legend={label}
						options={options}
						value={text}
						onChange={(v) => onChange(v)}
						help={help}
						error={error}
						disabled={disabled}
						inline
					/>
				);
			return (
				<Select {...common} label={label} options={options} value={text} onChange={(e) => onChange(e.currentTarget.value)} />
			);
		}
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
		const type =
			widget === 'color'
				? 'color'
				: widget === 'url'
					? 'url'
					: widget === 'email'
						? 'email'
						: widget === 'password'
							? 'password'
							: 'text';
		return (
			<Input
				{...common}
				label={label}
				type={type}
				value={type === 'color' && !text ? '#000000' : text}
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
 * @param {{ schema: SettingsSchema | null | undefined, values: Record<string, unknown>,
 *   onChange: (name: string, value: unknown) => void, errors?: Record<string, string>,
 *   overridden?: Record<string, boolean>, onReset?: (name: string) => void, disabled?: boolean, idPrefix?: string,
 *   emptyText?: string, className?: string }} props
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
}) {
	const auto = useId();
	const prefix = idPrefix ?? `sf${auto.replace(/[^a-zA-Z0-9_-]/g, '')}`;
	const [showAdvanced, setShowAdvanced] = useState(false);
	const fields = fieldsOf(schema);
	if (fields.length === 0) return <p className="text-sm text-muted">{emptyText}</p>;
	const { groups, advanced } = groupFields(fields);
	const advancedErrors = advanced.some((f) => errors[f.name]);

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
		<div className={cx('space-y-6', className)}>
			{groups.map((group) =>
				groups.length === 1 && advanced.length === 0 ? (
					<FieldGrid key={group.name}>{group.fields.map(renderField)}</FieldGrid>
				) : (
					<fieldset key={group.name} className="min-w-0">
						<legend className="mb-3 text-sm font-bold text-fg">{group.name}</legend>
						<FieldGrid>{group.fields.map(renderField)}</FieldGrid>
					</fieldset>
				),
			)}
			{advanced.length > 0 ? (
				<div className="space-y-4 border-t border-line-soft pt-4">
					<Button
						variant="ghost"
						size="sm"
						aria-expanded={showAdvanced || advancedErrors}
						aria-controls={`${prefix}-advanced`}
						onClick={() => setShowAdvanced((v) => !v)}
						icon={
							<Icon
								name="chevronRight"
								size={14}
								className={cx(
									'transition-transform duration-(--ss-motion) ease-ss',
									(showAdvanced || advancedErrors) && 'rotate-90',
								)}
							/>
						}>
						{`Advanced settings (${advanced.length})`}
					</Button>
					{showAdvanced || advancedErrors ? (
						<div id={`${prefix}-advanced`} className="animate-ss-enter">
							<FieldGrid>{advanced.map(renderField)}</FieldGrid>
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
}
