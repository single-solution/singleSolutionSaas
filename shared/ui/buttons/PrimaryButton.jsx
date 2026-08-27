import React from 'react';

export function PrimaryButton({ children, size = 'md', className = '', ...props }) {
	const sizes = {
		sm: 'px-3 py-1.5 text-xs',
		md: 'px-4 py-2 text-xs',
		lg: 'px-5 py-2.5 text-sm',
	};
	return (
		<button
			className={`inline-flex items-center justify-center font-semibold rounded-xl bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white shadow-xs hover:shadow-sm transition-all duration-150 active:scale-[0.98] cursor-pointer gap-2 shrink-0 ${sizes[size] || sizes.md} ${className}`}
			{...props}>
			{children}
		</button>
	);
}
