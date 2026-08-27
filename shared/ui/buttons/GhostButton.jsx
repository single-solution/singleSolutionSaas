import React from 'react';

export function GhostButton({ children, size = 'md', className = '', ...props }) {
	const sizes = {
		sm: 'px-3 py-1.5 text-xs',
		md: 'px-4 py-2 text-xs',
		lg: 'px-5 py-2.5 text-sm',
	};
	return (
		<button
			className={`inline-flex items-center justify-center font-semibold rounded-xl text-slate-600 hover:text-slate-900 hover:bg-slate-100/80 active:bg-slate-200 transition-all duration-150 active:scale-[0.98] cursor-pointer gap-2 shrink-0 ${sizes[size] || sizes.md} ${className}`}
			{...props}>
			{children}
		</button>
	);
}
