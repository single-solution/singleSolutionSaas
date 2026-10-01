'use client';
/**
 * SchemaForm renders an element's configuration form from its feature JSON Schema (the `@ss/contracts` subset)
 * with our `x-ui` hints: `widget`, `group` (fieldsets), `order`, `help`, `placeholder`, `advanced` (behind a
 * disclosure) and `hidden`. It shows plan bounds (`x-plan[plan].max` → "Plan max") and locked features as read-only
 * with a lock icon and who set them ("Set by platform/admin").
 *
 * It is controlled: `values` holds the value of every top-level feature, `onChange(name, value)` reports edits.
 * Validation messages come from `errors` (client-side `validateValues` and/or server field errors).
 * @module
 */
import { useId, useState } from 'react';
import { Button } from './Button.js';
import { Checkbox, CheckboxGroup, Input, LABEL_CLASS, RadioGroup, Select, Switch, TextArea } from './fields.js';
import { Badge } from './display.js';
import { cx } from './cx.js';
import { Icon } from './icons.js';
import { fieldsOf, groupFields, validateValue, widgetOf } from './schema.js';

/** @typedef {import('./schema.js').FeatureSchema} FeatureSchema */
/** @typedef {import('./schema.js').FeatureNode} FeatureNode */
/** @typedef {import('./schema.js').FieldDescriptor} FieldDescriptor */
/** @typedef {{ label?: string, reason?: string }} LockInfo */

/** @param {unknown} value */
const display = (value) => {
	if (value === null) return 'Unlimited';
	if (value === undefined) return '—';
	if (typeof value === 'boolean') return value ? 'On' : 'Off';
	if (Array.isArray(value)) return value.length === 0 ? 'None' : value.join(', ');
	if (typeof value === 'object') return JSON.stringify(value);
	return String(value);
};

const fmt = new Intl.NumberFormat('en-US');

/**
 * Bounds hint shown next to a label.
 * @param {FieldDescriptor} field
 */
const boundsHint = (field) => {
	const { bounds, node } = field;
	const parts = [];
	if (typeof bounds.planMax === 'number') {
		const what = node.type === 'array' ? ' items' : node.type === 'string' ? ' chars' : '';
		parts.push(`Plan max ${fmt.format(bounds.planMax)}${what}`);
	}
	if (bounds.planMax === false) parts.push('Not in your plan');
	return parts.join(' · ') || null;
};

/**
 * Generic value control for a node (recursive for objects).
 * @param {{ id: string, label: string, node: FeatureNode, value: unknown, onChange: (value: unknown) => void,
 *   error?: string | undefined, help?: import('react').ReactNode, disabled?: boolean, widget?: string,
 *   placeholder?: string | null, aside?: import('react').ReactNode, unlimitedAllowed?: boolean, plan?: string | null,
 *   flagAllowed?: boolean, max?: number | undefined, maxLength?: number | undefined, maxItems?: number | undefined }} props
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
	unlimitedAllowed = false,
	plan = null,
	flagAllowed = true,
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
					disabled={disabled || (!flagAllowed && value !== true)}
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
				disabled={disabled || (!flagAllowed && value !== true)}
				onChange={(next) => onChange(next)}
				description={help}
				error={error}
				aside={aside}
			/>
		);
	}

	if (node.type === 'integer' || node.type === 'number') {
		const unlimited = value === null;
		return (
			<div className="space-y-2">
				<Input
					{...common}
					label={label}
					type="number"
					inputMode={node.type === 'integer' ? 'numeric' : 'decimal'}
					step={node.multipleOf ?? (node.type === 'integer' ? 1 : 'any')}
					min={node.minimum}
					max={max}
					value={unlimited || value === undefined ? '' : String(value)}
					placeholder={unlimited ? 'Unlimited' : ph}
					disabled={disabled || unlimited}
					onChange={(e) => {
						const raw = e.currentTarget.value;
						onChange(raw === '' ? undefined : Number(raw));
					}}
				/>
				{unlimitedAllowed && !disabled ? (
					<Checkbox
						label="Unlimited"
						checked={unlimited}
						onChange={(e) => onChange(e.currentTarget.checked ? null : (node.default ?? node.minimum ?? 0))}
					/>
				) : null}
			</div>
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
			<fieldset className="space-y-3 rounded-xl border border-line p-4" disabled={disabled}>
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
						plan={plan}
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
 * Read-only row of a locked feature.
 * @param {{ field: FieldDescriptor, value: unknown, lock: LockInfo }} props
 */
