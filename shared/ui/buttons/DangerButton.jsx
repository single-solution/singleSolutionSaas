import React from 'react';

export function DangerButton({ children, size = 'md', className = '', ...props }) {
	const sizes = {
		sm: 'px-3 py-1.5 text-xs',
		md: 'px-4 py-2 text-xs',
		lg: 'px-5 py-2.5 text-sm',
	};
	return (
		<button
			className={`inline-flex items-center justify-center font-semibold rounded-xl bg-rose-50 hover:bg-rose-100 active:bg-rose-200 text-rose-700 border border-rose-200 transition-all duration-150 active:scale-[0.98] cursor-pointer gap-2 shrink-0 ${sizes[size] || sizes.md} ${className}`}
			{...props}>
			{children}
		</button>
	);
}
