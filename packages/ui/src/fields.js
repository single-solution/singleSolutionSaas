/**
 * Form controls. Every control has a visible label (or `hideLabel` for a visually hidden one), optional help text
 * and an error message, wired with `aria-describedby` / `aria-invalid` so assistive technology announces them.
 *
 * Layout (PLAN 0.6 "fields in a grid"): every control's root is a grid cell (`data-cell`). Inside a {@link FieldGrid}
 * (and so inside every `Form`) short controls pack into 1 column on narrow containers, 2 from 28rem and 3 from 48rem
 * (container widths, so dialogs and side panels get fewer columns); long ones (`TextArea`, `CheckboxGroup`, or any
 * control with `wide`) span the whole row, and anything that is not a control (buttons, callouts, groups) does too.
 * @module
 */
import { useId, useState } from 'react';
import { cx } from './cx.js';
import { Icon } from './icons.js';

/** @typedef {import('react').ReactNode} ReactNode */

/** A field's label: sentence case, medium weight (one look for labels and legends everywhere). */
const LABEL_CLASS = 'block text-[13px] font-medium leading-5 text-fg';

/**
 * Classes of a responsive field grid: 1 / 2 / 3 columns by the width of the nearest `@container`, packed densely
 * (masonry-like); children that are not field cells, and wide cells, span the row. A lone field cell spans the row
 * too, so a card with one short setting does not leave it orphaned in a corner.
 */
export const FIELD_GRID =
	'grid grid-flow-row-dense grid-cols-1 items-start gap-x-6 gap-y-5 @md:grid-cols-2 @3xl:grid-cols-3 ' +
	'[&>:not([data-cell])]:col-span-full [&>[data-wide]]:col-span-full ' +
	'[&:not(:has(>[data-cell]~[data-cell]))>[data-cell]]:col-span-full [&>a]:justify-self-start [&>button]:justify-self-start';

/**
 * Grid cell attributes of a control's root (`wide` spans the whole row).
 * @param {boolean | undefined} wide
 */
const cell = (wide) => (wide ? { 'data-cell': '', 'data-wide': '' } : { 'data-cell': '' });

/**
 * A responsive grid of fields (its own size container): short controls side by side, long ones full width.
 * @param {{ children: ReactNode, className?: string }} props
 */
export function FieldGrid({ children, className }) {
	return (
		<div className={cx('@container min-w-0', className)}>
			<div className={FIELD_GRID}>{children}</div>
		</div>
	);
}
// flat at rest; focus shows the accent edge with a soft halo (no outline jump)
const CONTROL =
	'w-full rounded-control border bg-surface px-3 py-2 text-sm text-fg placeholder:text-muted/70 ss-motion ' +
	'focus:outline-none focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-primary/20 ' +
	'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-muted [&:read-only:not(select)]:bg-surface-2';

/** One height for single-line controls, the same as a medium button, so they line up in a row. */
const LINE = 'h-9 py-0';

/** A colour input: the whole control is the swatch. */
const COLOR =
	'cursor-pointer p-1 [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded-lg ' +
	'[&::-webkit-color-swatch]:border-0 [&::-moz-color-swatch]:rounded-lg [&::-moz-color-swatch]:border-0';

/**
 * @param {boolean} invalid
 */
const controlClass = (invalid) =>
	cx(
		CONTROL,
		invalid ? 'border-danger focus-visible:border-danger focus-visible:ring-danger/20' : 'border-line hover:border-line-strong',
	);

/**
 * Ids for a field's parts.
 * @param {string | undefined} id
 */
const useFieldIds = (id) => {
	const auto = useId();
	const base = id ?? `f${auto.replace(/[^a-zA-Z0-9_-]/g, '')}`;
	return { id: base, help: `${base}-help`, error: `${base}-error` };
};

/**
 * @param {{ help?: ReactNode, error?: ReactNode }} parts
 * @param {{ help: string, error: string }} ids
 */
const describedBy = ({ help, error }, ids) =>
	[help ? ids.help : null, error ? ids.error : null].filter(Boolean).join(' ') || undefined;

/**
 * Help and error lines under a control; an error fades in with a short shake (again when its message changes).
 * @param {{ ids: { help: string, error: string }, help?: ReactNode, error?: ReactNode }} props
 */
