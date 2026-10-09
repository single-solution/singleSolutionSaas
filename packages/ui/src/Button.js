'use client';
/**
 * Buttons. A button whose `onClick` returns a promise (an `async` handler calling the server) shows its spinner and
 * stays disabled until the promise settles, and a submit button shows the busy state of its `Form`: every button that
 * saves or calls the server gives immediate feedback without wiring `loading` by hand (PLAN 0.6 motion).
 * @module
 */
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { cx } from './cx.js';
import { Spinner } from './Spinner.js';

/** The busy state of the enclosing form (`Form` sets it while its submit runs); its submit buttons show it. */
export const FormBusyContext = createContext(false);

/** @typedef {'primary' | 'secondary' | 'ghost' | 'danger' | 'soft'} ButtonVariant */
/** @typedef {'sm' | 'md' | 'lg'} ButtonSize */

const BASE =
	'inline-flex shrink-0 items-center justify-center gap-2 rounded-xl font-semibold ss-motion ss-press select-none ' +
	'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-60 ' +
	'aria-disabled:cursor-not-allowed aria-disabled:opacity-60';

/** @type {Record<ButtonVariant, string>} */
const VARIANTS = {
	primary: 'bg-primary text-on-primary hover:bg-primary-hover',
	secondary: 'bg-surface-2 text-fg hover:bg-surface-3',
	ghost: 'text-fg hover:bg-surface-2',
	danger: 'bg-danger text-on-danger hover:bg-danger-hover',
	soft: 'bg-primary-soft text-on-primary-soft hover:bg-surface-2',
};

/** @type {Record<ButtonSize, string>} */
const SIZES = {
	sm: 'min-h-8 px-3 py-1.5 text-xs',
	md: 'min-h-10 px-4 py-2 text-sm',
	lg: 'min-h-11 px-5 py-2.5 text-sm',
};

/**
 * Class names of a button look (for links styled as buttons).
 * @param {{ variant?: ButtonVariant, size?: ButtonSize, block?: boolean, className?: string }} [options]
 */
const buttonClass = ({ variant = 'primary', size = 'md', block = false, className } = {}) =>
	cx(BASE, VARIANTS[variant], SIZES[size], block && 'w-full', className);

/**
 * @typedef {import('react').ButtonHTMLAttributes<HTMLButtonElement> & {
 *   variant?: ButtonVariant, size?: ButtonSize, loading?: boolean, block?: boolean, icon?: import('react').ReactNode,
 *   ref?: import('react').Ref<HTMLButtonElement>
 * }} ButtonProps
 */

/**
 * Button. `loading` (or an `onClick` promise still running, or a submit button of a busy `Form`) keeps the label (for
 * screen readers), shows a spinner (it fades in) and blocks clicks (`aria-busy`). Every button tints on hover and
 * presses in a little when clicked (PLAN 0.6 motion).
 * @param {ButtonProps} props
 */
export function Button({
	variant = 'primary',
	size = 'md',
	loading = false,
	block = false,
	icon,
	type = 'button',
	className,
	disabled,
	children,
	onClick,
	...rest
}) {
	const formBusy = useContext(FormBusyContext);
	const [running, setRunning] = useState(false);
	const live = useRef(true);
	useEffect(() => {
		live.current = true;
		return () => {
			live.current = false;
		};
	}, []);
	const busy = loading || running || (type === 'submit' && formBusy);
	/** @param {import('react').MouseEvent<HTMLButtonElement>} event */
	const click = (event) => {
		const out = /** @type {unknown} */ (onClick?.(event));
		if (!out || typeof (/** @type {{ then?: unknown }} */ (out).then) !== 'function') return;
		setRunning(true);
		const done = () => {
			if (live.current) setRunning(false);
		};
		/** @type {Promise<unknown>} */ (out).then(done, done);
	};
	return (
		<button
			type={type}
			className={buttonClass({ variant, size, block, ...(className ? { className } : {}) })}
			disabled={disabled || busy}
			aria-busy={busy || undefined}
			onClick={onClick ? click : undefined}
			{...rest}>
			{busy ? <Spinner size={14} className="animate-ss-fade" /> : icon}
			{children}
		</button>
	);
}

/**
 * Icon-only button: `label` is required (accessible name and tooltip).
 * @param {ButtonProps & { label: string }} props
 */
export function IconButton({ label, variant = 'ghost', size = 'sm', className, children, ...rest }) {
	return (
		<Button variant={variant} size={size} aria-label={label} title={label} className={cx('!px-2', className)} {...rest}>
			{children}
		</Button>
	);
}

/**
 * A link that looks like a button. `as` renders a router link component (e.g. Next's `Link`).
 * @param {import('react').AnchorHTMLAttributes<HTMLAnchorElement> & { href: string, variant?: ButtonVariant,
 *   size?: ButtonSize, block?: boolean, as?: import('react').ElementType, icon?: import('react').ReactNode }} props
 */
export function ButtonLink({ variant = 'secondary', size = 'md', block = false, as, className, icon, children, ...rest }) {
	const Component = as ?? 'a';
	return (
		<Component className={buttonClass({ variant, size, block, ...(className ? { className } : {}) })} {...rest}>
			{icon}
			{children}
		</Component>
	);
}
