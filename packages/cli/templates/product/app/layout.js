import { Bricolage_Grotesque, Figtree } from 'next/font/google';
import { ThemeScript } from '@ss/ui';
import { TEXTS } from './dashboard/texts.js';
import './globals.css';

/** The interface typefaces (served with the app, no outside request): text and headings/figures (`@ss/ui` theme). */
const text = Figtree({ subsets: ['latin'], variable: '--ss-font-text', display: 'swap' });
const display = Bricolage_Grotesque({ subsets: ['latin'], variable: '--ss-font-display', display: 'swap' });

export const metadata = { title: TEXTS.title, robots: { index: false, follow: false } };
export const viewport = { width: 'device-width', initialScale: 1, colorScheme: 'light dark' };

/**
 * Root layout of the dashboard (light and dark, following the device unless the theme switch stored a choice).
 * @param {{ children: import('react').ReactNode }} props
 */
export default function RootLayout({ children }) {
	return (
		<html lang="en" className={`${text.variable} ${display.variable}`} suppressHydrationWarning>
			<head>
				<ThemeScript />
			</head>
			<body className="min-h-screen bg-canvas font-sans text-fg antialiased">{children}</body>
		</html>
	);
}