function FieldMessages({ ids, help, error }) {
	return (
		<>
			{help ? (
				<p id={ids.help} className="text-xs leading-relaxed text-muted">
					{help}
				</p>
			) : null}
			{error ? (
				<p
					key={typeof error === 'string' ? error : undefined}
					id={ids.error}
					className="flex animate-ss-shake items-center gap-1 text-xs font-medium text-danger"
					role="alert">
					<Icon name="alert" size={12} />
					{error}
				</p>
			) : null}
		</>
	);
}

/**
 * Label + control + messages layout (for custom controls).
 * @param {{ id?: string, label: ReactNode, hideLabel?: boolean, required?: boolean, help?: ReactNode,
 *   error?: ReactNode, aside?: ReactNode, className?: string, wide?: boolean,
 *   children: (ids: { id: string, help: string, error: string, describedBy: string | undefined }) => ReactNode }} props
 */
function Field({ id, label, hideLabel = false, required = false, help, error, aside, className, wide, children }) {
	const ids = useFieldIds(id);
	return (
		<div {...cell(wide)} className={cx('min-w-0 space-y-2', className)}>
			<div className={cx('flex items-center justify-between gap-2', hideLabel && 'sr-only')}>
				<label htmlFor={ids.id} className={cx(LABEL_CLASS, 'min-w-0 break-words')}>
					{label}
					{required ? (
						<span className="text-danger" aria-hidden="true">
							{' '}
							*
						</span>
					) : null}
				</label>
				{aside ? <span className="text-xs text-muted">{aside}</span> : null}
			</div>
			{children({ ...ids, describedBy: describedBy({ help, error }, ids) })}
			<FieldMessages ids={ids} help={help} error={error} />
		</div>
	);
}

/**
 * `wide`: span the whole row of a field grid.
 * @typedef {{ label: ReactNode, hideLabel?: boolean, help?: ReactNode, error?: ReactNode, aside?: ReactNode,
 *   suffix?: ReactNode, fieldClassName?: string, wide?: boolean }} FieldProps
 */

/**
 * Text-like input (`type` text, email, password, number, url, date, color …).
 * @param {import('react').InputHTMLAttributes<HTMLInputElement> & FieldProps & { ref?: import('react').Ref<HTMLInputElement> }} props
 */
export function Input({ label, hideLabel, help, error, aside, suffix, fieldClassName, wide, id, required, className, ...rest }) {
	return (
		<Field
			label={label}
			wide={wide}
			{...(id ? { id } : {})}
			{...(hideLabel ? { hideLabel } : {})}
			required={Boolean(required)}
			help={help}
			error={error}
			aside={aside}
			{...(fieldClassName ? { className: fieldClassName } : {})}>
			{(ids) => (
				<div className="relative flex items-center">
					<input
						id={ids.id}
						required={required}
						aria-invalid={error ? true : undefined}
						aria-describedby={ids.describedBy}
						className={cx(
							controlClass(Boolean(error)),
							LINE,
							suffix ? 'pr-16' : null,
							rest.type === 'color' && COLOR,
							className,
						)}
						{...rest}
					/>
					{suffix ? (
						<span className="pointer-events-none absolute right-3 text-xs font-medium text-muted">{suffix}</span>
					) : null}
				</div>
			)}
		</Field>
	);
}

/**
 * Multi-line text (long text: spans the whole row of a field grid unless `wide={false}`).
 * @param {import('react').TextareaHTMLAttributes<HTMLTextAreaElement> & FieldProps} props
 */
export function TextArea({
	label,
	hideLabel,
	help,
	error,
	aside,
	fieldClassName,
	wide = true,
	id,
	required,
	className,
	rows = 4,
	...rest
}) {
	return (
		<Field
			label={label}
			wide={wide}
			{...(id ? { id } : {})}
			{...(hideLabel ? { hideLabel } : {})}
			required={Boolean(required)}
			help={help}
			error={error}
			aside={aside}
			{...(fieldClassName ? { className: fieldClassName } : {})}>
			{(ids) => (
				<textarea
					id={ids.id}
					rows={rows}
					required={required}
					aria-invalid={error ? true : undefined}
					aria-describedby={ids.describedBy}
					className={cx(controlClass(Boolean(error)), 'min-h-20', className)}
					{...rest}
				/>
			)}
		</Field>
	);
}

/**
 * @typedef {{ value: string, label: ReactNode, disabled?: boolean }} Option
 */

/**
 * Native select (keyboard and screen-reader friendly everywhere).
 * @param {import('react').SelectHTMLAttributes<HTMLSelectElement> & FieldProps & { options: Option[], placeholder?: string }} props
 */
