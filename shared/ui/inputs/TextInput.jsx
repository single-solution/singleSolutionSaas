import React from 'react';
export { Label } from './Label';

export function TextInput({ className = '', ...props }) {
	return (
		<input
			type="text"
			className={`w-full px-3.5 py-2 rounded-xl bg-zinc-50 border border-zinc-200 text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none focus:border-zinc-900 transition-colors ${className}`}
			{...props}
		/>
	);
}

export const Input = TextInput;
