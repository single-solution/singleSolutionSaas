'use client';
/**
 * Monospace value with a copy button — used for snippets and for secrets shown exactly once (`secret`: a warning
 * that the value will not be shown again; the value is never persisted by the component).
 * @module
 */
import { useEffect, useState } from 'react';
import { Button } from './Button.js';
import { cx } from './cx.js';
import { Icon } from './icons.js';

/**
 * Copy text to the clipboard; falls back to a hidden textarea when the async API is unavailable.
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export const copyText = async (text) => {
	try {
		if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// fall through to the textarea copy
	}
	if (typeof document === 'undefined') return false;
	const area = document.createElement('textarea');
	area.value = text;
	area.setAttribute('readonly', '');
	area.style.position = 'fixed';
	area.style.opacity = '0';
	document.body.appendChild(area);
	area.select();
	let ok = false;
	try {
		ok = typeof document.execCommand === 'function' && document.execCommand('copy');
	} catch {
		ok = false;
	}
	area.remove();
	return ok;
};

/**
 * @param {{ code: string, label?: string, secret?: boolean, wrap?: boolean, className?: string }} props
 */
export function CodeBlock({ code, label, secret = false, wrap = true, className }) {
	const [copied, setCopied] = useState(/** @type {null | boolean} */ (null));
	const [prevCode, setPrevCode] = useState(code);

	if (code !== prevCode) {
		setPrevCode(code);
		setCopied(null);
	}

	useEffect(() => {
		if (copied !== true) return undefined;
		const timer = setTimeout(() => {
			setCopied(null);
		}, 2000);
		return () => clearTimeout(timer);
	}, [copied, code]);

	const copy = async () => setCopied(await copyText(code));
	return (
		<div className={cx('space-y-2', className)}>
			{label ? <p className="text-label font-medium text-fg">{label}</p> : null}
			<div className="flex items-start gap-2 rounded-control border border-line bg-surface-2 p-3">
				<pre
					className={cx(
						'min-w-0 flex-1 font-mono text-xs leading-relaxed text-fg',
						wrap ? 'whitespace-pre-wrap break-all' : 'overflow-x-auto',
					)}
					tabIndex={0}
					aria-label={label ?? 'Code'}>
					<code>{code}</code>
				</pre>
				<Button
					size="sm"
					variant="secondary"
					icon={<Icon name={copied ? 'check' : 'copy'} size={13} />}
					onClick={() => void copy()}>
					{copied ? 'Copied' : 'Copy'}
				</Button>
			</div>
			<p className="sr-only" aria-live="polite">
				{copied === true
					? 'Copied to the clipboard.'
					: copied === false
						? 'Copy failed. Select the text and copy it manually.'
						: ''}
			</p>
			{secret ? (
				<p className="flex items-center gap-1.5 text-xs font-medium text-warning">
					<Icon name="alert" size={12} />
					Copy it now — it is shown only once and cannot be displayed again.
				</p>
			) : null}
		</div>
	);
}
