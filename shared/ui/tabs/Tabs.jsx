import React from 'react';

export function Tabs({ tabs, activeTab, onChange, className = '' }) {
	return (
		<div className={`flex gap-1 bg-zinc-100/80 p-1 rounded-xl border border-zinc-200/60 ${className}`}>
			{tabs.map((tab) => (
				<button
					key={tab.id}
					type="button"
					onClick={() => onChange && onChange(tab.id)}
					className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
						activeTab === tab.id ? 'bg-white text-zinc-950 shadow-xs' : 'text-zinc-500 hover:text-zinc-900'
					}`}>
					{tab.label}
				</button>
			))}
		</div>
	);
}

export const PillTabs = Tabs;
