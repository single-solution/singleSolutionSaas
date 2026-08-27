import React from 'react';
export { StatCard } from './StatCard';

export function Card({ title, subtitle, action, actions, children, className = '' }) {
	const displayAction = action || actions;
	return (
		<div
			className={`w-full p-6 rounded-2xl bg-white border border-slate-200/80 shadow-xs hover:shadow-sm hover:border-slate-300 transition-all duration-200 space-y-5 ${className}`}>
			{(title || displayAction) && (
				<div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-100">
					<div>
						{title && <h3 className="font-bold text-sm text-slate-900">{title}</h3>}
						{subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
					</div>
					{displayAction && <div>{displayAction}</div>}
				</div>
			)}
			{children}
		</div>
	);
}

export const FloatingCard = Card;
