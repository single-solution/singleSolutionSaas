import React from 'react';

export function Footer({
	brandText = 'SingleSolution SaaS Control Engine',
	statusText = 'Operational',
	versionText = 'v3.2 Production',
	middleContent,
	children,
}) {
	return (
		<footer className="w-full rounded-2xl bg-white border border-slate-200/80 shadow-xs px-5 py-3.5 flex flex-wrap items-center justify-between gap-4 text-xs text-slate-500 transition-all duration-200">
			<div className="flex items-center gap-3">
				<span className="font-bold text-slate-800">{brandText}</span>
				{middleContent && (
					<>
						<span>•</span>
						{middleContent}
					</>
				)}
			</div>

			{children}

			<div className="flex items-center gap-5">
				<div className="flex items-center gap-1.5 text-emerald-700 font-medium">
					<span className="w-2 h-2 rounded-full bg-emerald-500" />
					<span>{statusText}</span>
				</div>
				<span className="text-slate-400">{versionText}</span>
			</div>
		</footer>
	);
}

export const FloatingFooter = Footer;
export const FloatingFooterIsland = Footer;
