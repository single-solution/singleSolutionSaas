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
import { createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import { cx } from './cx.js';
import { Icon } from './icons.js';

/** @typedef {import('react').ReactNode} ReactNode */

/** A field's label: sentence case, 13/18 medium (one look for labels and legends everywhere). */
const LABEL_CLASS = 'block text-label font-medium text-fg';

/**
 * A setting row (owner 2026-10-17, like Stripe's settings): the label and help in a left column of about 280 px, the
 * control in the right column at most 560 px wide (640 for long text), stacked when the card is narrower than 42rem.
 * No control stretches across the whole card.
 */
export const ROW_GRID = 'grid min-w-0 items-start gap-x-10 gap-y-2 @2xl:grid-cols-[minmax(0,17.5rem)_minmax(0,1fr)]';
/** The left column of a setting row (the label lines up with the control's text). */
export const ROW_LABEL = 'min-w-0 space-y-1 @2xl:pt-2';
/**
 * The right column of a setting row.
 * @param {boolean | undefined} wide a long control (text area, list of choices): 640 px instead of 560
 */
export const rowControl = (wide) => cx('min-w-0 space-y-1.5', wide ? 'max-w-[40rem]' : 'max-w-[35rem]');

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
 * The layout of the fields inside: `stack` (a label above its control) or `row` (the label and help on the left, the
 * control on the right). A {@link SettingsCard} sets `row`; a field's own `layout` prop wins.
 */
export const FieldLayoutContext = createContext(/** @type {'stack' | 'row'} */ ('stack'));

/**
 * Classes of a list of setting rows (the body of a {@link SettingsCard}, and a `Form` inside one): the fields are
 * rows separated by hairlines; anything that is not a field (buttons, callouts) sits below with a gap.
 */
export const ROW_LIST =
	'flex flex-col [&>[data-cell]]:py-4 [&>[data-cell]:first-child]:pt-0 [&>[data-cell]:last-child]:pb-0 ' +
	'[&>[data-cell]:has(+:not([data-cell]))]:pb-0 [&>[data-cell]+[data-cell]]:border-t [&>[data-cell]+[data-cell]]:border-line-soft ' +
	'[&>:not([data-cell])]:mt-4 [&>:first-child:not([data-cell])]:mt-0 [&>a]:self-start [&>button]:self-start';

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
	'w-full max-w-[35rem] rounded-control border bg-surface px-3 py-2 text-sm text-fg shadow-card placeholder:text-subtle ss-motion ' +
	'focus:outline-none focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-primary/20 ' +
	'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-muted [&:read-only:not(select)]:bg-surface-2';

/** One height for single-line controls, the same as a medium button, so they line up in a row. */
const LINE = 'h-9 py-0';

/** A color input: the whole control is the swatch. */
const COLOR =
	'cursor-pointer p-1 [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded-lg ' +
	'[&::-webkit-color-swatch]:border-0 [&::-moz-color-swatch]:rounded-lg [&::-moz-color-swatch]:border-0';

/** A file input: the button inside it takes the look of a quiet button, not the browser's. */
const FILE =
	'cursor-pointer py-1.5 text-muted file:mr-3 file:cursor-pointer file:rounded-control file:border-0 file:bg-surface-2 ' +
	'file:px-3 file:py-1 file:text-label file:font-medium file:text-fg hover:file:bg-surface-3';

/**
 * @param {boolean} invalid
 */
const controlClass = (invalid) =>
	cx(
		CONTROL,
		invalid ? 'border-danger focus-visible:border-danger focus-visible:ring-danger/20' : 'border-line hover:border-line-strong',
	);

/**
 * The frame of a single-line input with adornments (a prefix and/or a suffix): the frame carries the border, the focus
 * halo and the disabled / read-only look, the input inside is bare.
 * @param {boolean} invalid
 */
const adornedClass = (invalid) =>
	cx(
		'flex h-9 w-full max-w-[35rem] items-center rounded-control border bg-surface text-sm shadow-card ss-motion',
		'has-[input:focus-visible]:ring-[3px] has-[input:disabled]:cursor-not-allowed has-[input:disabled]:bg-surface-2 has-[input:disabled]:text-muted has-[input:read-only]:bg-surface-2',
		invalid
			? 'border-danger has-[input:focus-visible]:border-danger has-[input:focus-visible]:ring-danger/20'
			: 'border-line hover:border-line-strong has-[input:focus-visible]:border-primary has-[input:focus-visible]:ring-primary/20',
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
 * `part` shows only one of them (a setting row keeps the help under its label and the error under its control).
 * @param {{ ids: { help: string, error: string }, help?: ReactNode, error?: ReactNode, part?: 'help' | 'error' }} props
 */
function FieldMessages({ ids, help, error, part }) {
	return (
		<>
			{help && part !== 'error' ? (
				<p id={ids.help} className="text-help text-muted">
					{help}
				</p>
			) : null}
			{error && part !== 'help' ? (
				<p
					key={typeof error === 'string' ? error : undefined}
					id={ids.error}
					className="flex animate-ss-shake items-center gap-1 text-help font-medium text-danger"
					role="alert">
					<Icon name="alert" size={12} />
					{error}
				</p>
			) : null}
		</>
	);
}

/**
 * Whether a field in the given layout is a row: its label and help on the left, the control on the right (a `wide`
 * control too: it gets the wider right column).
 * @param {'stack' | 'row' | undefined} layout the field's own layout
 * @param {'stack' | 'row'} inherited the layout of the card around it
 */
const isRow = (layout, inherited) => (layout ?? inherited) === 'row';

/**
 * Label + control + messages layout (for custom controls). In a row layout (inside a {@link SettingsCard}, or with
 * `layout="row"`) the label and its help sit on the left and the control and its error on the right, stacking again
 * when the card is narrow (container query); hidden labels always stack.
 * @param {{ id?: string, label: ReactNode, hideLabel?: boolean, required?: boolean, help?: ReactNode,
 *   error?: ReactNode, aside?: ReactNode, className?: string, wide?: boolean, layout?: 'stack' | 'row',
 *   children: (ids: { id: string, help: string, error: string, describedBy: string | undefined }) => ReactNode }} props
 */
function Field({ id, label, hideLabel = false, required = false, help, error, aside, className, wide, layout, children }) {
	const ids = useFieldIds(id);
	const inherited = useContext(FieldLayoutContext);
	const row = isRow(layout, inherited) && !hideLabel;
	const labelRow = (
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
			{aside ? <span className="text-help text-muted">{aside}</span> : null}
		</div>
	);
	if (row)
		return (
			<div {...cell(wide)} className={cx(ROW_GRID, className)}>
				<div className={ROW_LABEL}>
					{labelRow}
					<FieldMessages ids={ids} help={help} part="help" />
				</div>
				<div className={rowControl(wide)}>
					{children({ ...ids, describedBy: describedBy({ help, error }, ids) })}
					<FieldMessages ids={ids} error={error} part="error" />
				</div>
			</div>
		);
	return (
		<div {...cell(wide)} className={cx('min-w-0 space-y-2', className)}>
			{labelRow}
			{children({ ...ids, describedBy: describedBy({ help, error }, ids) })}
			<FieldMessages ids={ids} help={help} error={error} />
		</div>
	);
}

/**
 * `wide`: span the whole row of a field grid (and stack the label above the control in a setting row); `layout`
 * overrides the layout of the card around the field.
 * @typedef {{ label: ReactNode, hideLabel?: boolean, help?: ReactNode, error?: ReactNode, aside?: ReactNode,
 *   suffix?: ReactNode, prefix?: ReactNode, fieldClassName?: string, wide?: boolean, layout?: 'stack' | 'row' }} FieldProps
 */

/**

 * Text-like input (`type` text, email, password, number, url, date, color, file …). `prefix` and `suffix` are adornments
 * inside the frame (a currency sign, a unit, `https://`, an icon).
 * @param {Omit<import('react').InputHTMLAttributes<HTMLInputElement>, 'prefix'> & FieldProps & { ref?: import('react').Ref<HTMLInputElement> }} props
 */
export function Input({
	label,
	hideLabel,
	help,
	error,
	aside,
	suffix,
	prefix,
	fieldClassName,
	wide,
	layout,
	id,
	required,
	className,
	...rest
}) {
	const adorned = Boolean(prefix || suffix);
	return (
		<Field
			label={label}
			wide={wide}
			{...(layout ? { layout } : {})}
			{...(id ? { id } : {})}
			{...(hideLabel ? { hideLabel } : {})}
			required={Boolean(required)}
			help={help}
			error={error}
			aside={aside}
			{...(fieldClassName ? { className: fieldClassName } : {})}>
			{(ids) =>
				adorned ? (
					<div className={adornedClass(Boolean(error))}>
						{prefix ? <span className="shrink-0 pl-3 text-sm text-muted">{prefix}</span> : null}
						<input
							id={ids.id}
							required={required}
							aria-invalid={error ? true : undefined}
							aria-describedby={ids.describedBy}
							className={cx(
								'h-full min-w-0 flex-1 bg-transparent px-3 text-sm text-fg placeholder:text-muted/70 focus:outline-none disabled:cursor-not-allowed',
								prefix ? 'pl-2' : null,
								suffix ? 'pr-2' : null,
								className,
							)}
							{...rest}
						/>
						{suffix ? <span className="shrink-0 pr-3 text-xs font-medium text-muted">{suffix}</span> : null}
					</div>
				) : (
					<input
						id={ids.id}
						required={required}
						aria-invalid={error ? true : undefined}
						aria-describedby={ids.describedBy}
						className={cx(controlClass(Boolean(error)), LINE, rest.type === 'color' && COLOR, rest.type === 'file' && FILE, className)}
						{...rest}
					/>
				)
			}
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
	layout,
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
			{...(layout ? { layout } : {})}
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
					className={cx(controlClass(Boolean(error)), 'min-h-20 max-w-[40rem]', className)}
					{...rest}
				/>
			)}
		</Field>
	);
}

