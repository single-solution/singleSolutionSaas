'use client';

import React from 'react';
import './globals.css';
import { AppAuthGuard } from '@saas/ui/auth/AppAuthGuard';
import { StorefrontProvider } from '../src/context/StorefrontContext';

export default function RootLayout({ children }) {
	return (
		<html lang="en" suppressHydrationWarning>
			<body className="bg-slate-50 text-slate-900 antialiased min-h-screen" suppressHydrationWarning>
				<AppAuthGuard productId="analytics" appName="Analytics Pro">
					<StorefrontProvider>{children}</StorefrontProvider>
				</AppAuthGuard>
			</body>
		</html>
	);
}
