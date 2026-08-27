import React from 'react';

export function IconButton({ icon: Icon, children, size = 'md', className = '', ...props }) {
	const sizes = {
		sm: 'p-1.5 rounded-lg',
		md: 'p-2 rounded-xl',
		lg: 'p-2.5 rounded-xl',
	};
	return (
		<button
			className={`inline-flex items-center justify-center text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 transition-colors cursor-pointer shrink-0 ${sizes[size] || sizes.md} ${className}`}
			{...props}>
			{Icon && (React.isValidElement(Icon) ? Icon : <Icon size={16} />)}
			{children}
		</button>
	);
}