/**
 * @typedef {{ value: string, label: ReactNode, disabled?: boolean, description?: ReactNode,
 *   icon?: import('./icons.js').IconName }} Option `description` is the muted line under a radio card's title
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
	layout,
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
			{...(layout ? { layout } : {})}
			{...(id ? { id } : {})}
			{...(hideLabel ? { hideLabel } : {})}
			required={Boolean(required)}
			help={help}
			error={error}
			aside={aside}
			{...(fieldClassName ? { className: fieldClassName } : {})}>
			{(ids) => (
				<div className="relative max-w-[35rem]">
					<select
						id={ids.id}
						required={required}
						aria-invalid={error ? true : undefined}
						aria-describedby={ids.describedBy}
						className={cx(controlClass(Boolean(error)), LINE, 'cursor-pointer appearance-none bg-none pr-9', className)}
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

// Checkboxes and radios are drawn by the kit (native inputs with the browser's look reset), so they look the same in
// every browser and theme: a hairline box at rest, the accent fill (a check mark, a dash when mixed, or a ring for a
// radio) when chosen, the accent edge on hover.
const BOX =
	'size-[18px] shrink-0 cursor-pointer appearance-none border border-line-strong bg-surface ss-motion hover:border-primary ' +
	'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50';
const RADIO = cx(BOX, 'rounded-full checked:border-[5px] checked:border-primary');

/**
 * A bare kit-drawn checkbox (no label of its own: give it `aria-label`, or use {@link Checkbox}); the real input stays
 * for keyboards, forms and screen readers. For row selection in lists and tables. `indeterminate` shows the mixed
 * state (a dash, "some of them") until the next click.
 * @param {Omit<import('react').InputHTMLAttributes<HTMLInputElement>, 'type'> & { indeterminate?: boolean,
 *   ref?: import('react').Ref<HTMLInputElement> }} props
 */
