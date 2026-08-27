import React from 'react';

export function Modal({ isOpen, onClose, title, children, footer, className = '' }) {
	if (!isOpen) return null;

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
			<div className={`w-full max-w-lg rounded-2xl border border-zinc-200 bg-white p-6 shadow-2xl space-y-4 ${className}`}>
				<div className="flex items-center justify-between border-b border-zinc-100 pb-3">
					<h3 className="text-sm font-bold text-zinc-900">{title}</h3>
					<button
						onClick={onClose}
						className="p-1 rounded-md text-zinc-400 hover:text-zinc-600 transition-colors cursor-pointer">
						<span className="text-sm leading-none font-bold">✕</span>
					</button>
				</div>
				<div className="space-y-4">{children}</div>
				{footer && <div className="flex items-center justify-end gap-2 pt-3 border-t border-zinc-100">{footer}</div>}
			</div>
		</div>
	);
}

export const Dialog = Modal;
