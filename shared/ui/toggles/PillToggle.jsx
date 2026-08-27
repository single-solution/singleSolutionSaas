import React from 'react';

export function PillToggle({ options = [], value, onChange, className = '' }) {
	return (
		<div className={`flex items-center p-0.5 rounded-xl bg-zinc-100 border border-zinc-200 text-xs ${className}`}>
			{options.map((opt) => (
				<button
					key={opt.value}
					type="button"
					onClick={() => onChange && onChange(opt.value)}
					className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
						value === opt.value ? 'bg-white text-zinc-950 shadow-xs' : 'text-zinc-500 hover:text-zinc-900'
					}`}>
					{opt.label}
				</button>
			))}
		</div>
	);
}