export function CheckboxInput({ className, indeterminate = false, ref, ...rest }) {
	const inner = useRef(/** @type {HTMLInputElement | null} */ (null));
	useEffect(() => {
		if (inner.current) inner.current.indeterminate = indeterminate;
	}, [indeterminate, rest.checked]);
	return (
		<span className={cx('relative inline-flex shrink-0', className)}>
			<input
				type="checkbox"
				ref={(el) => {
					inner.current = el;
					if (typeof ref === 'function') ref(el);
					else if (ref) Object.assign(ref, { current: el });
				}}
				className={cx(
					BOX,
					'peer rounded-[5px] checked:border-primary checked:bg-primary checked:hover:bg-primary-hover indeterminate:border-primary indeterminate:bg-primary',
				)}
				{...rest}
			/>
			<span
				aria-hidden="true"
				className="pointer-events-none absolute inset-0 flex items-center justify-center text-on-primary opacity-0 ss-motion peer-checked:opacity-100 peer-indeterminate:hidden">
				<Icon name="check" size={12} />
			</span>
			<span
				aria-hidden="true"
				className="pointer-events-none absolute inset-0 hidden items-center justify-center text-on-primary peer-indeterminate:flex">
				<Icon name="minus" size={12} />
			</span>
		</span>
	);
}

