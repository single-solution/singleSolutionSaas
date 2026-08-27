import React from 'react';

export function Select({ className = '', children, ...props }) {
	return (
		<select
			className={`w-full px-3.5 py-2 rounded-xl bg-zinc-50 border border-zinc-200 text-xs text-zinc-900 focus:outline-none focus:border-zinc-900 transition-colors ${className}`}
			{...props}>
			{children}
		</select>
	);
}

export const Dropdown = Select;
