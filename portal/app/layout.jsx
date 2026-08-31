'use client';

import React from 'react';
import './globals.css';
import { PortalProvider } from '../context/PortalContext';

export default function RootLayout({ children }) {
	return (
		<html lang="en" suppressHydrationWarning>
			<body className="bg-slate-50/70 text-slate-900 antialiased min-h-screen font-sans" suppressHydrationWarning>
				<PortalProvider>{children}</PortalProvider>
			</body>
		</html>
	);
}
