import React from 'react';
import { IconSearch } from '../icons/IconSearch';

export function SearchInput({ placeholder = 'Search...', shortcut = '⌘K', className = '', ...props }) {
	return (
		<div
			className={`flex items-center gap-2 px-3 py-1.5 rounded-xl bg-zinc-50 border border-zinc-200 text-xs text-zinc-500 min-w-[200px] focus-within:border-zinc-900 focus-within:bg-white transition-colors ${className}`}>
			<IconSearch size={13} className="text-zinc-400 shrink-0" />
			<input
				type="text"
				placeholder={placeholder}
				className="w-full bg-transparent text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none"
				{...props}
			/>
			{shortcut && (
				<kbd className="ml-auto px-1.5 py-0.5 text-[9px] font-mono bg-white border border-zinc-200 rounded text-zinc-400 shrink-0">
					{shortcut}
				</kbd>
			)}
		</div>
	);
}
