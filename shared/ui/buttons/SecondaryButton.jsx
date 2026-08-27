import React from 'react';

export function SecondaryButton({ children, size = 'md', className = '', ...props }) {
	const sizes = {
		sm: 'px-3 py-1.5 text-xs',
		md: 'px-4 py-2 text-xs',
		lg: 'px-5 py-2.5 text-sm',
	};
	return (
		<button
			className={`inline-flex items-center justify-center font-semibold rounded-xl bg-white hover:bg-slate-50 active:bg-slate-100 text-slate-700 border border-slate-200 shadow-xs hover:border-slate-300 transition-all duration-150 active:scale-[0.98] cursor-pointer gap-2 shrink-0 ${sizes[size] || sizes.md} ${className}`}
			{...props}>
			{children}
		</button>
	);
}