/**
 * Checkbox with a label on the right.
 * @param {Omit<import('react').InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: ReactNode, help?: ReactNode,
 *   error?: ReactNode, wide?: boolean, indeterminate?: boolean }} props
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
 * On/off switch (`role="switch"`, a native button: Space and Enter toggle it). `onChange` receives the next boolean.
 * Its label and description sit on the left and the switch on the right, the same as a setting row. `locked` renders
 * it read-only with a lock icon.
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
	const row = useContext(FieldLayoutContext) === 'row' && !hideLabel;
	const inactive = disabled || locked;
	const track = size === 'sm' ? 'h-5 w-9' : 'h-6 w-11';
	const knob = size === 'sm' ? 'size-4' : 'size-5';
	const shift = size === 'sm' ? 'translate-x-4' : 'translate-x-5';
	return (
		<div
			{...cell(wide)}
			className={cx(
				row
					? 'grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-10 gap-y-2 @2xl:grid-cols-[minmax(0,17.5rem)_minmax(0,1fr)]'
					: 'flex min-w-0 items-start justify-between gap-4',
				className,
			)}>
			<div className={cx('min-w-0 space-y-1', hideLabel && 'sr-only')}>
				<label htmlFor={ids.id} className="flex items-center gap-1.5 text-label leading-6 font-medium text-fg">
					{label}
					{locked ? <Icon name="lock" size={13} title={lockedLabel} /> : null}
				</label>
				<FieldMessages ids={ids} help={description} error={error} />
			</div>
			<div className={cx('flex shrink-0 items-center gap-3', row && '@2xl:pt-0.5')}>
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
 * Arrow-key handler of a group of native radios: the arrows (and Home / End) move the choice and the focus to the
 * next enabled option, wrapping round; the browsers' own arrow handling is replaced so it is the same everywhere.
 * @param {Option[]} options
 * @param {string | null | undefined} value
 * @param {(value: string) => void} onChange
 */
const radioKeys =
	(options, value, onChange) =>
	/** @param {import('react').KeyboardEvent<HTMLElement>} event */
	(event) => {
		const target = /** @type {HTMLInputElement} */ (event.target);
		if (target.type !== 'radio') return;
		const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[
			/** @type {'ArrowDown' | 'ArrowRight' | 'ArrowUp' | 'ArrowLeft'} */ (event.key)
		];
		const enabled = options.filter((o) => !o.disabled);
		if (enabled.length === 0 || (step === undefined && event.key !== 'Home' && event.key !== 'End')) return;
		const at = enabled.findIndex((o) => o.value === target.value);
		const next =
			event.key === 'Home'
				? enabled[0]
				: event.key === 'End'
					? enabled[enabled.length - 1]
					: enabled[(at + (step ?? 0) + enabled.length) % enabled.length];
		if (!next) return;
		event.preventDefault();
		if (next.value !== value) onChange(next.value);
		const radios = /** @type {HTMLInputElement[]} */ ([...event.currentTarget.querySelectorAll('input[type="radio"]')]);
		radios.find((radio) => radio.value === next.value)?.focus();
	};

/**
 * Group chrome of radios: a fieldset with a legend, or - as a setting row - a labelled group with the legend and
 * help on the left and the options on the right.
 * @param {{ legend: ReactNode, ids: { id: string, help: string, error: string }, help?: ReactNode, error?: ReactNode,
 *   disabled: boolean, wide?: boolean | undefined, layout?: 'stack' | 'row' | undefined, className?: string | undefined,
 *   onKeyDown: (event: import('react').KeyboardEvent<HTMLElement>) => void, children: ReactNode }} props
 */
function ChoiceGroup({ legend, ids, help, error, disabled, wide, layout, className, onKeyDown, children }) {
	const inherited = useContext(FieldLayoutContext);
	if (isRow(layout, inherited))
		return (
			<div
				{...cell(wide)}
				role="radiogroup"
				aria-labelledby={`${ids.id}-legend`}
				aria-describedby={describedBy({ help, error }, ids)}
				aria-disabled={disabled || undefined}
				onKeyDown={onKeyDown}
				className={cx(ROW_GRID, className)}>
				<div className={ROW_LABEL}>
					<div id={`${ids.id}-legend`} className={LABEL_CLASS}>
						{legend}
					</div>
					<FieldMessages ids={ids} help={help} part="help" />
				</div>
				<div className={rowControl(wide)}>
					{children}
					<FieldMessages ids={ids} error={error} part="error" />
				</div>
			</div>
		);
	return (
		<fieldset
			{...cell(wide)}
			onKeyDown={onKeyDown}
			className={cx('min-w-0 space-y-2', className)}
			aria-describedby={describedBy({ help, error }, ids)}
			disabled={disabled}>
			<legend className={cx(LABEL_CLASS, 'mb-2')}>{legend}</legend>
			{children}
			<FieldMessages ids={ids} help={help} error={error} />
		</fieldset>
	);
}

