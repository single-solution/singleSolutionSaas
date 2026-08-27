import React from 'react';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { Footer } from './Footer';
import { IconZap } from '../icons/IconZap';

export function AppLayout({
	appName = 'SaaS Platform',
	appSubtitle = 'Console',
	appIcon = <IconZap size={18} />,
	navigation = [],
	navSections = [],
	headerLeft,
	headerRight,
	headerActions,
	footerMiddle,
	footerText,
	footerLink,
	children,
}) {
	return (
		<div className="min-h-screen bg-slate-50/70 p-3 md:p-4 gap-4 flex flex-col md:flex-row antialiased text-slate-900 font-sans">
			{/* 1. Sidebar */}
			<Sidebar
				title={appName}
				subtitle={appSubtitle}
				icon={appIcon}
				navigation={navigation}
				navSections={navSections}
				footerLink={footerLink}
			/>

			{/* 2. Main Content Canvas */}
			<div className="flex-1 flex flex-col min-w-0 gap-4">
				{/* Header */}
				<Header
					leftContent={headerLeft || <div className="font-bold text-sm text-slate-900">{appName} Workspace</div>}
					rightContent={headerRight || headerActions}
				/>

				{/* Main Canvas */}
				<main className="flex-1 w-full rounded-2xl bg-white border border-slate-200/80 shadow-xs p-6 space-y-6 transition-all duration-200">
					{children}
				</main>

				{/* Footer */}
				<Footer brandText={appName} middleContent={footerMiddle} statusText={footerText || 'All Systems Operational'} />
			</div>
		</div>
	);
}

export const FloatingLayout = AppLayout;
