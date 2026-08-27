import React from 'react';

export function Switch({ checked, onChange, label, disabled = false, className = '' }) {
	return (
		<label
			className={`inline-flex items-center gap-2.5 cursor-pointer select-none ${disabled ? 'opacity-50 cursor-not-allowed' : ''} ${className}`}>
			<div className="relative">
				<input
					type="checkbox"
					checked={checked}
					onChange={(e) => onChange && onChange(e.target.checked)}
					disabled={disabled}
					className="sr-only"
				/>
				<div className={`w-9 h-5 rounded-full transition-colors ${checked ? 'bg-zinc-950' : 'bg-zinc-200'}`} />
				<div
					className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-xs transition-transform transform ${
						checked ? 'translate-x-4' : 'translate-x-0'
					}`}
				/>
			</div>
			{label && <span className="text-xs font-semibold text-zinc-700">{label}</span>}
		</label>
	);
}