/**
 * Radio group. The options are a list of radios, or - with `cards` - cards with a title and a muted description
 * (`description` of each option); the arrow keys move between the options. In a {@link SettingsCard} it is a setting
 * row.
 * @param {{ legend: ReactNode, name?: string, options: Option[], value: string | null | undefined,
 *   onChange: (value: string) => void, help?: ReactNode, error?: ReactNode, disabled?: boolean, inline?: boolean,
 *   cards?: boolean, className?: string, wide?: boolean, layout?: 'stack' | 'row' }} props
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
	cards = false,
	className,
	wide,
	layout,
}) {
	const ids = useFieldIds(undefined);
	const groupName = name ?? ids.id;
	return (
		<ChoiceGroup
			legend={legend}
			ids={ids}
			help={help}
			error={error}
			disabled={disabled}
			wide={wide}
			layout={layout}
			className={className}
			onKeyDown={radioKeys(options, value, onChange)}>
			<div
				className={cx(
					cards
						? 'grid gap-2.5 @md:grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]'
						: inline
							? 'flex flex-wrap gap-x-6 gap-y-2.5'
							: 'space-y-2.5',
				)}>
				{options.map((o) => {
					const optionId = `${ids.id}-${o.value}`;
					const off = disabled || o.disabled;
					const input = (
						<input
							id={optionId}
							type="radio"
							name={groupName}
							value={o.value}
							checked={value === o.value}
							disabled={off}
							aria-describedby={o.description ? `${optionId}-description` : undefined}
							onChange={() => onChange(o.value)}
							className={cx(RADIO, cards && 'mt-0.5')}
						/>
					);
					if (cards)
						return (
							<div
								key={o.value}
								className={cx(
									'ss-motion relative flex items-start gap-3 rounded-card border p-3.5',
									'has-[:checked]:border-primary has-[:checked]:bg-primary-soft/60 has-[:checked]:shadow-card',
									'has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-primary/20',
									off ? 'border-line-soft opacity-60' : 'border-line hover:border-line-strong',
								)}>
								{input}
								<div className="min-w-0 space-y-0.5">
									<label
										htmlFor={optionId}
										className="cursor-pointer text-sm leading-5 font-medium text-fg after:absolute after:inset-0 after:rounded-card after:content-['']">
										{o.label}
									</label>
									{o.description ? (
										<p id={`${optionId}-description`} className="text-xs leading-relaxed text-muted">
											{o.description}
										</p>
									) : null}
								</div>
							</div>
						);
					return (
						<div key={o.value} className="flex items-start gap-2.5">
							{input}
							<div className="min-w-0">
								<label htmlFor={optionId} className="cursor-pointer text-sm leading-[18px] text-fg">
									{o.label}
								</label>
								{o.description ? (
									<p id={`${optionId}-description`} className="mt-0.5 text-xs leading-relaxed text-muted">
										{o.description}
									</p>
								) : null}
							</div>
						</div>
					);
				})}
			</div>
		</ChoiceGroup>
	);
}

/**
 * A few exclusive choices as one pill-shaped control (up to about four short ones; more belong in a {@link Select}).
 * Native radios underneath, so the arrow keys, forms and screen readers work as for any radio group. In a
 * {@link SettingsCard} it is a setting row.
 * @param {{ legend: ReactNode, name?: string, options: Option[], value: string | null | undefined,
 *   onChange: (value: string) => void, help?: ReactNode, error?: ReactNode, disabled?: boolean, block?: boolean,
 *   className?: string, wide?: boolean, layout?: 'stack' | 'row', hideLegend?: boolean }} props `block`: the
 *   segments share the whole width
 */
