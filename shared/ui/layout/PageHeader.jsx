import React from 'react';

export function PageHeader({ title, subtitle, actions, action }) {
	const displayAction = actions || action;
	return (
		<div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-zinc-100">
			<div>
				<h1 className="text-xl font-bold text-zinc-950 tracking-tight">{title}</h1>
				{subtitle && <p className="text-xs text-zinc-400 mt-0.5">{subtitle}</p>}
			</div>
			{displayAction && <div className="flex items-center gap-2">{displayAction}</div>}
		</div>
	);
}
