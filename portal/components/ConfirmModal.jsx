import React from 'react';
import { AlertTriangle, X } from 'lucide-react';

export default function ConfirmModal({
	isOpen,
	onClose,
	onConfirm,
	title,
	message,
	confirmText = 'Confirm',
	confirmStyle = 'danger',
}) {
	if (!isOpen) return null;

	const confirmColors = {
		danger: 'bg-rose-600 hover:bg-rose-700 text-white',
		primary: 'bg-indigo-600 hover:bg-indigo-700 text-white',
		warning: 'bg-amber-600 hover:bg-amber-700 text-white',
	};

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-fade-in">
			<div className="w-full max-w-sm bg-white rounded-2xl border border-slate-200 shadow-2xl p-6 space-y-4 animate-scale-in">
				<div className="flex items-start justify-between">
					<div
						className={`p-2 rounded-xl ${confirmStyle === 'danger' ? 'bg-rose-100 text-rose-600' : 'bg-indigo-100 text-indigo-600'}`}>
						<AlertTriangle size={24} />
					</div>
					<button onClick={onClose} className="text-slate-400 hover:text-slate-700 transition-colors">
						<X size={20} />
					</button>
				</div>

				<div className="space-y-2">
					<h3 className="text-lg font-bold text-slate-900">{title}</h3>
					<p className="text-sm text-slate-500">{message}</p>
				</div>

				<div className="flex justify-end gap-2 pt-2">
					<button
						type="button"
						onClick={onClose}
						className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold transition-colors">
						Cancel
					</button>
					<button
						type="button"
						onClick={() => {
							onConfirm();
							onClose();
						}}
						className={`px-4 py-2 rounded-xl font-bold shadow-xs transition-colors ${confirmColors[confirmStyle] || confirmColors.primary}`}>
						{confirmText}
					</button>
				</div>
			</div>
		</div>
	);
}
