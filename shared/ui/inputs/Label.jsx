import React from 'react';

export function Label({ children, className = '', ...props }) {
	return (
		<label className={`block text-[11px] font-bold uppercase tracking-wider text-zinc-400 mb-1.5 ${className}`} {...props}>
			{children}
		</label>
	);
}
