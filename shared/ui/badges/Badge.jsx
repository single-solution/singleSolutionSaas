import React from 'react';

export function Badge({ children, type, variant = 'neutral', className = '' }) {
	const badgeKey = type || variant;
	const styles = {
		active: 'bg-emerald-50 text-emerald-700 border-emerald-200',
		success: 'bg-emerald-50 text-emerald-700 border-emerald-200',
		pro: 'bg-indigo-50 text-indigo-700 border-indigo-200',
		info: 'bg-sky-50 text-sky-700 border-sky-200',
		warning: 'bg-amber-50 text-amber-700 border-amber-200',
		danger: 'bg-rose-50 text-rose-700 border-rose-200',
		suspended: 'bg-rose-50 text-rose-700 border-rose-200',
		neutral: 'bg-zinc-100 text-zinc-700 border-zinc-200',
	};
	return (
		<span
			className={`inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider border ${styles[badgeKey] || styles.neutral} ${className}`}>
			{children}
		</span>
	);
}

export const ModernBadge = Badge;