export function Select({
	label,
	hideLabel,
	help,
	error,
	aside,
	fieldClassName,
	wide,
	id,
	required,
	className,
	options,
	placeholder,
	...rest
}) {
	return (
		<Field
			label={label}
			wide={wide}
			{...(id ? { id } : {})}
			{...(hideLabel ? { hideLabel } : {})}
			required={Boolean(required)}
			help={help}
			error={error}
			aside={aside}
			{...(fieldClassName ? { className: fieldClassName } : {})}>
			{(ids) => (
				<div className="relative">
					<select
						id={ids.id}
						required={required}
						aria-invalid={error ? true : undefined}
						aria-describedby={ids.describedBy}
						className={cx(controlClass(Boolean(error)), LINE, 'cursor-pointer appearance-none pr-9', className)}
						{...rest}>
						{placeholder ? (
							<option value="" disabled>
								{placeholder}
							</option>
						) : null}
						{options.map((o) => (
							<option key={o.value} value={o.value} disabled={o.disabled}>
								{o.label}
							</option>
						))}
					</select>
					<span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-muted">
						<Icon name="chevronDown" size={14} />
					</span>
				</div>
			)}
		</Field>
	);
}

// Checkboxes and radios are drawn by the kit, so they look the same in every browser and theme: a hairline box at
// rest, the accent fill (a tick, or a ring for a radio) when chosen, the accent edge on hover.
const BOX =
	'size-[18px] shrink-0 cursor-pointer appearance-none border border-line-strong bg-surface ss-motion hover:border-primary ' +
	'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50';
const RADIO = cx(BOX, 'rounded-full checked:border-[5px] checked:border-primary');

/**
 * A bare kit-drawn checkbox (no label of its own: give it `aria-label`, or use {@link Checkbox}); the real input stays
 * for keyboards, forms and screen readers. For row selection in lists and tables.
 * @param {Omit<import('react').InputHTMLAttributes<HTMLInputElement>, 'type'>} props
 */
export function CheckboxInput({ className, ...rest }) {
	return (
		<span className={cx('relative inline-flex shrink-0', className)}>
			<input
				type="checkbox"
				className={cx(BOX, 'peer rounded-[5px] checked:border-primary checked:bg-primary checked:hover:bg-primary-hover')}
				{...rest}
			/>
			<span
				aria-hidden="true"
				className="pointer-events-none absolute inset-0 flex items-center justify-center text-on-primary opacity-0 ss-motion peer-checked:opacity-100">
				<Icon name="check" size={12} />
			</span>
		</span>
	);
}

/**
 * Checkbox with a label on the right.
 * @param {Omit<import('react').InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: ReactNode, help?: ReactNode,
 *   error?: ReactNode, wide?: boolean }} props
 */
export function Checkbox({ label, help, error, id, className, wide, ...rest }) {
	const ids = useFieldIds(id);
	return (
		<div {...cell(wide)} className={cx('min-w-0 space-y-1', className)}>
			<div className="flex items-start gap-2.5">
				<CheckboxInput
					id={ids.id}
					aria-invalid={error ? true : undefined}
					aria-describedby={describedBy({ help, error }, ids)}
					className="mt-px"
					{...rest}
				/>
				<label htmlFor={ids.id} className="cursor-pointer text-sm leading-5 font-medium text-fg">
					{label}
				</label>
			</div>
			<div className="pl-7">
				<FieldMessages ids={ids} help={help} error={error} />
			</div>
		</div>
	);
}

/**
 * On/off switch (`role="switch"`). `onChange` receives the next boolean. `locked` renders it read-only with a
 * lock icon.
 * @param {{ checked: boolean, onChange?: (next: boolean) => void, label: ReactNode, description?: ReactNode,
 *   error?: ReactNode, disabled?: boolean, locked?: boolean, lockedLabel?: string, id?: string, hideLabel?: boolean,
 *   size?: 'sm' | 'md', className?: string, aside?: ReactNode, wide?: boolean }} props
 */
