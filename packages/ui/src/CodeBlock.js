'use client';
/**
 * Monospace value with a copy button — used for snippets and for secrets shown exactly once (`secret`: a warning
 * that the value will not be shown again; the value is never persisted by the component).
 * @module
 */
import { useState } from 'react';
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
 * @param {{ code: string, label?: string, secret?: boolean, wrap?: boolean, className?: string,
 *   onCopy?: (ok: boolean) => void }} props
 */
export function CodeBlock({ code, label, secret = false, wrap = true, className, onCopy }) {
	const [copied, setCopied] = useState(/** @type {null | boolean} */ (null));
	const copy = async () => {
		const ok = await copyText(code);
		setCopied(ok);
		onCopy?.(ok);
	};
	return (
		<div className={cx('space-y-2', className)}>
			{label ? <p className="text-xs font-semibold uppercase tracking-wider text-muted">{label}</p> : null}
			<div className="flex items-start gap-2 rounded-2xl bg-surface-2 p-3.5">
				<pre
					className={cx(
						'min-w-0 flex-1 font-mono text-xs leading-relaxed text-fg',
						wrap ? 'whitespace-pre-wrap break-all' : 'overflow-x-auto',
					)}
					tabIndex={0}
					aria-label={label ?? 'Code'}>
					<code>{code}</code>
				</pre>
				<button
					type="button"
					onClick={copy}
					className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-surface px-2 py-1 text-xs font-semibold text-fg hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-focus">
					<Icon name={copied ? 'check' : 'copy'} size={13} />
					{copied ? 'Copied' : 'Copy'}
				</button>
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
