import React from 'react';

export function Header({ leftContent, rightContent, children }) {
	return (
		<header className="w-full rounded-2xl bg-white border border-slate-200/80 shadow-xs px-5 py-3.5 flex flex-wrap items-center justify-between gap-4 sticky top-4 z-30 transition-all duration-200">
			{leftContent && <div className="flex items-center gap-3">{leftContent}</div>}
			{children}
			{rightContent && <div className="flex items-center gap-3">{rightContent}</div>}
		</header>
	);
}

export const FloatingHeader = Header;
export const FloatingHeaderIsland = Header;