function LockedField({ field, value, lock }) {
	return (
		<div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-line bg-surface-2 px-4 py-3">
			<div className="min-w-0 space-y-0.5">
				<p className="flex items-center gap-1.5 text-sm font-semibold text-fg">
					<Icon name="lock" size={13} title="Locked" />
					{field.title}
				</p>
				<p className="text-xs text-muted">
					{lock.label ?? 'Set by platform/admin'}
					{lock.reason ? ` — ${lock.reason}` : ''}
				</p>
			</div>
			<span className="max-w-full break-all rounded-lg bg-surface px-2 py-1 font-mono text-xs text-fg">{display(value)}</span>
		</div>
	);
}

/**
 * @param {{ schema: FeatureSchema | null | undefined, values: Record<string, unknown>,
 *   onChange: (name: string, value: unknown) => void, plan?: string | null, locks?: Record<string, LockInfo>,
 *   errors?: Record<string, string>, overridden?: Record<string, boolean>, onReset?: (name: string) => void,
 *   disabled?: boolean, idPrefix?: string, emptyText?: string, className?: string }} props
 */
export function SchemaForm({
	schema,
	values,
	onChange,
	plan = null,
	locks = {},
	errors = {},
	overridden = {},
	onReset,
	disabled = false,
	idPrefix,
	emptyText = 'This element has no settings.',
	className,
}) {
	const auto = useId();
	const prefix = idPrefix ?? `sf${auto.replace(/[^a-zA-Z0-9_-]/g, '')}`;
	const [showAdvanced, setShowAdvanced] = useState(false);
	const fields = fieldsOf(schema, { plan });
	if (fields.length === 0) return <p className="text-sm text-muted">{emptyText}</p>;
	const { groups, advanced } = groupFields(fields);
	const advancedErrors = advanced.some((f) => errors[f.name]);

	/** @param {FieldDescriptor} field */
	const renderField = (field) => {
		const lock = locks[field.name];
		if (lock) return <LockedField key={field.name} field={field} value={values[field.name]} lock={lock} />;
		const hint = boundsHint(field);
		const isOverridden = overridden[field.name] === true;
		const aside = (
			<span className="inline-flex flex-wrap items-center gap-1.5">
				{field.unitLabel ? <span className="text-muted">{field.unitLabel}</span> : null}
				{hint ? <Badge tone={field.bounds.planMax === false ? 'warning' : 'info'}>{hint}</Badge> : null}
				{isOverridden && onReset && !disabled ? (
					<button
						type="button"
						onClick={() => onReset(field.name)}
						className="rounded text-xs font-semibold text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-focus">
						Reset
					</button>
				) : null}
			</span>
		);
		return (
			<div key={field.name} data-field={field.name}>
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
					unlimitedAllowed={field.unlimitedAllowed}
					plan={plan}
					flagAllowed={field.bounds.flagAllowed}
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
					<div key={group.name} className="space-y-5">
						{group.fields.map(renderField)}
					</div>
				) : (
					<fieldset key={group.name} className="space-y-5">
						<legend className="mb-3 text-sm font-bold text-fg">{group.name}</legend>
						{group.fields.map(renderField)}
					</fieldset>
				),
			)}
			{advanced.length > 0 ? (
				<div className="space-y-4 border-t border-line pt-4">
					<Button
						variant="ghost"
						size="sm"
						aria-expanded={showAdvanced || advancedErrors}
						aria-controls={`${prefix}-advanced`}
						onClick={() => setShowAdvanced((v) => !v)}
						icon={<Icon name={showAdvanced || advancedErrors ? 'chevronDown' : 'chevronRight'} size={14} />}>
						{`Advanced settings (${advanced.length})`}
					</Button>
					{showAdvanced || advancedErrors ? (
						<div id={`${prefix}-advanced`} className="space-y-5">
							{advanced.map(renderField)}
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
}
