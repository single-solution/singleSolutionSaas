import { headers } from 'next/headers.js';
import { ThemeScript } from '@ss/ui';
import './globals.css';

export const metadata = {
	title: { default: 'Single Solution', template: '%s · Single Solution' },
	description: 'Control plane for websites, elements, subscriptions and credits.',
	robots: { index: false, follow: false },
};

export const viewport = { width: 'device-width', initialScale: 1, colorScheme: 'light dark' };

/**
 * Root layout. The theme follows the OS unless the console's theme switch stored a choice: `ThemeScript` applies it
 * before paint, with the per-request CSP nonce issued by proxy.js.
 * @param {{ children: import('react').ReactNode }} props
 */
export default async function RootLayout({ children }) {
	const nonce = (await headers()).get('x-nonce');
	return (
		<html lang="en" suppressHydrationWarning>
			<head>
				<ThemeScript nonce={nonce} />
			</head>
			<body className="min-h-screen bg-canvas font-sans text-fg antialiased">{children}</body>
		</html>
	);
}
