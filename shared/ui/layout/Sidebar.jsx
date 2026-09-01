'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { IconZap } from '../icons/IconZap';
import { IconArrowRight } from '../icons/IconArrowRight';

export function Sidebar({
	title = 'SaaS Platform',
	subtitle = 'Workspace',
	icon = <IconZap size={18} />,
	navigation = [],
	navSections = [],
	footerLink = null,
}) {
	const pathname = usePathname() || '/';

	const sections =
		navSections.length > 0
			? navSections
			: Array.isArray(navigation) && navigation.length > 0 && navigation[0].items
				? navigation
				: [{ label: 'Navigation', items: navigation }];

	const renderIcon = (i) => {
		if (!i) return null;
		if (React.isValidElement(i)) return i;
		const IconComp = i;
		return <IconComp size={15} />;
	};

	return (
		<aside className="w-full md:w-64 shrink-0 rounded-2xl bg-white border border-slate-200/80 shadow-xs p-4 flex flex-col justify-between md:sticky md:top-4 md:h-[calc(100vh-2rem)] transition-all duration-200">
			<div className="space-y-6">
				{/* Brand Tile */}
				<div className="flex items-center gap-3 px-2 py-1">
					<div className="w-9 h-9 rounded-xl bg-indigo-600 text-white flex items-center justify-center font-bold text-sm shadow-xs transition-transform duration-200 hover:scale-105">
						{renderIcon(icon)}
					</div>
					<div>
						<div className="font-extrabold text-sm text-slate-900 tracking-tight leading-none">{title}</div>
						<span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{subtitle}</span>
					</div>
				</div>

				{/* Navigation Section */}
				<nav className="space-y-4">
					{sections.map((sec, si) => (
						<div key={si} className="space-y-1">
							{sec.label && (
								<div className="text-[10px] font-extrabold uppercase tracking-wider text-slate-400 px-3 mb-1.5">
									{sec.label}
								</div>
							)}
							{sec.items?.map((item, ii) => {
								const target = item.to || item.href || item.path || '/';
								const isActive =
									target === '/' ? pathname === '/' : pathname === target || pathname.startsWith(target + '/');

								return (
									<Link
										key={target || ii}
										href={target}
										className={`flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-semibold transition-all duration-150 ${
											isActive
												? 'bg-indigo-50 text-indigo-700 font-semibold shadow-2xs'
												: 'text-slate-600 hover:text-slate-900 hover:bg-slate-100/80'
										}`}>
										{renderIcon(item.icon)}
										<span>{item.label || item.name}</span>
									</Link>
								);
							})}
						</div>
					))}
				</nav>
			</div>

			{/* Footer link */}
			{footerLink && (
				<div className="p-3 rounded-xl bg-slate-50 border border-slate-200/80 space-y-2 text-xs transition-all duration-150 hover:bg-slate-100/60">
					{footerLink.to.startsWith('http') ? (
						<a
							href={footerLink.to}
							className="flex items-center justify-between text-xs font-semibold text-slate-800 hover:text-indigo-600 transition-colors">
							<span>{footerLink.label}</span>
							<IconArrowRight size={13} />
						</a>
					) : (
						<Link
							href={footerLink.to}
							className="flex items-center justify-between text-xs font-semibold text-slate-800 hover:text-indigo-600 transition-colors">
							<span>{footerLink.label}</span>
							<IconArrowRight size={13} />
						</Link>
					)}
				</div>
			)}
		</aside>
	);
}

export const FloatingSidebar = Sidebar;
export const FloatingSidebarIsland = Sidebar;
