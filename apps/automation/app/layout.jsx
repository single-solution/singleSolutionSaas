'use client';

import React from 'react';
import './globals.css';
import { AppAuthGuard } from '@saas/ui/auth/AppAuthGuard';

export default function RootLayout({ children }) {
	return (
		<html lang="en" suppressHydrationWarning>
			<body className="bg-slate-50 text-slate-900 antialiased min-h-screen" suppressHydrationWarning>
				<AppAuthGuard productId="automation" appName="Workflow Automation Engine">
					{children}
				</AppAuthGuard>
			</body>
		</html>
	);
}
