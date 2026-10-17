'use client';
/**
 * Overlays (redesign 2, owner 2026-10-17: editing opens in a RIGHT DRAWER that keeps the page in view; modals only for
 * short confirmations): `role="dialog"` + `aria-modal`, labeled by its title, traps focus (Tab / Shift+Tab cycle
 * inside), close on Escape and on backdrop click, lock page scroll, and restore focus to the element that opened them.
 * A drawer slides in from the right (the whole screen on phones); a centered dialog scales in (a bottom sheet on
 * phones); both animate out when they close (PLAN 0.6 motion).
 * @module
 */
import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './Button.js';
import { cx } from './cx.js';
import { FieldLayoutContext } from './fields.js';
import { Icon } from './icons.js';
import { usePresence } from './motion.js';

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
 *   footer?: ReactNode, size?: 'sm' | 'md' | 'lg', closeLabel?: string, dismissible?: boolean,
 *   placement?: 'right' | 'center' }} OverlayProps
 */

/**
 * An overlay that holds an edit or a short task: a right drawer (`md` 32 rem, `lg` 42 rem wide) or, for `sm` and with
 * `placement="center"`, a centered dialog (a bottom sheet on phones) for a short confirmation or a link to copy. The
 * footer (its buttons) stays at the bottom while the content scrolls.
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
	placement,
}) {
	const ref = useRef(/** @type {HTMLDivElement | null} */ (null));
	const titleId = useId();
	const descriptionId = useId();
	const close = () => {
		if (dismissible) onClose();
	};
	const presence = usePresence(open);
	useFocusTrap(ref, open, close);
	if (!presence.mounted) return null;
	const side = (placement ?? (size === 'sm' ? 'center' : 'right')) === 'right';
	const width = side
		? size === 'lg'
			? 'sm:max-w-[42rem]'
			: 'sm:max-w-[32rem]'
		: size === 'sm'
			? 'max-w-md'
			: size === 'lg'
				? 'max-w-3xl'
				: 'max-w-xl';
	const panel = (
		<div
			ref={presence.ref}
			data-state={presence.closing ? 'closed' : 'open'}
			data-placement={side ? 'right' : 'center'}
			className={cx(
				'group fixed inset-0 z-50 flex bg-overlay',
				side ? 'justify-end p-0 sm:p-3' : 'items-end justify-center p-0 sm:items-center sm:p-4',
				'animate-ss-fade data-[state=closed]:pointer-events-none data-[state=closed]:animate-ss-fade-out',
			)}
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
					'flex w-full flex-col border-line-soft bg-surface text-fg shadow-overlay focus:outline-none',
					side
						? 'h-full animate-ss-side group-data-[state=closed]:animate-ss-side-out sm:rounded-panel sm:border'
						: cx(
								'max-h-[92vh] rounded-t-card border sm:rounded-card',
								'animate-ss-sheet group-data-[state=closed]:animate-ss-sheet-out sm:animate-ss-pop sm:group-data-[state=closed]:animate-ss-pop-out',
							),
					width,
				)}>
				<div className={cx('flex items-start justify-between gap-4 px-6 pt-6', side ? 'pb-4' : 'pb-1')}>
					<div className="min-w-0">
						<h2 id={titleId} className="text-lead font-semibold tracking-[-0.01em] text-fg">
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
							className="ss-motion ss-press rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-focus">
							<Icon name="close" size={16} />
						</button>
					) : null}
				</div>
				<div className={cx('ss-scroll min-h-0 flex-1 space-y-4 px-6', side ? 'pt-1 pb-6' : 'py-4')}>
					<FieldLayoutContext.Provider value="stack">{children}</FieldLayoutContext.Provider>
				</div>
				{footer ? (
					<div className="flex flex-wrap items-center justify-end gap-2 border-t border-line-soft px-6 py-4">{footer}</div>
				) : null}
			</div>
		</div>
	);
	return typeof document === 'undefined' ? panel : createPortal(panel, document.body);
}

/**
 * The right drawer for editing one thing (an order, a product, a connection, a list item) while the page stays in view:
 * a {@link Dialog} on the right.
 * @param {OverlayProps} props
 */
export function Drawer(props) {
	return <Dialog {...props} placement="right" />;
}

/**
 * Confirmation dialog for destructive or irreversible actions. Focus starts on the action that is safe: Cancel when `danger`
 * is set, the confirm button otherwise.
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
					<Button variant="secondary" onClick={onClose} disabled={busy} data-autofocus={danger ? '' : undefined}>
						{cancelLabel}
					</Button>
					<Button
						variant={danger ? 'danger' : 'primary'}
						onClick={onConfirm}
						loading={busy}
						data-autofocus={danger ? undefined : ''}>
						{confirmLabel}
					</Button>
				</>
			}>
			{children}
			{error ? (
				<p role="alert" className="animate-ss-shake text-sm font-medium text-danger">
					{error}
				</p>
			) : null}
		</Dialog>
	);
}
