'use client';
/**
 * Form helpers: `Form` (no native submission, async `onSubmit` with a busy flag; its children are laid out in the
 * responsive field grid of fields.js, so short controls sit side by side and everything else spans the row; inside a
 * `SettingsCard` they are setting rows divided by hairlines instead) and
 * `FormError` (a problem document as a friendly callout).
 * @module
 */
import { useContext, useEffect, useRef, useState } from 'react';
import { FormBusyContext } from './Button.js';
import { cx } from './cx.js';
import { Callout } from './display.js';
import { FIELD_GRID, FieldLayoutContext, ROW_LIST } from './fields.js';
import { describeProblem, fieldErrors } from './problems.js';

/** @typedef {import('./problems.js').Problem} Problem */

/**
 * A form that never submits natively. While `busy`, or while the promise its `onSubmit` returned runs, a second submit
 * is ignored and its submit buttons show their spinner.
 * @param {Omit<import('react').FormHTMLAttributes<HTMLFormElement>, 'onSubmit'> & {
 *   onSubmit: (event: import('react').FormEvent<HTMLFormElement>) => unknown | Promise<unknown>,
 *   busy?: boolean }} props
 */
export function Form({ onSubmit, busy: busyProp = false, className, children, ...rest }) {
	const rows = useContext(FieldLayoutContext) === 'row';
	const [running, setRunning] = useState(false);
	const live = useRef(true);
	useEffect(() => {
		live.current = true;
		return () => {
			live.current = false;
		};
	}, []);
	const busy = busyProp || running;
	return (
		<form
			noValidate
			aria-busy={busy || undefined}
			className={cx('@container min-w-0', className)}
			onSubmit={(event) => {
				event.preventDefault();
				if (busy) return;
				const out = /** @type {unknown} */ (onSubmit(event));
				if (!out || typeof (/** @type {{ then?: unknown }} */ (out).then) !== 'function') return;
				setRunning(true);
				const done = () => {
					if (live.current) setRunning(false);
				};
				/** @type {Promise<unknown>} */ (out).then(done, done);
			}}
			{...rest}>
			<FormBusyContext.Provider value={busy}>
				<div className={rows ? ROW_LIST : FIELD_GRID}>{children}</div>
			</FormBusyContext.Provider>
		</form>
	);
}

/**
 * Friendly message of a problem (plus field errors that match no field).
 * @param {{ problem: Problem | null | undefined, title?: string, fields?: string[], className?: string }} props
 */
export function FormError({ problem, title, fields = [], className }) {
	if (!problem) return null;
	const known = new Set(fields);
	const other = Object.entries(fieldErrors(problem)).filter(([name]) => !known.has(name) && name !== '_form');
	return (
		<Callout tone="danger" {...(title ? { title } : {})} {...(className ? { className } : {})}>
			<p>{describeProblem(problem)}</p>
			{other.length > 0 ? (
				<ul className="mt-1 list-disc pl-5">
					{other.map(([name, message]) => (
						<li key={name}>
							<span className="font-mono text-xs">{name}</span>: {message}
						</li>
					))}
				</ul>
			) : null}
		</Callout>
	);
}
