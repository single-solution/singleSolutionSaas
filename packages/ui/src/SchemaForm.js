'use client';
/**
 * SchemaForm renders a feature's settings form from its settings schema with the `x-ui` hints: `widget`, `group`
 * (fieldsets), `order`, `help`, `placeholder`, `advanced` (behind a disclosure), `hidden` and `wide`. Each group lays
 * its fields out in the responsive field grid (PLAN 0.6): short controls side by side, long text, JSON, lists and
 * `wide` fields across the whole row.
 *
 * It is controlled: `values` holds the value of every setting, `onChange(name, value)` reports edits.
 * Validation messages come from `errors` (client-side `validateValues` and/or server field errors).
 * @module
 */
import { useId, useState } from 'react';
import { Button } from './Button.js';
import { Checkbox, CheckboxGroup, FieldGrid, Input, LABEL_CLASS, RadioGroup, Select, Switch, TextArea } from './fields.js';
import { cx } from './cx.js';
import { Icon } from './icons.js';
import { fieldsOf, groupFields, validateValue, widgetOf } from './schema.js';

/** @typedef {import('./schema.js').SettingsSchema} SettingsSchema */
/** @typedef {import('./schema.js').SettingNode} SettingNode */
/** @typedef {import('./schema.js').FieldDescriptor} FieldDescriptor */

/**
 * Generic value control for a node (recursive for objects).
 * @param {{ id: string, label: string, node: SettingNode, value: unknown, onChange: (value: unknown) => void,
 *   error?: string | undefined, help?: import('react').ReactNode, disabled?: boolean, widget?: string,
 *   placeholder?: string | null, aside?: import('react').ReactNode, max?: number | undefined,
 *   maxLength?: number | undefined, maxItems?: number | undefined }} props
 */
function NodeControl({
	id,
	label,
	node,
	value,
	onChange,
	error,
	help,
	disabled = false,
	widget = widgetOf(node),
	placeholder,
	aside,
	max,
	maxLength,
	maxItems,
}) {
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
				step={node.multipleOf ?? (node.type === 'integer' ? 1 : 'any')}
				min={node.minimum}
				max={max}
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
			const options = node.enum.map((v) => ({ value: String(v), label: String(v) }));
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
					maxLength={maxLength}
					placeholder={ph}
					onChange={(e) => onChange(e.currentTarget.value)}
					aside={aside ?? (maxLength ? `${text.length}/${maxLength}` : undefined)}
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
				maxLength={maxLength}
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
			return (
				<CheckboxGroup
					legend={label}
					options={items.enum.map((v) => ({ value: String(v), label: String(v) }))}
					value={list.map(String)}
					onChange={(next) => onChange(items.type === 'integer' || items.type === 'number' ? next.map(Number) : next)}
					help={help}
					error={error}
					disabled={disabled}
					{...(maxItems === undefined ? {} : { max: maxItems })}
				/>
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
					aside={aside ?? (maxItems ? `${list.length}/${maxItems}` : undefined)}
					onChange={(e) => {
						const lines = e.currentTarget.value.split('\n').map((l) => l.trim());
						const kept = lines.filter((l, i) => l !== '' || i === lines.length - 1).filter((l) => l !== '');
						onChange(items.type === 'string' ? kept : kept.map(Number));
					}}
				/>
			);
		}
	}

	if (node.type === 'object' && widget !== 'json' && node.properties) {
		const record =
			value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {};
		return (
			<fieldset className="space-y-3 rounded-2xl bg-surface-2/60 p-4" disabled={disabled}>
				<legend className={cx(LABEL_CLASS, 'px-1')}>
					{label}
					{aside ? <span className="ml-2 normal-case tracking-normal">{aside}</span> : null}
				</legend>
				{help ? <p className="text-xs text-muted">{help}</p> : null}
				{Object.entries(node.properties).map(([key, child]) => (
					<NodeControl
						key={key}
						id={`${id}-${key}`}
						label={child.title ?? key}
						node={child}
						value={record[key]}
						disabled={disabled}
						max={child.maximum}
						maxLength={child.maxLength}
						maxItems={child.maxItems}
						help={child['x-ui']?.help ?? child.description}
						error={
							record[key] === undefined ? undefined : (validateValue(child, record[key], { required: false }) ?? undefined)
						}
						onChange={(next) => {
							const { [key]: _old, ...rest } = record;
							onChange(next === undefined ? rest : { ...rest, [key]: next });
						}}
					/>
				))}
				{error ? (
					<p role="alert" className="text-xs font-medium text-danger">
						{error}
					</p>
				) : null}
			</fieldset>
		);
	}

	// JSON fallback (objects with widget json, arrays of objects)
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
					disabled={disabled || field.node.readOnly === true}
					aside={aside}
					max={field.bounds.max}
					maxLength={field.bounds.maxLength}
					maxItems={field.bounds.maxItems}
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
