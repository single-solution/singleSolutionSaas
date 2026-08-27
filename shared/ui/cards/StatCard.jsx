import React from 'react';
import { IconTrendingUp } from '../icons/IconTrendingUp';

export function StatCard({ label, title, value, change, trend, icon: Icon }) {
	const displayLabel = label || title;
	const displayTrend = trend || change;

	return (
		<div className="p-5 rounded-2xl bg-white border border-slate-200/80 shadow-xs hover:shadow-md hover:border-indigo-200/80 hover:-translate-y-0.5 transition-all duration-200 space-y-2">
			<div className="flex items-center justify-between text-slate-400">
				<span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">{displayLabel}</span>
				{Icon && (React.isValidElement(Icon) ? Icon : <Icon size={16} className="text-slate-400" />)}
			</div>
			<div className="text-2xl font-extrabold text-slate-900 tracking-tight">{value}</div>
			{displayTrend && (
				<div className="text-xs font-semibold text-emerald-600 flex items-center gap-1">
					<IconTrendingUp size={12} />
					<span>{displayTrend}</span>
				</div>
			)}
		</div>
	);
}
