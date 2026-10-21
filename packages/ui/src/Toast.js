'use client';
/**
 * Toasts: transient confirmations in a polite live region (errors use an assertive one). Wrap the app in
 * `ToastProvider` and call `useToast().show({ title, description, tone, action, durationMs })`. A toast slides in and
 * fades out when it is dismissed or times out (PLAN 0.6 motion). With `action` ({ label, onClick }) it has one button
 * (Undo, View): a click runs it and closes the toast; `durationMs` keeps this toast longer or shorter than the
 * provider's default. `show` hands back the toast's id (for `dismiss`).
 * @module
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { cx } from './cx.js';
import { Icon } from './icons.js';
import { usePresence } from './motion.js';

/** @typedef {{ label: string, onClick: () => void }} ToastAction */
/** @typedef {{ id: number, title: string, description?: string, tone: 'success' | 'danger' | 'info', action?: ToastAction, leaving?: boolean }} ToastItem */
/**
 * @typedef {{ title: string, description?: string, tone?: 'success' | 'danger' | 'info', action?: ToastAction,
 *   durationMs?: number }} ToastInput
 */
/** @typedef {{ show: (toast: ToastInput) => number, dismiss: (id: number) => void }} ToastApi */
/** @typedef {{ dismiss: string }} ToastTexts */

/** The words a toast says itself (replace them to translate). @type {Readonly<ToastTexts>} */
export const TOAST_TEXTS = Object.freeze({ dismiss: 'Dismiss notification' });

const NOOP = /** @type {ToastApi} */ ({ show: () => 0, dismiss: () => undefined });
const ToastContext = createContext(NOOP);

/** Access the toast API (a no-op outside a provider). */
export const useToast = () => useContext(ToastContext);

/**
 * @param {{ children: import('react').ReactNode, durationMs?: number, texts?: Partial<ToastTexts> }} props
 *   `durationMs`: how long a toast stays (5 s; tests set it longer so a toast stays while they look at it)
 */
export function ToastProvider({ children, durationMs = 5000, texts }) {
	const words = { ...TOAST_TEXTS, ...texts };
	const [items, setItems] = useState(/** @type {ToastItem[]} */ ([]));
	const counter = useRef(0);
	const timers = useRef(/** @type {Map<number, ReturnType<typeof setTimeout>>} */ (new Map()));
	/** Start a toast's exit; it leaves the list once its animation ends (`remove`). */
	const dismiss = useCallback((/** @type {number} */ id) => {
		setItems((list) => list.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
		const timer = timers.current.get(id);
		if (timer) clearTimeout(timer);
		timers.current.delete(id);
	}, []);
	const remove = useCallback((/** @type {number} */ id) => setItems((list) => list.filter((t) => t.id !== id)), []);
	const show = useCallback(
		(/** @type {ToastInput} */ toast) => {
			counter.current += 1;
			const id = counter.current;
			setItems((list) => [
				...list.slice(-3),
				{
					id,
					title: toast.title,
					...(toast.description ? { description: toast.description } : {}),
					tone: toast.tone ?? 'success',
					...(toast.action ? { action: toast.action } : {}),
				},
			]);
			timers.current.set(
				id,
				setTimeout(() => dismiss(id), toast.durationMs ?? durationMs),
			);
			return id;
		},
		[dismiss, durationMs],
	);
	useEffect(() => {
		const map = timers.current;
		return () => {
			for (const timer of map.values()) clearTimeout(timer);
		};
	}, []);
	const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);
	const polite = items.filter((t) => t.tone !== 'danger');
	const urgent = items.filter((t) => t.tone === 'danger');
	return (
		<ToastContext.Provider value={api}>
			{children}
			<div className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:items-end sm:p-6">
				<div aria-live="polite" role="status" className="flex w-full flex-col items-center gap-2 sm:items-end">
					{polite.map((t) => (
						<ToastCard key={t.id} toast={t} words={words} onDismiss={dismiss} onGone={remove} />
					))}
				</div>
				<div aria-live="assertive" role="alert" className="flex w-full flex-col items-center gap-2 sm:items-end">
					{urgent.map((t) => (
						<ToastCard key={t.id} toast={t} words={words} onDismiss={dismiss} onGone={remove} />
					))}
				</div>
			</div>
		</ToastContext.Provider>
	);
}

/**
 * @param {{ toast: ToastItem, words: ToastTexts, onDismiss: (id: number) => void, onGone: (id: number) => void }} props
 */
function ToastCard({ toast, words, onDismiss, onGone }) {
	const presence = usePresence(toast.leaving !== true);
	useEffect(() => {
		if (!presence.mounted) onGone(toast.id);
	}, [presence.mounted, onGone, toast.id]);
	if (!presence.mounted) return null;
	// a toast sits above the page (its shadow is allowed); the tone colors its icon only
	const tone = toast.tone === 'danger' ? 'text-danger' : toast.tone === 'info' ? 'text-info' : 'text-success';
	return (
		<div
			ref={presence.ref}
			data-state={presence.closing ? 'closed' : 'open'}
			className={cx(
				'pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-card border border-line-soft bg-surface px-3.5 py-3 text-sm text-fg shadow-overlay',
				'animate-ss-toast data-[state=closed]:pointer-events-none data-[state=closed]:animate-ss-toast-out',
			)}>
			<Icon
				name={toast.tone === 'danger' ? 'alert' : toast.tone === 'info' ? 'info' : 'check'}
				size={16}
				className={cx('mt-0.5 shrink-0', tone)}
			/>
			<div className="min-w-0 flex-1">
				<p className="font-medium">{toast.title}</p>
				{toast.description ? <p className="mt-0.5 break-words text-help text-muted">{toast.description}</p> : null}
			</div>
			{toast.action ? (
				<button
					type="button"
					onClick={() => {
						toast.action?.onClick();
						onDismiss(toast.id);
					}}
					className="ss-motion ss-press shrink-0 rounded px-1.5 py-0.5 text-label font-medium text-primary hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-focus">
					{toast.action.label}
				</button>
			) : null}
			<button
				type="button"
				onClick={() => onDismiss(toast.id)}
				aria-label={words.dismiss}
				className="ss-motion ss-press rounded p-0.5 text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-focus">
				<Icon name="close" size={14} />
			</button>
		</div>
	);
}

/**
 * Shows one toast when it appears, and again whenever `trigger` changes (a new save result); it draws nothing in the
 * page. For "Saved" after a write (owner 2026-10-17: no Saved banners).
 * @param {{ title: string, description?: string, tone?: 'success' | 'danger' | 'info', trigger?: unknown }} props
 */
export function ToastOnce({ title, description, tone = 'success', trigger }) {
	const toast = useToast();
	const shown = useRef(/** @type {{ value: unknown } | null} */ (null));
	useEffect(() => {
		if (shown.current && shown.current.value === trigger) return;
		shown.current = { value: trigger };
		toast.show({ title, tone, ...(description ? { description } : {}) });
	}, [trigger, title, description, tone, toast]);
	return null;
}
