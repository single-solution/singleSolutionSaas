import { Figtree, JetBrains_Mono, Space_Grotesk } from 'next/font/google';
import { ThemeScript } from '@ss/ui';
import { TEXTS } from './dashboard/texts.js';
import './globals.css';

/** Unite faces for product dashboards (`@ss/ui` theme): text, display, mono. */
const text = Figtree({ subsets: ['latin'], variable: '--ss-font-text', display: 'swap' });
const display = Space_Grotesk({
	subsets: ['latin'],
	variable: '--ss-font-display',
	display: 'swap',
	weight: ['500', '600', '700'],
});
const mono = JetBrains_Mono({
	subsets: ['latin'],
	variable: '--ss-font-mono',
	display: 'swap',
	weight: ['400', '500', '600'],
});

export const metadata = { title: TEXTS.title, robots: { index: false, follow: false } };
export const viewport = { width: 'device-width', initialScale: 1, colorScheme: 'light dark' };

/**
 * Root layout of the dashboard (light and dark, following the device unless the theme switch stored a choice).
 * @param {{ children: import('react').ReactNode }} props
 */
export default function RootLayout({ children }) {
	return (
		<html lang="en" className={`${text.variable} ${display.variable} ${mono.variable}`} suppressHydrationWarning>
			<head>
				<ThemeScript />
			</head>
			<body className="min-h-screen bg-canvas font-sans text-fg antialiased">{children}</body>
		</html>
	);
}
