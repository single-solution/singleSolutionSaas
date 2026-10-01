'use client';
/**
 * Toasts: transient confirmations in a polite live region (errors use an assertive one). Wrap the app in
 * `ToastProvider` and call `useToast().show({ title, description, tone })`.
 * @module
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { cx } from './cx.js';
import { Icon } from './icons.js';

/** @typedef {{ id: number, title: string, description?: string, tone: 'success' | 'danger' | 'info' }} ToastItem */
/** @typedef {{ show: (toast: { title: string, description?: string, tone?: 'success' | 'danger' | 'info', durationMs?: number }) => void, dismiss: (id: number) => void }} ToastApi */

const NOOP = /** @type {ToastApi} */ ({ show: () => undefined, dismiss: () => undefined });
const ToastContext = createContext(NOOP);

/** Access the toast API (a no-op outside a provider). */
export const useToast = () => useContext(ToastContext);

/**
 * @param {{ children: import('react').ReactNode, durationMs?: number }} props
 */
export function ToastProvider({ children, durationMs = 5000 }) {
	const [items, setItems] = useState(/** @type {ToastItem[]} */ ([]));
	const counter = useRef(0);
	const timers = useRef(/** @type {Map<number, ReturnType<typeof setTimeout>>} */ (new Map()));
	const dismiss = useCallback((/** @type {number} */ id) => {
		setItems((list) => list.filter((t) => t.id !== id));
		const timer = timers.current.get(id);
		if (timer) clearTimeout(timer);
		timers.current.delete(id);
	}, []);
	const show = useCallback(
		(/** @type {Parameters<ToastApi['show']>[0]} */ toast) => {
			counter.current += 1;
			const id = counter.current;
			setItems((list) => [
				...list.slice(-3),
				{
					id,
					title: toast.title,
					...(toast.description ? { description: toast.description } : {}),
					tone: toast.tone ?? 'success',
				},
			]);
			timers.current.set(
				id,
				setTimeout(() => dismiss(id), toast.durationMs ?? durationMs),
			);
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
			<div className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:items-end">
				<div aria-live="polite" role="status" className="flex w-full flex-col items-center gap-2 sm:items-end">
					{polite.map((t) => (
						<ToastCard key={t.id} toast={t} onDismiss={dismiss} />
					))}
				</div>
				<div aria-live="assertive" role="alert" className="flex w-full flex-col items-center gap-2 sm:items-end">
					{urgent.map((t) => (
						<ToastCard key={t.id} toast={t} onDismiss={dismiss} />
					))}
				</div>
			</div>
		</ToastContext.Provider>
	);
}

/**
 * @param {{ toast: ToastItem, onDismiss: (id: number) => void }} props
 */
function ToastCard({ toast, onDismiss }) {
	const tone =
		toast.tone === 'danger'
			? 'bg-danger-soft text-on-danger-soft'
			: toast.tone === 'info'
				? 'bg-info-soft text-on-info-soft'
				: 'bg-success-soft text-on-success-soft';
	return (
		<div
			className={cx(
				'pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border border-line px-4 py-3 text-sm shadow-overlay',
				tone,
			)}>
			<Icon name={toast.tone === 'danger' ? 'alert' : toast.tone === 'info' ? 'info' : 'check'} size={16} className="mt-0.5" />
			<div className="min-w-0 flex-1">
				<p className="font-semibold">{toast.title}</p>
				{toast.description ? <p className="mt-0.5 break-words">{toast.description}</p> : null}
			</div>
			<button
				type="button"
				onClick={() => onDismiss(toast.id)}
				aria-label="Dismiss notification"
				className="rounded p-0.5 opacity-80 hover:opacity-100 focus-visible:outline-2 focus-visible:outline-focus">
				<Icon name="close" size={14} />
			</button>
		</div>
	);
}
