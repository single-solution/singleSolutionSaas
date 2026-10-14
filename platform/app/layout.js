import { Bricolage_Grotesque, Figtree } from 'next/font/google';
import { headers } from 'next/headers.js';
import { ThemeScript } from '@ss/ui';
import './globals.css';

/** The interface typefaces (served with the app, no outside request): text and headings/figures (`@ss/ui` theme). */
const text = Figtree({ subsets: ['latin'], variable: '--ss-font-text', display: 'swap' });
const display = Bricolage_Grotesque({ subsets: ['latin'], variable: '--ss-font-display', display: 'swap' });

export const metadata = {
	title: { default: 'Single Solution', template: '%s · Single Solution' },
	description: 'Merchants, websites, products on websites and credits.',
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
		<html lang="en-US" className={`${text.variable} ${display.variable}`} suppressHydrationWarning>
			<head>
				<ThemeScript nonce={nonce} />
			</head>
			<body className="min-h-screen bg-canvas font-sans text-fg antialiased">{children}</body>
		</html>
	);
}