export function Switch({
	checked,
	onChange,
	label,
	description,
	error,
	disabled = false,
	locked = false,
	lockedLabel = 'Locked',
	id,
	hideLabel = false,
	size = 'md',
	className,
	aside,
	wide,
}) {
	const ids = useFieldIds(id);
	const inactive = disabled || locked;
	const track = size === 'sm' ? 'h-4 w-7' : 'h-5 w-9';
	const knob = size === 'sm' ? 'size-3' : 'size-4';
	const shift = size === 'sm' ? 'translate-x-3' : 'translate-x-4';
	return (
		<div {...cell(wide)} className={cx('flex min-w-0 items-start justify-between gap-4', className)}>
			<div className={cx('min-w-0 space-y-0.5', hideLabel && 'sr-only')}>
				<label htmlFor={ids.id} className="flex items-center gap-1.5 text-sm leading-5 font-medium text-fg">
					{label}
					{locked ? <Icon name="lock" size={13} title={lockedLabel} /> : null}
				</label>
				<FieldMessages ids={ids} help={description} error={error} />
			</div>
			<div className="flex shrink-0 items-center gap-3">
				{aside}
				<button
					id={ids.id}
					type="button"
					role="switch"
					aria-checked={checked}
					aria-describedby={describedBy({ help: description, error }, ids)}
					aria-readonly={locked || undefined}
					disabled={inactive}
					onClick={() => onChange?.(!checked)}
					className={cx(
						'ss-motion ss-press relative inline-flex shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent',
						'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-60',
						track,
						checked ? 'bg-primary hover:bg-primary-hover' : 'bg-line-strong hover:bg-muted',
					)}>
					<span
						aria-hidden="true"
						className={cx(
							'inline-block rounded-full bg-surface shadow-knob transition-transform duration-(--ss-motion) ease-ss',
							knob,
							checked ? shift : 'translate-x-0',
						)}
					/>
				</button>
			</div>
		</div>
	);
}

/**
 * Radio group in a fieldset.
 * @param {{ legend: ReactNode, name?: string, options: Option[], value: string | null | undefined,
 *   onChange: (value: string) => void, help?: ReactNode, error?: ReactNode, disabled?: boolean, inline?: boolean,
 *   className?: string, wide?: boolean }} props
 */
export function RadioGroup({
	legend,
	name,
	options,
	value,
	onChange,
	help,
	error,
	disabled = false,
	inline = false,
	className,
	wide,
}) {
	const ids = useFieldIds(undefined);
	const groupName = name ?? ids.id;
	return (
		<fieldset
			{...cell(wide)}
			className={cx('min-w-0 space-y-2', className)}
			aria-describedby={describedBy({ help, error }, ids)}
			disabled={disabled}>
			<legend className={cx(LABEL_CLASS, 'mb-2')}>{legend}</legend>
			<div className={cx(inline ? 'flex flex-wrap gap-x-6 gap-y-2.5' : 'space-y-2.5')}>
				{options.map((o) => {
					const optionId = `${ids.id}-${o.value}`;
					return (
						<div key={o.value} className="flex items-center gap-2.5">
							<input
								id={optionId}
								type="radio"
								name={groupName}
								value={o.value}
								checked={value === o.value}
								disabled={o.disabled}
								onChange={() => onChange(o.value)}
								className={RADIO}
							/>
							<label htmlFor={optionId} className="cursor-pointer text-sm leading-5 text-fg">
								{o.label}
							</label>
						</div>
					);
				})}
			</div>
			<FieldMessages ids={ids} help={help} error={error} />
		</fieldset>
	);
}

/**
 * Several checkboxes for a list value.
 * @param {{ legend: ReactNode, options: Option[], value: readonly string[], onChange: (value: string[]) => void,
 *   help?: ReactNode, error?: ReactNode, disabled?: boolean, className?: string, wide?: boolean }} props
 *   `wide` defaults to true (a list of options spans the row)
 */
export function CheckboxGroup({ legend, options, value, onChange, help, error, disabled = false, className, wide = true }) {
	const ids = useFieldIds(undefined);
	const selected = new Set(value);
	return (
		<fieldset
			{...cell(wide)}
			className={cx('min-w-0 space-y-2', className)}
			aria-describedby={describedBy({ help, error }, ids)}
			disabled={disabled}>
			<legend className={cx(LABEL_CLASS, 'mb-2')}>{legend}</legend>
			<div className="flex flex-wrap gap-x-6 gap-y-2.5">
				{options.map((o) => {
					const optionId = `${ids.id}-${o.value}`;
					const on = selected.has(o.value);
					return (
						<div key={o.value} className="flex items-center gap-2.5">
							<CheckboxInput
								id={optionId}
								checked={on}
								disabled={o.disabled}
								onChange={() =>
									onChange(
										on
											? value.filter((v) => v !== o.value)
											: options.map((x) => x.value).filter((v) => v === o.value || selected.has(v)),
									)
								}
							/>
							<label htmlFor={optionId} className="cursor-pointer text-sm leading-5 text-fg">
								{o.label}
							</label>
						</div>
					);
				})}
			</div>
			<FieldMessages ids={ids} help={help} error={error} />
		</fieldset>
	);
}

