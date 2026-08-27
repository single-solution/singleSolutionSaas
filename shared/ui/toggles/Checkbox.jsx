import React from 'react';
import { IconCheck } from '../icons/IconCheck';

export function Checkbox({ checked, onChange, label, disabled = false, className = '' }) {
	return (
		<label
			className={`inline-flex items-center gap-2 cursor-pointer select-none ${disabled ? 'opacity-50 cursor-not-allowed' : ''} ${className}`}>
			<div className="relative flex items-center justify-center">
				<input
					type="checkbox"
					checked={checked}
					onChange={(e) => onChange && onChange(e.target.checked)}
					disabled={disabled}
					className="sr-only"
				/>
				<div
					className={`w-4 h-4 rounded-md border transition-colors flex items-center justify-center ${
						checked ? 'bg-zinc-950 border-zinc-950 text-white' : 'bg-white border-zinc-300 text-transparent'
					}`}>
					<IconCheck size={11} className={checked ? 'opacity-100' : 'opacity-0'} />
				</div>
			</div>
			{label && <span className="text-xs font-medium text-zinc-700">{label}</span>}
		</label>
	);
}
