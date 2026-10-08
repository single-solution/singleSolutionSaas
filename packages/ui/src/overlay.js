'use client';
/**
 * Modal dialog: `role="dialog"` + `aria-modal`, labelled by its title, traps focus (Tab / Shift+Tab cycle inside), close on Escape and on backdrop click, lock page scroll,
 * and restore focus to the element that opened them.
 * @module
 */
import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './Button.js';
import { cx } from './cx.js';
import { Icon } from './icons.js';

/** @typedef {import('react').ReactNode} ReactNode */

const FOCUSABLE =
	'a[href],area[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),' +
	'textarea:not([disabled]),iframe,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';

/**
 * Focusable descendants in tab order.
 * @param {HTMLElement} root
 * @returns {HTMLElement[]}
 */
const focusableIn = (root) =>
	/** @type {HTMLElement[]} */ ([...root.querySelectorAll(FOCUSABLE)]).filter(
		(el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true',
	);

/**
 * Focus trap + Escape + focus restore for an open overlay.
 * @param {import('react').RefObject<HTMLElement | null>} ref
 * @param {boolean} open
 * @param {() => void} onClose
 */
export const useFocusTrap = (ref, open, onClose) => {
	const close = useRef(onClose);
	close.current = onClose;
	useEffect(() => {
		if (!open) return undefined;
		const root = ref.current;
		if (!root) return undefined;
		const previous = /** @type {HTMLElement | null} */ (root.ownerDocument.activeElement);
		const initial = /** @type {HTMLElement | null} */ (root.querySelector('[data-autofocus]')) ?? focusableIn(root)[0] ?? root;
		initial.focus();
		/** @param {KeyboardEvent} event */
		const onKey = (event) => {
			if (event.key === 'Escape') {
				event.stopPropagation();
				close.current();
				return;
			}
			if (event.key !== 'Tab') return;
			const items = focusableIn(root);
			if (items.length === 0) {
				event.preventDefault();
				root.focus();
				return;
			}
			const first = /** @type {HTMLElement} */ (items[0]);
			const last = /** @type {HTMLElement} */ (items[items.length - 1]);
			const active = root.ownerDocument.activeElement;
			if (event.shiftKey && (active === first || active === root)) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && active === last) {
				event.preventDefault();
				first.focus();
			}
		};
		root.addEventListener('keydown', onKey);
		const body = root.ownerDocument.body;
		const overflow = body.style.overflow;
		body.style.overflow = 'hidden';
		return () => {
			root.removeEventListener('keydown', onKey);
			body.style.overflow = overflow;
			if (previous && typeof previous.focus === 'function') previous.focus();
		};
	}, [open, ref]);
};

/**
 * @typedef {{ open: boolean, onClose: () => void, title: ReactNode, description?: ReactNode, children?: ReactNode,
 *   footer?: ReactNode, size?: 'sm' | 'md' | 'lg', closeLabel?: string, dismissible?: boolean }} OverlayProps
 */

/**
 * Centred modal dialog (bottom sheet on small screens).
 * @param {OverlayProps} props
 */
export function Dialog({
	open,
	onClose,
	title,
	description,
	children,
	footer,
	size = 'md',
	closeLabel = 'Close',
	dismissible = true,
}) {
	const ref = useRef(/** @type {HTMLDivElement | null} */ (null));
	const titleId = useId();
	const descriptionId = useId();
	const close = () => {
		if (dismissible) onClose();
	};
	useFocusTrap(ref, open, close);
	if (!open) return null;
	const width = size === 'sm' ? 'max-w-md' : size === 'lg' ? 'max-w-3xl' : 'max-w-xl';
	const panel = (
		<div
			className="fixed inset-0 z-50 flex items-end justify-center bg-overlay p-0 sm:items-center sm:p-4"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) close();
			}}>
			<div
				ref={ref}
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				aria-describedby={description ? descriptionId : undefined}
				tabIndex={-1}
				className={cx(
					'flex max-h-[92vh] w-full flex-col rounded-t-card bg-surface text-fg focus:outline-none sm:rounded-card',
					width,
				)}>
				<div className="flex items-start justify-between gap-4 px-6 pb-2 pt-5">
					<div className="min-w-0">
						<h2 id={titleId} className="text-base font-bold text-fg">
							{title}
						</h2>
						{description ? (
							<p id={descriptionId} className="mt-1 text-sm text-muted">
								{description}
							</p>
						) : null}
					</div>
					{dismissible ? (
						<button
							type="button"
							onClick={onClose}
							aria-label={closeLabel}
							className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-focus">
							<Icon name="close" size={16} />
						</button>
					) : null}
				</div>
				<div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">{children}</div>
				{footer ? <div className="flex flex-wrap items-center justify-end gap-2 px-6 pb-5 pt-3">{footer}</div> : null}
			</div>
		</div>
	);
	return typeof document === 'undefined' ? panel : createPortal(panel, document.body);
}

/**
 * Confirmation dialog for destructive or irreversible actions.
 * @param {{ open: boolean, onClose: () => void, onConfirm: () => void, title: ReactNode, children?: ReactNode,
 *   confirmLabel?: string, cancelLabel?: string, danger?: boolean, busy?: boolean, error?: ReactNode }} props
 */
export function ConfirmDialog({
	open,
	onClose,
	onConfirm,
	title,
	children,
	confirmLabel = 'Confirm',
	cancelLabel = 'Cancel',
	danger = false,
	busy = false,
	error,
}) {
	return (
		<Dialog
			open={open}
			onClose={busy ? () => undefined : onClose}
			title={title}
			size="sm"
			footer={
				<>
					<Button variant="secondary" onClick={onClose} disabled={busy}>
						{cancelLabel}
					</Button>
					<Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={busy} data-autofocus>
						{confirmLabel}
					</Button>
				</>
			}>
			{children}
			{error ? (
				<p role="alert" className="text-sm font-medium text-danger">
					{error}
				</p>
			) : null}
		</Dialog>
	);
}