/**
 * A long list of choices (countries, languages …) for a list value: the chosen ones as chips that remove themselves,
 * a search box, and a scrolling list of checkboxes filtered by it (by label or value; the value shows beside a label
 * that differs). A new choice is added at the end, so the list keeps the order it was picked in.
 * @param {{ legend: ReactNode, options: Option[], value: readonly string[], onChange: (value: string[]) => void,
 *   help?: ReactNode, error?: ReactNode, disabled?: boolean, emptyText?: ReactNode,
 *   searchLabel?: string, noMatchText?: ReactNode, removeLabel?: string, className?: string, wide?: boolean }} props
 *   `wide` defaults to true
 */
export function ChoicePicker({
	legend,
	options,
	value,
	onChange,
	help,
	error,
	disabled = false,
	emptyText = 'None chosen',
	searchLabel = 'Search',
	noMatchText = 'No match.',
	removeLabel = 'Remove',
	className,
	wide = true,
}) {
	const ids = useFieldIds(undefined);
	const [query, setQuery] = useState('');
	const selected = new Set(value);
	const labelOf = new Map(options.map((o) => [o.value, o.label]));
	const needle = query.trim().toLowerCase();
	const shown = needle
		? options.filter(
				(o) =>
					o.value.toLowerCase().includes(needle) || (typeof o.label === 'string' && o.label.toLowerCase().includes(needle)),
			)
		: options;
	/** @param {string} choice */
	const toggle = (choice) => onChange(selected.has(choice) ? value.filter((v) => v !== choice) : [...value, choice]);
	return (
		<fieldset
			{...cell(wide)}
			className={cx('min-w-0 space-y-2.5', className)}
			aria-describedby={describedBy({ help, error }, ids)}
			disabled={disabled}>
			<legend className={cx(LABEL_CLASS, 'mb-2')}>
				{legend}
				{value.length > 0 ? <span className="ml-1.5 font-normal text-muted">{value.length}</span> : null}
			</legend>
			<div className="flex min-h-7 flex-wrap items-center gap-1.5">
				{value.length === 0 ? (
					<span className="text-sm text-muted">{emptyText}</span>
				) : (
					value.map((choice) => {
						const label = labelOf.get(choice) ?? choice;
						return (
							<span
								key={choice}
								className="inline-flex animate-ss-fade items-center gap-1 rounded-full bg-primary-soft py-0.5 pr-1 pl-2.5 text-xs leading-5 font-medium text-on-primary-soft">
								{label}
								<button
									type="button"
									onClick={() => toggle(choice)}
									aria-label={`${removeLabel} ${typeof label === 'string' ? label : choice}`}
									className="ss-motion rounded-full p-0.5 hover:bg-surface focus-visible:outline-2 focus-visible:outline-focus">
									<Icon name="close" size={12} />
								</button>
							</span>
						);
					})
				)}
			</div>
			<div className="ss-motion overflow-hidden rounded-control border border-line bg-surface focus-within:border-primary focus-within:ring-[3px] focus-within:ring-primary/20">
				<input
					type="search"
					aria-label={searchLabel}
					placeholder={searchLabel}
					value={query}
					onChange={(e) => setQuery(e.currentTarget.value)}
					className="h-9 w-full border-b border-line-soft bg-transparent px-3 text-sm text-fg placeholder:text-muted/70 focus:outline-none"
				/>
				<div className="max-h-56 overflow-y-auto p-1">
					{shown.length === 0 ? (
						<p className="px-2 py-3 text-sm text-muted">{noMatchText}</p>
					) : (
						shown.map((o) => {
							const optionId = `${ids.id}-${o.value}`;
							const on = selected.has(o.value);
							return (
								<label
									key={o.value}
									htmlFor={optionId}
									className="ss-motion flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-fg hover:bg-surface-2">
									<CheckboxInput id={optionId} checked={on} disabled={o.disabled} onChange={() => toggle(o.value)} />
									<span className="min-w-0 flex-1 truncate">{o.label}</span>
									{o.label !== o.value ? <span className="text-xs text-muted tabular-nums">{o.value}</span> : null}
								</label>
							);
						})
					)}
				</div>
			</div>
			<FieldMessages ids={ids} help={help} error={error} />
		</fieldset>
	);
}
