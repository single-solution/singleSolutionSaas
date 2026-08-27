import React from 'react';

export function StatusChip({ status = 'online', label, className = '' }) {
	const isOnline = status === 'online' || status === 'active' || status === 'operational';
	return (
		<div
			className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-xs font-semibold border ${
				isOnline ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-zinc-100 border-zinc-200 text-zinc-600'
			} ${className}`}>
			<span className={`w-1.5 h-1.5 rounded-full ${isOnline ? 'bg-emerald-500' : 'bg-zinc-400'}`} />
			<span>{label || (isOnline ? 'Operational' : 'Inactive')}</span>
		</div>
	);
}