export function SegmentedControl({
	legend,
	name,
	options,
	value,
	onChange,
	help,
	error,
	disabled = false,
	block = false,
	className,
	wide,
	layout,
	hideLegend = false,
}) {
	const ids = useFieldIds(undefined);
	const groupName = name ?? ids.id;
	return (
		<ChoiceGroup
			legend={hideLegend ? <span className="sr-only">{legend}</span> : legend}
			ids={ids}
			help={help}
			error={error}
			disabled={disabled}
			wide={wide}
			layout={layout}
			className={className}
			onKeyDown={radioKeys(options, value, onChange)}>
			<div
				className={cx(
					'max-w-full flex-wrap gap-0.5 rounded-control border border-line-soft bg-surface-2 p-0.5',
					block ? 'flex w-full' : 'inline-flex',
				)}>
				{options.map((o) => {
					const optionId = `${ids.id}-${o.value}`;
					return (
						<label
							key={o.value}
							htmlFor={optionId}
							className={cx(
								'relative min-w-0',
								block && 'flex-1',
								disabled || o.disabled ? 'opacity-50' : 'cursor-pointer',
							)}>
							<input
								id={optionId}
								type="radio"
								name={groupName}
								value={o.value}
								checked={value === o.value}
								disabled={disabled || o.disabled}
								onChange={() => onChange(o.value)}
								className="peer sr-only"
							/>
							<span
								className={cx(
									'ss-motion flex h-7 items-center justify-center gap-1.5 rounded-md px-3 text-label font-medium whitespace-nowrap text-muted',
									'hover:text-fg peer-checked:bg-surface peer-checked:text-fg peer-checked:shadow-card',
									'peer-focus-visible:outline-2 peer-focus-visible:outline-focus',
								)}>
								{o.icon ? <Icon name={o.icon} size={14} /> : null}
								{o.label}
							</span>
						</label>
					);
				})}
			</div>
		</ChoiceGroup>
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
 * A text field that suggests values while the merchant may type their own (fixed-choices audit K3: "pick one or type
 * your own"): an {@link Input} with the suggestions as the browser's list.
 * @param {Parameters<typeof Input>[0] & { suggestions: readonly string[] }} props
 */
export function SuggestInput({ suggestions, id, ...rest }) {
	const own = useId();
	const listId = `${id ?? own}-suggestions`;
	return (
		<>
			<Input {...(id ? { id } : {})} {...rest} list={listId} autoComplete="off" />
			<datalist id={listId}>
				{suggestions.map((suggestion) => (
					<option key={suggestion} value={suggestion} />
				))}
			</datalist>
		</>
	);
}

/**
 * A long list of choices (countries, languages …) for a list value: the chosen ones as chips that remove themselves,
 * a search box, and a scrolling list of checkboxes filtered by it (by label or value; the value shows beside a label
 * that differs). A new choice is added at the end, so the list keeps the order it was picked in. With `allowOwn`
 * the options are suggestions: what is typed in the search box is added as the merchant's own value (`addOwnLabel`).
 * @param {{ legend: ReactNode, options: Option[], value: readonly string[], onChange: (value: string[]) => void,
 *   help?: ReactNode, error?: ReactNode, disabled?: boolean, emptyText?: ReactNode,
 *   searchLabel?: string, noMatchText?: ReactNode, removeLabel?: string, className?: string, wide?: boolean,
 *   allowOwn?: boolean, addOwnLabel?: (text: string) => string }} props
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
	allowOwn = false,
	addOwnLabel = (text) => `Add “${text}”`,
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
	const typed = query.trim().replace(/\s+/g, ' ');
	const canAdd =
		allowOwn &&
		typed !== '' &&
		![...options.map((o) => o.value), ...value].some((known) => known.toLowerCase() === typed.toLowerCase());
	const addOwn = () => {
		if (!canAdd) return;
		onChange([...value, typed]);
		setQuery('');
	};
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
					onKeyDown={(e) => {
						if (e.key === 'Enter' && canAdd) {
							e.preventDefault();
							addOwn();
						}
					}}
					className="h-9 w-full border-b border-line-soft bg-transparent px-3 text-sm text-fg placeholder:text-muted/70 focus:outline-none"
				/>
				<div className="max-h-56 overflow-y-auto p-1">
					{canAdd ? (
						<button
							type="button"
							onClick={addOwn}
							className="ss-motion flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm font-medium text-primary hover:bg-surface-2">
							<Icon name="plus" size={14} />
							{addOwnLabel(typed)}
						</button>
					) : null}
					{shown.length === 0 && !canAdd ? (
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
